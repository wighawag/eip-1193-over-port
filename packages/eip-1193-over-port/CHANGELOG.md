# @eip-1193/over-port

## 0.1.0

### Minor Changes

- 61a7c6e: First release: `serveProvider(provider, port)` serves an EIP-1193 provider's `request` on a `MessagePort`, and `providerOverPort(port)` turns the other end back into a provider, with errors keeping their `code`, `data` and `cause` chain.
