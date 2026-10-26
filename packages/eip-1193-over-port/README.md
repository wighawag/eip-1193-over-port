# @eip-1193/over-port

EIP-1193 `request` over a `MessagePort`: serve a provider on one thread, and use it from another.

A provider is an object with methods, so it cannot be structured-cloned into a Web Worker. A `MessagePort` can be transferred into one. So the thread that holds the real provider serves it on one end of a `MessageChannel`, and any other thread turns the other end back into a provider. Once the ports are handed over, requests go straight between those two threads: the page that created the channel relays nothing.

```sh
pnpm add @eip-1193/over-port
```

## Usage

```ts
import {serveProvider, providerOverPort} from '@eip-1193/over-port';

// wherever the real provider lives (the page for a wallet, or a worker running a node)
serveProvider(provider, port1);

// wherever it is needed (a worker running an indexer, say)
const remote = providerOverPort(port2);
await remote.request({method: 'eth_blockNumber'});
```

### Two workers talking to each other

The page creates the channel and hands one end to each worker; after that it is out of the loop.

```ts
// page
const {port1, port2} = new MessageChannel();
nodeWorker.postMessage({provide: port1}, [port1]);
indexerWorker.postMessage({provider: port2}, [port2]);

// node worker
self.addEventListener('message', (event) => {
	if (event.data?.provide) serveProvider(node, event.data.provide);
});

// indexer worker
self.addEventListener('message', (event) => {
	if (event.data?.provider) startIndexing(providerOverPort(event.data.provider));
});
```

### A wallet, used from a worker

The page serves the wallet's provider and the worker uses it. Every request then passes through the page, but only as a message: the work stays in the worker.

```ts
// page
const {port1, port2} = new MessageChannel();
serveProvider(window.ethereum, port1);
worker.postMessage({provider: port2}, [port2]);
```

## Typing

The port forwards any `{method, params}`, so what the remote provider can serve depends on what was handed to `serveProvider` on the far end, which this side cannot see. `providerOverPort(port)` is therefore typed as an `EIP1193CoreProvider` (from [`eip-1193`](https://www.npmjs.com/package/eip-1193)): the methods a browser wallet, a JSON-RPC node and a plain HTTP node all serve. It offers no `wallet_*`, no node introspection and no subscriptions.

When you know what the far end serves, name its method table. This is an unchecked claim, like a cast. The tables come from `eip-1193`, so add it as a direct dependency to import them (`pnpm add -D eip-1193`):

```ts
import type {WalletMethods, NodeMethods} from 'eip-1193';

const wallet = providerOverPort<WalletMethods>(port); // wallet_switchEthereumChain and so on
const node = providerOverPort<NodeMethods>(port); // the core methods plus the node extras (net_*, eth_subscribe, ...)
```

`serveProvider` accepts any provider with a `request`, whatever its method table.

## What crosses, and what does not

- **Only `request` crosses.** Provider events (`accountsChanged`, `chainChanged`, subscriptions) do not: this is a transport for request/response callers, such as an indexer or a read-only client.
- **Errors keep their shape.** A rejection is a `ProviderOverPortError` (an `Error`) carrying the provider's `code`, `message`, `name`, `data` and its `cause` chain (up to four levels). So a caller that reads a node's refusal from `error.data` (a suggested block range, say) reads the same thing across the port. A `data` that cannot be cloned is carried as its JSON form when it has one, and dropped otherwise.
- **Nothing hangs.** A provider that throws synchronously, or whose answer cannot be cloned, still answers: the second case rejects with code `-32603`.
- **Closing.** `serveProvider(...).close()` stops answering. `providerOverPort(...).close()` rejects every request still waiting and every later one, with code `4900`. Neither closes the port, which belongs to the caller.
- **Sharing a port.** Messages this package did not send are ignored, so a port can carry other traffic too.

`PortLike` is the part of a `MessagePort` used here (`postMessage`, `addEventListener`, `removeEventListener`, and `start` when present), so a `Worker` or a worker's global scope works as well as a `MessagePort`.

## License

MIT
