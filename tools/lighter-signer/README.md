# Lighter signer bridge

This directory contains the Go signer executable used by the Node service. It
adapts the project protocol:

```bash
./bin/lighter-signer sign
```

stdin:

```json
{
  "apiPrivateKey": "...",
  "baseURL": "https://mainnet.zklighter.elliot.ai",
  "accountIndex": 123,
  "apiKeyIndex": 2,
  "intent": {
    "action": "place_order",
    "nonce": "42",
    "payload": {
      "market_index": 1,
      "client_order_index": "1001",
      "base_amount": "1000",
      "price": "6500000",
      "is_ask": false,
      "order_type": "limit",
      "reduce_only": false
    }
  }
}
```

stdout:

```json
{
  "txType": 14,
  "txInfo": "...",
  "txInfoHash": "..."
}
```

## Build

Build the host binary used by the service:

```bash
./tools/lighter-signer/build.sh
```

The build script writes `./bin/lighter-signer`.

Build common release targets:

```bash
./tools/lighter-signer/build.sh all
```

The cross-platform outputs are written to `./bin/lighter-signer-dist/`.
One binary cannot run on every operating system; Go produces one native binary
per `GOOS/GOARCH` target.

## Notes

- This wrapper depends on the official `github.com/elliottech/lighter-go`
  module and builds with `CGO_ENABLED=0`.
- `apiPrivateKey` must be a hex string that decodes to 40 bytes.
- Mainnet URLs use Lighter chain id `304`; other URLs use `300`.
- `cancel_order` currently maps the configured order id to Lighter's order
  index field. Confirm this against live order data before relying on cancel
  in production.
