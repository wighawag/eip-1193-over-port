/**
 * Type tests. The assertions are checked by `tsc -p tsconfig.test.json` (the `typecheck` script,
 * which `test` runs first); vitest only runs the file so it is not silently skipped. Values are
 * `undefined as unknown as T` placeholders: a `declare const` would throw a ReferenceError when
 * vitest executes the file. No request is ever sent: every call sits in a function that is never
 * invoked.
 */
import {describe, expect, it} from 'vitest';
import type {
	EIP1193CoreProvider,
	EIP1193HttpNodeProvider,
	EIP1193NodeProvider,
	EIP1193WalletProvider,
	NodeMethods,
	WalletMethods,
} from 'eip-1193';
import {
	providerOverPort,
	serveProvider,
	type PortLike,
	type ProviderOverPort,
} from '../src/index.js';

const port = undefined as unknown as PortLike;

// Hoisted so each call fits on the one line a `@ts-expect-error` covers, whatever prettier does.
const switchChain = {
	method: 'wallet_switchEthereumChain',
	params: [{chainId: '0x1'}],
} as const;
const subscribeHeads = {method: 'eth_subscribe', params: ['newHeads']} as const;

describe('ProviderOverPort types', () => {
	it('defaults to the core surface every provider serves', () => {
		const remote = undefined as unknown as ProviderOverPort;
		const asCore: EIP1193CoreProvider = remote;
		// the etherfold pattern: the result goes straight into a slot typed as the core provider
		const fromFunction: () => EIP1193CoreProvider = () =>
			providerOverPort(port);
		const _annotated = (): void => {
			const slot: EIP1193CoreProvider = providerOverPort(port);
			void slot;
		};

		const _neverCalled = async () => {
			await remote.request({method: 'eth_blockNumber'});
			await remote.request({method: 'eth_chainId'});
			await remote.request({method: 'eth_accounts'});
			// @ts-expect-error a node or an HTTP node behind the port serves no wallet_*
			await remote.request(switchChain);
			// @ts-expect-error subscriptions are not core, and events do not cross the port
			await remote.request(subscribeHeads);
			// @ts-expect-error node introspection is not core
			await remote.request({method: 'net_listening'});
		};
		expect([asCore, fromFunction, _annotated, _neverCalled]).toHaveLength(4);
	});

	it('offers a wider table when the caller names it', () => {
		const _neverCalled = async () => {
			const wallet = providerOverPort<WalletMethods>(port);
			await wallet.request(switchChain);
			await wallet.request(subscribeHeads);
			const asWallet: EIP1193WalletProvider = wallet;
			wallet.close();

			const node = providerOverPort<NodeMethods>(port);
			await node.request({method: 'net_listening'});
			const asNode: EIP1193NodeProvider = node;
			// @ts-expect-error a node serves no wallet_*
			await node.request(switchChain);
			return [asWallet, asNode];
		};
		expect(_neverCalled).toBeTypeOf('function');
	});

	it('serves any kind of provider', () => {
		const _neverCalled = () => {
			serveProvider(undefined as unknown as EIP1193WalletProvider, port);
			serveProvider(undefined as unknown as EIP1193NodeProvider, port);
			serveProvider(undefined as unknown as EIP1193HttpNodeProvider, port);
			serveProvider(undefined as unknown as EIP1193CoreProvider, port);
			serveProvider(undefined as unknown as ProviderOverPort, port);
		};
		expect(_neverCalled).toBeTypeOf('function');
	});
});
