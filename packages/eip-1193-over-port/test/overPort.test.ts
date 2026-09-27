import {afterEach, describe, expect, it} from 'vitest';
import {
	providerOverPort,
	ProviderOverPortError,
	serveProvider,
	type RequestProvider,
} from '../src/index.js';

const channels: MessageChannel[] = [];
afterEach(() => {
	for (const channel of channels.splice(0)) {
		channel.port1.close();
		channel.port2.close();
	}
});

function aChannel(): MessageChannel {
	const channel = new MessageChannel();
	channels.push(channel);
	return channel;
}

function connected(provider: RequestProvider) {
	const {port1, port2} = aChannel();
	const served = serveProvider(provider, port1);
	const client = providerOverPort(port2);
	return {served, client};
}

/** A node refusal shaped like the ones real providers send: a code, a message and structured data. */
class RangeRefusal extends Error {
	readonly code = -32602;
	readonly data = {from: '0x10', to: '0x20', limit: 10000};
	constructor() {
		super('query returned more than 10000 results', {
			cause: Object.assign(new Error('inner'), {code: -32005}),
		});
		this.name = 'RangeRefusal';
	}
}

describe('a provider served on one end of a port', () => {
	it('answers a request made on the other end', async () => {
		const {client} = connected({
			request: async ({method}) => (method === 'eth_chainId' ? '0x1' : null),
		});
		expect(await client.request({method: 'eth_chainId'})).toBe('0x1');
	});

	it('passes the params through, and leaves them out when there are none', async () => {
		const seen: unknown[] = [];
		const {client} = connected({
			request: async (args) => {
				seen.push(args);
				return 'ok';
			},
		});
		await client.request({
			method: 'eth_getLogs',
			params: [{fromBlock: '0x1', toBlock: '0x2'}],
		});
		await client.request({method: 'eth_blockNumber'});
		expect(seen).toEqual([
			{method: 'eth_getLogs', params: [{fromBlock: '0x1', toBlock: '0x2'}]},
			{method: 'eth_blockNumber'},
		]);
	});

	it('keeps concurrent requests apart, whatever order they are answered in', async () => {
		const {client} = connected({
			request: ({params}) => {
				const [delay] = params as [number];
				return new Promise((resolve) =>
					setTimeout(() => resolve(delay), delay),
				);
			},
		});
		const answers = await Promise.all(
			[30, 10, 20].map((delay) =>
				client.request({method: 'eth_call', params: [delay]} as never),
			),
		);
		expect(answers).toEqual([30, 10, 20]);
	});

	it("rejects with the provider's code, message, name, data and cause chain", async () => {
		const {client} = connected({
			request: async () => {
				throw new RangeRefusal();
			},
		});
		const error = await client
			.request({method: 'eth_getLogs', params: [{}]} as never)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ProviderOverPortError);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: 'RangeRefusal',
			message: 'query returned more than 10000 results',
			code: -32602,
			data: {from: '0x10', to: '0x20', limit: 10000},
		});
		expect((error as Error).cause).toMatchObject({
			message: 'inner',
			code: -32005,
		});
	});

	it('reports a provider that throws synchronously, rather than hanging', async () => {
		const {client} = connected({
			request: () => {
				throw Object.assign(new Error('boom'), {code: 4200});
			},
		});
		await expect(client.request({method: 'eth_chainId'})).rejects.toMatchObject(
			{message: 'boom', code: 4200},
		);
	});

	it('carries data that cannot be cloned as its JSON form', async () => {
		const {client} = connected({
			request: async () => {
				throw Object.assign(new Error('with a function inside'), {
					code: -32000,
					data: {hint: 'x', toJSON: () => ({hint: 'x'})},
				});
			},
		});
		await expect(client.request({method: 'eth_chainId'})).rejects.toMatchObject(
			{data: {hint: 'x'}},
		);
	});

	it('answers with an error, never a hang, when the result cannot be cloned', async () => {
		const {client} = connected({
			request: async () => ({notCloneable: () => 1}),
		});
		await expect(client.request({method: 'eth_chainId'})).rejects.toMatchObject(
			{code: -32603},
		);
	});

	it('works across a TRANSFERRED port, as a worker receives one', async () => {
		const {port1, port2} = aChannel();
		serveProvider({request: async () => '0xabc'}, port1);
		const handOff = aChannel();
		const arrived = new Promise<MessagePort>((resolve) => {
			handOff.port2.onmessage = (event) => resolve(event.data as MessagePort);
		});
		handOff.port1.postMessage(port2, [port2]);
		const client = providerOverPort(await arrived);
		expect(await client.request({method: 'eth_blockNumber'})).toBe('0xabc');
		(await arrived).close();
	});

	it('ignores messages that are not its own on the same port', async () => {
		const {port1, port2} = aChannel();
		serveProvider({request: async () => 'answer'}, port1);
		const client = providerOverPort(port2);
		port1.postMessage({type: 'something-else', id: 0, result: 'wrong'});
		port1.postMessage('noise');
		expect(await client.request({method: 'eth_chainId'})).toBe('answer');
	});
});

describe('closing', () => {
	it('rejects the requests still waiting and every later one', async () => {
		const {client} = connected({request: () => new Promise(() => {})});
		const waiting = client.request({method: 'eth_chainId'});
		client.close();
		await expect(waiting).rejects.toMatchObject({code: 4900});
		await expect(client.request({method: 'eth_chainId'})).rejects.toMatchObject(
			{code: 4900},
		);
	});

	it('stops the server answering new requests', async () => {
		const {port1, port2} = aChannel();
		const served = serveProvider({request: async () => 'answer'}, port1);
		const client = providerOverPort(port2);
		expect(await client.request({method: 'eth_chainId'})).toBe('answer');
		served.close();
		const outcome = await Promise.race([
			client.request({method: 'eth_chainId'}).then(() => 'answered'),
			new Promise((resolve) => setTimeout(() => resolve('silent'), 50)),
		]);
		expect(outcome).toBe('silent');
		client.close();
	});
});
