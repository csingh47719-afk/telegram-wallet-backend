# OPEN WALLET Security Rules

- Non-custodial: private keys and seed phrases never enter the backend.
- Transaction verification is blockchain-derived, not client-balance-derived.
- Every verified transaction records TXID, network, direction, amount, sender/recipient, token contract (when applicable), confirmations, block and USD value.
- USDT verification uses server-side allow-listed contracts and on-chain Transfer events.
- Incoming external deposits have a $0.10 USD-equivalent minimum and no application maximum.
- Outgoing Send has a $0.10 USD-equivalent minimum and no application-layer maximum.
- Failed/reverted transactions are never credited as successful transactions.
- Network fee preparation is blocked until the recipient transfer is independently verified on-chain.
- Device/session tracking stores hashes for session identifiers and IPs, not raw IP hashes or secrets.
- New/untrusted sessions are blocked from sensitive Send/Swap until explicit device verification.
- Users can view active sessions and revoke other sessions.
- Wallet balances are refreshed from blockchain state after a verified deposit; the verification ledger does not mint or increment balances.
- A prepared transaction is not a completed transaction. Outgoing history should be saved only after the actual broadcast TXID is verified.

- Send network fee is fixed at 0.5% of the sent amount and is charged in the selected asset/network. This is separate from blockchain gas/network charges.
