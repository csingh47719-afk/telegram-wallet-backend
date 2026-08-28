# OPEN WALLET — 137+ Live Assets v6

This build extends the v5 wallet with a server-side token registry and real EVM ERC-20 balance scanning for the 137 configured CoinGecko assets.

## Included
- 137-token CoinGecko price list with 30-second client refresh.
- CoinGecko platform registry resolves public contract addresses for Ethereum, Optimism, Arbitrum, Base, TRON and Solana when CoinGecko provides them.
- EVM ERC-20 balances are read directly from chain using Multicall3; balances are never stored as an internal ledger.
- Main wallet totals include verified native balances plus discovered ERC-20 balances.
- Token tap opens Send/Receive actions.
- Receive shows the correct public wallet address for the selected network and a QR code.
- Send calculates a 5% platform fee and recipient amount live.
- EVM ERC-20 Send preparation returns an unsigned `transfer()` transaction; signing/broadcasting remains on the user's device.
- Swipe token picker and 137-token swap selectors remain enabled.
- Private keys, seed phrases and mnemonics are rejected by wallet registration and are never required by the backend.

## Important scope
A single EVM address can hold ERC-20 tokens on Ethereum-compatible networks, but native coins on independent networks (for example XRP, ADA, LTC, DOGE, TON, SUI, etc.) require their own chain RPC/indexer and transaction builder. This build does not pretend those balances are zero because they are unsupported; it reports only balances that the configured chain adapters can actually verify.

Before production use, configure reliable RPC endpoints and fee-recipient public addresses in environment variables. Never put a private key or seed phrase in the server environment.
