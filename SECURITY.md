# OPEN WALLET – On-chain transaction security

This version is designed so the backend does not create an internal/dummy wallet balance.

## Rules enforced by the backend

- Wallet private keys, seed phrases and mnemonics are never accepted or stored.
- Wallet balances are read from the configured blockchain RPC/API.
- `/api/transaction/verify` independently verifies a transaction on-chain.
- EVM transactions require a successful receipt and the configured confirmation count.
- EVM USDT is accepted only from the server-side allow-listed contract for that network and the ERC-20 `Transfer` event is checked.
- TRON USDT is accepted only from the configured TRC20 USDT contract and its `Transfer` event is checked.
- Solana USDT is accepted only from the configured official Tether mint.
- Bitcoin verification checks the actual confirmed transaction outputs/inputs.
- Failed, missing or insufficiently confirmed transactions are not verified.
- Transactions below the `$0.10 USD` minimum are rejected for credit eligibility.
- The transaction verification collection is an audit ledger only; it does not mint, increment or fabricate balances.

## Endpoint

`POST /api/transaction/verify`

Body:

```json
{
  "telegramId": "...",
  "initData": "...",
  "txHash": "...",
  "chain": "TRON",
  "asset": "USDT",
  "direction": "in",
  "expectedAmount": "0.10"
}
```

For an outgoing transaction, also send:

```json
{
  "direction": "out",
  "expectedRecipient": "..."
}
```

The server ignores any client-supplied token contract. Token contracts are selected only from the backend allow-list.

## Frontend integration

After the wallet broadcasts a transaction, call `/api/transaction/verify` with the transaction hash. Treat the transaction as credited/successful only when the response contains:

- `success: true`
- `verified: true`
- `status: "verified"`

Do not add to a local balance from a client-provided amount. Refresh the wallet balance from `/api/wallet` after verification.

## Important

This backend does not itself sign or broadcast user transactions. Signing remains on the user's device. The verification endpoint is for independently checking the resulting blockchain transaction.
