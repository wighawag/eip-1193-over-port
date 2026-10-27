# @eip-1193/over-port

## 0.2.1

### Patch Changes

- 418a063: Package metadata: the issue tracker URL (`bugs`).

## 0.2.0

### Minor Changes

- bbfd837: Type `providerOverPort(port)` as `EIP1193CoreProvider` instead of `EIP1193ProviderWithoutEvents`, and make it generic over the method table.

  The port forwards whatever method arrives to the provider given to `serveProvider` on the far end, which may be a JSON-RPC node with no `wallet_*` at all. Since eip-1193 0.7.0, `EIP1193ProviderWithoutEvents` is the browser wallet surface, so the old type promised methods the far end may not serve. `ProviderOverPort<T extends RPCMethods = CoreMethods>` now defaults to `CoreMethods` (eip-1193 0.7.1 and later), the methods a wallet, a node and a plain HTTP node all serve.

  Breaking: the returned type narrows. Code that called `wallet_*` or `eth_subscribe`/`eth_unsubscribe` through it no longer compiles. Name the table the far end serves, for example `providerOverPort<WalletMethods>(port)` or `providerOverPort<NodeMethods>(port)`, or cast. `serveProvider` still accepts any provider.

  `eip-1193` is required at `^0.7.2`. Tests are now typechecked (`typecheck` script, run by `test` and by the release gate).

## 0.1.0

### Minor Changes

- 61a7c6e: First release: `serveProvider(provider, port)` serves an EIP-1193 provider's `request` on a `MessagePort`, and `providerOverPort(port)` turns the other end back into a provider, with errors keeping their `code`, `data` and `cause` chain.
