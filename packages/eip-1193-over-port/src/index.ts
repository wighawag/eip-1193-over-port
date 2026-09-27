/**
 * EIP-1193 `request` over a MessagePort.
 *
 * A provider is an object with methods, so it cannot be structured-cloned into a
 * worker. A `MessagePort` can be TRANSFERRED into one. So the thread that holds
 * the real provider serves it on one end of a `MessageChannel`
 * ({@link serveProvider}), and any other thread turns the other end back into a
 * provider ({@link providerOverPort}). Once the ports are handed over, requests
 * go straight between the two threads: a page that created the channel relays
 * nothing.
 *
 * Only `request` crosses. Provider EVENTS (`accountsChanged`, `chainChanged`,
 * subscriptions) do not: this is a transport for request/response callers.
 */
import type {
	EIP1193GenericRequest,
	EIP1193ProviderWithoutEvents,
} from 'eip-1193';

/**
 * The part of a `MessagePort` this package uses. A `MessagePort` (browser or
 * Node), a `Worker`, and a worker's global scope all satisfy it.
 */
export type PortLike = {
	postMessage(message: unknown): void;
	addEventListener(
		type: 'message',
		listener: (event: {data: unknown}) => void,
	): void;
	removeEventListener(
		type: 'message',
		listener: (event: {data: unknown}) => void,
	): void;
	/** Present on a `MessagePort`, which delivers nothing to `addEventListener` until it is started. */
	start?: () => void;
};

/** Anything with an EIP-1193 `request`, typed loosely: the server forwards whatever method arrives. */
export type RequestProvider = {
	request(args: EIP1193GenericRequest): Promise<unknown> | unknown;
};

const REQUEST = '@eip-1193/over-port/request';
const RESPONSE = '@eip-1193/over-port/response';

/** How deep an error's `cause` chain is carried across. Deeper causes are dropped. */
const MAX_CAUSE_DEPTH = 4;

/** An error as it crosses the port: plain, cloneable fields only. */
export type SerializedError = {
	name?: string;
	message: string;
	code?: number;
	data?: unknown;
	cause?: SerializedError;
};

type RequestMessage = {
	type: typeof REQUEST;
	id: number;
	method: string;
	params?: unknown;
};

type ResponseMessage = {type: typeof RESPONSE; id: number} & (
	| {result: unknown; error?: undefined}
	| {error: SerializedError; result?: undefined}
);

/** The error a request rejects with: an `Error` carrying the provider's `code` and `data`. */
export class ProviderOverPortError extends Error {
	readonly code?: number;
	readonly data?: unknown;
	constructor(serialized: SerializedError) {
		super(
			serialized.message,
			serialized.cause
				? {cause: new ProviderOverPortError(serialized.cause)}
				: undefined,
		);
		if (serialized.name) this.name = serialized.name;
		if (serialized.code !== undefined) this.code = serialized.code;
		if (serialized.data !== undefined) this.data = serialized.data;
	}
}

/** What {@link serveProvider} returns. */
export type ServedProvider = {
	/** Stops answering. Requests already in flight still get their answer. */
	close(): void;
};

/**
 * Serves `provider` on `port`: every request that arrives is passed to
 * `provider.request` and its result, or its error, is posted back.
 *
 * Errors keep `code`, `message`, `name`, `data` and their `cause` chain, so a
 * caller that reads a node's refusal from `error.data` (a suggested block range,
 * say) reads the same thing across the port. A `data` that cannot be cloned is
 * carried as its JSON form when it has one, and dropped otherwise.
 */
export function serveProvider(
	provider: RequestProvider,
	port: PortLike,
): ServedProvider {
	const listener = (event: {data: unknown}) => {
		const message = event.data;
		if (!isRequest(message)) return;
		const {id, method, params} = message;
		Promise.resolve()
			.then(() =>
				provider.request(
					params === undefined ? {method} : {method, params: params as never},
				),
			)
			.then(
				(result) => answer(port, {type: RESPONSE, id, result}),
				(error: unknown) =>
					answer(port, {type: RESPONSE, id, error: serializeError(error)}),
			);
	};
	port.addEventListener('message', listener);
	port.start?.();
	return {
		close() {
			port.removeEventListener('message', listener);
		},
	};
}

