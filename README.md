# OPEN WALLET — Secure Multi-Chain Wallet

Non-custodial Telegram WebApp/backend for public-address registration, blockchain-only balance reads, on-chain transaction verification, transaction history and device/session security.

## Verification
The backend independently verifies:
- TXID on the selected network/chain
- registered wallet address
- sender/recipient address where applicable
- token contract from the server-side allow-list
- token Transfer event / native transfer data
- confirmed amount and confirmations
- USD value of the verified amount

## Balance refresh
After a verified deposit the frontend refreshes the wallet by reading current on-chain balances and recalculates each coin's quantity, current USD value and total wallet USD value.

## Limits
- Minimum transaction value: $0.10 USD-equivalent.
- Outgoing Send maximum: $10,000 USD-equivalent.
- Incoming external deposits: unlimited maximum (the blockchain address can receive more than $10,000).

## Device/session security
A persistent client session identifier is created locally. The backend tracks active sessions, marks the first session trusted, treats later sessions as untrusted until explicit approval, and blocks sensitive Send/Swap on untrusted/expired sessions. Users can list and revoke sessions.

## History
Verified records retain TXID, network, direction, asset, amount, sender, recipient, token contract, confirmations, block number, USD value, fee details and verification status.
