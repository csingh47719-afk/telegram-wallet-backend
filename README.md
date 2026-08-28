# OPEN Coin — 24H Mining + TON foundation

यह project आपके बताए architecture के अनुसार है:

**START MINING → 24 घंटे mining → server/database reward → successful referral +10% → verified 0.01 TON deposit +10% → बाद में OPEN Jetton launch → फिर real Send/Receive/Swap.**

## Mining rules

- Wallet connect और TON Proof verification के बाद ही mining शुरू होगी।
- `START 24H MINING` एक बार दबाने पर 24 घंटे का mining cycle शुरू होता है।
- Base speed: **0.001 OPEN/hour**.
- 24 घंटे पूरे होने पर अगला cycle फिर शुरू किया जा सकता है।
- Successful referral का अर्थ सिर्फ share नहीं है: referred wallet को पहली बार mining शुरू करनी होगी; तभी referrer को **+10%** मिलता है।
- Verified treasury deposit **0.01 TON** होने पर उस wallet को एक बार **+10%** mining speed मिलता है।
- Coin पर tap करने से कोई fake reward नहीं मिलता।
- Balance, mining time, referral और deposit bonus server/database controlled हैं।

## अभी क्या real है

- TON Connect wallet connection foundation
- TON Proof based server authentication
- Server-side 24h mining accounting
- Referral attribution and successful-referral bonus
- Blockchain-verified TON deposit flow (treasury + invoice payload + amount + tx hash)

## अभी क्या intentionally disabled है

OPEN Jetton अभी deploy नहीं हुआ है, इसलिए **Send OPEN** और **Swap** को fake transaction के रूप में नहीं बनाया गया है। Jetton Master Address मिलने के बाद ही real Jetton balance/send/receive और configured DEX/router swap जोड़ा जाना चाहिए।

## Production setup

1. HTTPS domain पर deploy करें।
2. `tonconnect-manifest.json` में `YOUR-DOMAIN` को अपने वास्तविक domain से बदलें।
3. `.env.example` को `.env` में copy करें।
4. `PUBLIC_BASE_URL` को exact HTTPS origin रखें।
5. `DEPOSIT_ADDRESS` में अपना treasury wallet address डालें।
6. TON Center API key configure करें।
7. `npm install` और `npm start` चलाएँ।

## Important security note

Seed phrase/private key कभी server, HTML, database या `.env` में न रखें। Deposit credit केवल server-side blockchain verification से होना चाहिए। Browser/localStorage को balance का source of truth न बनाएं।

## Environment

See `.env.example`. `JWT_SECRET` अभी legacy placeholder है; authentication इस build में HttpOnly server session cookie से होती है।
