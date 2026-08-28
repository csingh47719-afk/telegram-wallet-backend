# Security Notes

- The backend never generates, stores or receives private keys, seed phrases or mnemonics.
- Wallet registration accepts public addresses only.
- Balance values returned by `/api/wallet` are read from configured blockchains; there is no fake internal token balance ledger.
- ERC-20 balances are queried through Multicall3 and token contracts resolved from the allow-listed 137-token CoinGecko registry.
- ERC-20 Send preparation returns an unsigned transaction only. The user's wallet must sign and broadcast locally.
- The 5% platform fee is calculated from the gross send amount and is not released merely because a transaction was prepared.
- Use HTTPS for the deployed frontend/backend and set trusted RPC endpoints in production.
