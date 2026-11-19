# Circuit agent (not started)

The final version of the strategy as a Circuit agent. It reuses `@kdn/core` and `@kdn/katana`
and only adds Circuit-specific connectors:

- `StateStore` backed by `agent.memory`
- `SignTypedData` signer backed by `wallet.messages.sign` (passed to the Katana Perps SDK)
- transaction executor backed by `wallet.transactions.create`
- `circuit.toml` with vbUSDC on `ethereum:747474`, continuous mode

Blocked on: confirming Circuit's hosted runtime allows outbound HTTPS to the Katana Perps API.
Start once the self-hosted pilots have run long enough to trust the strategy.