/** What {@link providerOverPort} returns: a provider, plus a way to let go of the port. */
export type ProviderOverPort = EIP1193ProviderWithoutEvents & {
	/**
	 * Stops listening, and rejects every request still waiting and every later
	 * one. Does not close the port itself, which the caller owns.
	 */
	close(): void;
};

/**
 * An EIP-1193 provider whose `request` is answered by whatever
 * {@link serveProvider} serves on the other end of `port`.
 */
export function providerOverPort(port: PortLike): ProviderOverPort {
	let nextId = 0;
	let closed = false;
	const pending = new Map<
		number,
		{resolve: (value: unknown) => void; reject: (reason: unknown) => void}
	>();

	const listener = (event: {data: unknown}) => {
		const message = event.data;
		if (!isResponse(message)) return;
		const waiting = pending.get(message.id);
		if (!waiting) return;
		pending.delete(message.id);
		if (message.error !== undefined)
			waiting.reject(new ProviderOverPortError(message.error));
		else waiting.resolve(message.result);
	};
	port.addEventListener('message', listener);
	port.start?.();

	const request = (args: EIP1193GenericRequest): Promise<unknown> => {
		if (closed) {
			return Promise.reject(
				new ProviderOverPortError({
					message: '@eip-1193/over-port: this provider was closed',
					code: 4900,
				}),
			);
		}
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, {resolve, reject});
			const message: RequestMessage = {type: REQUEST, id, method: args.method};
			if ('params' in args && args.params !== undefined)
				message.params = args.params;
			try {
				port.postMessage(message);
			} catch (error) {
				pending.delete(id);
				reject(
					new ProviderOverPortError({
						message: `@eip-1193/over-port: the request for ${args.method} could not be sent: ${messageOf(error)}`,
						code: -32602,
					}),
				);
			}
		});
	};

	const close = () => {
		if (closed) return;
		closed = true;
		port.removeEventListener('message', listener);
		for (const {reject} of pending.values()) {
			reject(
				new ProviderOverPortError({
					message: '@eip-1193/over-port: this provider was closed',
					code: 4900,
				}),
			);
		}
		pending.clear();
	};

	return {request, close} as unknown as ProviderOverPort;
}

function answer(port: PortLike, response: ResponseMessage): void {
	try {
		port.postMessage(response);
	} catch (error) {
		// the RESULT could not be cloned; the caller still gets an answer, never a hang
		port.postMessage({
			type: RESPONSE,
			id: response.id,
			error: {
				message: `@eip-1193/over-port: the provider's answer could not be sent across the port: ${messageOf(error)}`,
				code: -32603,
			},
		} satisfies ResponseMessage);
	}
}

/** Reduces anything thrown to the plain fields that cross a port. */
export function serializeError(error: unknown, depth = 0): SerializedError {
	if (typeof error !== 'object' || error === null)
		return {message: String(error)};
	const source = error as {
		name?: unknown;
		message?: unknown;
		code?: unknown;
		data?: unknown;
		cause?: unknown;
	};
	const serialized: SerializedError = {
		message:
			typeof source.message === 'string' ? source.message : String(error),
	};
	if (typeof source.name === 'string') serialized.name = source.name;
	if (typeof source.code === 'number') serialized.code = source.code;
	if (source.data !== undefined) {
		const data = cloneable(source.data);
		if (data !== undefined) serialized.data = data;
	}
	if (source.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
		serialized.cause = serializeError(source.cause, depth + 1);
	}
	return serialized;
}

function cloneable(value: unknown): unknown {
	try {
		return structuredClone(value);
	} catch {
		try {
			const json = JSON.stringify(value);
			return json === undefined ? undefined : JSON.parse(json);
		} catch {
			return undefined;
		}
	}
}

function isRequest(message: unknown): message is RequestMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as {type?: unknown}).type === REQUEST &&
		typeof (message as {id?: unknown}).id === 'number' &&
		typeof (message as {method?: unknown}).method === 'string'
	);
}

function isResponse(message: unknown): message is ResponseMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as {type?: unknown}).type === RESPONSE &&
		typeof (message as {id?: unknown}).id === 'number'
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
