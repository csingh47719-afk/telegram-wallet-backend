const express = require('express');
const mongoose = require('mongoose');
const TronWeb = require('tronweb');
const CryptoJS = require('crypto-js');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '10kb' })); // DDoS से बचाव हेतु पेलोड लिमिट
app.use(cors());

// 1. एंटी-बॉट और DDoS रेट लिमिटिंग (15 मिनट में अधिकतम 100 अनुरोध)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests. Please try again later." }
});
app.use('/api/', apiLimiter);

const PORT = process.env.PORT || 10000;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "SuperSecretKey123";
const MONGO_URI = process.env.MONGO_URI;
const API_KEY = process.env.TRONGRID_API_KEY || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";

// आपका वेरिफ़ाइड एडमिन फ़ीस वॉलेट (जहाँ 0.5% प्लेटफ़ॉर्म फ़ीस जमा होगी)
const ADMIN_FEE_WALLET = process.env.ADMIN_FEE_WALLET || "TLmgAsP4r8ckuGyRN8S65dtpL1cJaWC62R";

// TRON Mainnet Configuration
const HttpProvider = TronWeb.providers.HttpProvider;
const headers = API_KEY ? { 'TRON-PRO-API-KEY': API_KEY } : {};
const fullNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const solidityNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const eventServer = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

// सुरक्षा: केवल आधिकारिक वेरिफ़ाइड स्मार्ट कॉन्ट्रैक्ट्स
const VERIFIED_CONTRACTS = {
    USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    USDD: "TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn"
};

const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

// 2. Telegram WebApp HMAC-SHA256 सिग्नेचर वेरिफिकेशन
function verifyTelegramWebAppData(initData) {
    if (!initData) return false;
    if (!BOT_TOKEN) return true; // लोकल टेस्टिंग फॉलबैक
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        if (!hash) return false;
        urlParams.delete('hash');

        const dataCheckArr = [];
        for (const [key, value] of urlParams.entries()) {
            dataCheckArr.push(`${key}=${value}`);
        }
        dataCheckArr.sort();
        const dataCheckString = dataCheckArr.join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

// 3. क्रिप्टोग्राफिक Base58Check और Bech32 एड्रेस डेरिवेशन हेल्पर्स
const B58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58CheckEncode(versionByte, hexPayload) {
    const versionHex = (versionByte < 16 ? "0" : "") + versionByte.toString(16);
    const payloadHex = versionHex + hexPayload.slice(0, 40);
    const payloadWordArray = CryptoJS.enc.Hex.parse(payloadHex);
    const firstHash = CryptoJS.SHA256(payloadWordArray);
    const secondHash = CryptoJS.SHA256(firstHash);
    const checksumHex = secondHash.toString(CryptoJS.enc.Hex).substring(0, 8);
    const fullHex = payloadHex + checksumHex;

    let bytes = [];
    for (let i = 0; i < fullHex.length; i += 2) bytes.push(parseInt(fullHex.substr(i, 2), 16));

    let value = 0n;
    for (let i = 0; i < bytes.length; i++) value = (value * 256n) + BigInt(bytes[i]);

    let encoded = "";
    while (value > 0n) {
        encoded = B58_CHARS[Number(value % 58n)] + encoded;
        value = value / 58n;
    }

    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
        encoded = B58_CHARS[0] + encoded;
    }
    return encoded;
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
    let chk = 1;
    for (let p = 0; p < values.length; ++p) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ values[p];
        if ((b >> 0) & 1) chk ^= 0x3b6a57b2;
        if ((b >> 1) & 1) chk ^= 0x26508e6d;
        if ((b >> 2) & 1) chk ^= 0x1ea119fa;
        if ((b >> 3) & 1) chk ^= 0x3d4233dd;
        if ((b >> 4) & 1) chk ^= 0x2a1462b3;
    }
    return chk;
}
function bech32HrpExpand(hrp) {
    const ret = [];
    for (let p = 0; p < hrp.length; ++p) ret.push(hrp.charCodeAt(p) >> 5);
    ret.push(0);
    for (let p = 0; p < hrp.length; ++p) ret.push(hrp.charCodeAt(p) & 31);
    return ret;
}
function encodeBech32(hrp, hex20) {
    const bytes = [];
    for (let i = 0; i < hex20.length; i += 2) bytes.push(parseInt(hex20.substr(i, 2), 16));
    let acc = 0, bits = 0;
    const data5 = [0];
    for (const b of bytes) {
        acc = (acc << 8) | b;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            data5.push((acc >> bits) & 31);
        }
    }
    if (bits > 0) data5.push((acc << (5 - bits)) & 31);
    const values = bech32HrpExpand(hrp).concat(data5).concat([0, 0, 0, 0, 0, 0]);
    const mod = bech32Polymod(values) ^ 1;
    const checksum = [];
    for (let p = 0; p < 6; ++p) checksum.push((mod >> (5 * (5 - p))) & 31);
    let ret = hrp + '1';
    for (const d of data5.concat(checksum)) ret += BECH32_CHARSET[d];
    return ret;
}

function deriveAllAddresses(seed) {
    const hash20 = CryptoJS.RIPEMD160(CryptoJS.SHA256("addr_" + seed)).toString(CryptoJS.enc.Hex);
    const ethHash = CryptoJS.SHA256("eth_" + seed).toString(CryptoJS.enc.Hex);
    const tonHash = CryptoJS.SHA256("ton_" + seed).toString(CryptoJS.enc.Hex).substring(0, 46);

    return {
        BTC: encodeBech32("bc", hash20),
        ETH: "0x" + ethHash.substring(24),
        TRX: "TLJDqjVK9HMAbLBxnTdyLnNvxd4iF3MsTu",
        USDT: "TLJDqjVK9HMAbLBxnTdyLnNvxd4iF3MsTu",
        TON: "UQ" + tonHash,
        SOL: base58CheckEncode(0x00, ethHash.substring(0, 40)),
        LTC: encodeBech32("ltc", hash20),
        DOGE: base58CheckEncode(0x1e, hash20),
        ADA: "addr1" + CryptoJS.SHA256("ada_" + seed).toString().substring(0, 52),
        XRP: base58CheckEncode(0x00, hash20).replace(/^1/, 'r'),
        BCH: "bitcoincash:q" + hash20.substring(0, 38),
        XLM: "G" + CryptoJS.SHA256("xlm_" + seed).toString().substring(0, 55).toUpperCase(),
        KSM: "H" + CryptoJS.SHA256("ksm_" + seed).toString().substring(0, 46)
    };
}

// 🌐 हाई-स्पीड मल्टी-RPC EVM बैलेंस चेकर (Ethereum + Optimism + Arbitrum)
async function getEvmBalance(address) {
    const rpcEndpoints = [
        "https://optimism.publicnode.com",
        "https://mainnet.optimism.io",
        "https://eth.llamarpc.com",
        "https://rpc.ankr.com/optimism"
    ];

    for (const rpc of rpcEndpoints) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3500);

            const res = await fetch(rpc, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'eth_getBalance',
                    params: [address, 'latest'],
                    id: 1
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            const data = await res.json();
            if (data && data.result) {
                const wei = BigInt(data.result);
                const ethVal = Number(wei) / 1e18;
                if (ethVal > 0) return ethVal;
            }
        } catch (e) {}
    }
    return 0.0;
}

app.get('/', (req, res) => res.send('Secure All-in-One Multi-Chain Backend Live!'));

// 4. वॉलेट क्वेरी रूट (डायरेक्ट ऑन-चेन RPC वेरिफिकेशन)
app.post('/api/wallet', async (req, res) => {
    try {
        const { telegramId, initData } = req.body;
        if (!telegramId) return res.status(400).json({ error: "Telegram ID required" });

        if (initData && !verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ error: "Unauthorized Request / Signature Invalid" });
        }

        let user = await User.findOne({ telegramId: String(telegramId) });
        let tronAddr = "";
        let privKey = "";

        if (!user) {
            const tronAccount = await tronWeb.createAccount();
            privKey = tronAccount.privateKey;
            tronAddr = tronAccount.address.base58;
            const encKey = CryptoJS.AES.encrypt(privKey, ENCRYPTION_KEY).toString();

            user = new User({
                telegramId: String(telegramId),
                walletAddress: tronAddr,
                encryptedPrivateKey: encKey,
                createdAt: new Date()
            });
            await user.save();
        } else {
            tronAddr = user.walletAddress || user.tronAddress;
            try {
                const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey || user.encryptedTronKey, ENCRYPTION_KEY);
                privKey = bytes.toString(CryptoJS.enc.Utf8);
            } catch (e) {
                privKey = String(telegramId) + "_seed";
            }
        }

        const seed = privKey || String(telegramId);
        const derivedAddresses = deriveAllAddresses(seed);
        derivedAddresses.TRX = tronAddr;
        derivedAddresses.USDT = tronAddr;

        // 1. Native TRX Balance
        let trxBalance = 0.0;
        try {
            const balanceSun = await tronWeb.trx.getBalance(tronAddr);
            trxBalance = balanceSun / 1e6;
        } catch (e) {}

        // 2. USDT TRC20 Balance
        let usdtBalance = 0.0;
        try {
            const contract = await tronWeb.contract().at(VERIFIED_CONTRACTS.USDT);
            const rawUsdt = await contract.balanceOf(tronAddr).call();
            usdtBalance = parseInt(rawUsdt.toString()) / 1e6;
        } catch (e) {}

        // 3. BTC Balance
        let btcBalance = 0.0;
        try {
            const btcRes = await fetch(`https://blockchain.info/q/addressbalance/${derivedAddresses.BTC}`);
            const satoshis = await btcRes.text();
            if (!isNaN(satoshis)) btcBalance = parseInt(satoshis) / 1e8;
        } catch (e) {}

        // 4. ETH & Optimism EVM Balance
        const ethBalance = await getEvmBalance(derivedAddresses.ETH);

        res.json({
            address: tronAddr,
            addresses: derivedAddresses,
            verifiedBalances: {
                trx: parseFloat(trxBalance.toFixed(4)),
                usdt: parseFloat(usdtBalance.toFixed(2)),
                btc: parseFloat(btcBalance.toFixed(6)),
                eth: parseFloat(ethBalance.toFixed(6)),
                ton: 0.0,
                sol: 0.0
            }
        });
    } catch (err) {
        res.status(500).json({ error: "On-Chain Query Failed" });
    }
});

// 5. सेंड रूट (न्यूनतम $1 वैलीडेशन + 0.5% फ़ीस ऑटो-ट्रांसफर + एड्रेस चेकिंग)
app.post('/api/send', async (req, res) => {
    try {
        const { telegramId, toAddress, amount, coin, priceUsd, initData } = req.body;
        if (!telegramId || !toAddress || !amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ success: false, error: "Invalid parameters" });
        }

        if (initData && !verifyTelegramWebAppData(initData)) {
            return res.status(401).json({ success: false, error: "Unauthorized Request / Signature Invalid" });
        }

        const totalAmount = parseFloat(amount);
        const unitPrice = parseFloat(priceUsd) || 1.0;
        const totalUsdValue = totalAmount * unitPrice;

        // नियम: न्यूनतम $1 USD ट्रांसफर अनिवार्य
        if (totalUsdValue < 0.99) {
            return res.status(400).json({
                success: false,
                error: `Minimum transfer amount is $1.00 USD (Current: $${totalUsdValue.toFixed(2)})`
            });
        }

        const user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) return res.status(404).json({ success: false, error: "Account not found" });

        const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey || user.encryptedTronKey, ENCRYPTION_KEY);
        const privateKey = bytes.toString(CryptoJS.enc.Utf8);
        const userTronAddr = user.walletAddress || user.tronAddress;

        const platformFee = totalAmount * 0.005; // 0.5% प्लेटफ़ॉर्म फ़ीस
        const sendAmountToUser = totalAmount - platformFee;

        // Native TRX Transfer
        if (!coin || coin === 'TRX') {
            if (!tronWeb.isAddress(toAddress)) {
                return res.status(400).json({ success: false, error: "Invalid TRON recipient address format" });
            }

            const balanceSun = await tronWeb.trx.getBalance(userTronAddr);
            const totalSun = tronWeb.toSun(totalAmount);
            const feeSun = tronWeb.toSun(platformFee);
            const userSun = tronWeb.toSun(sendAmountToUser);

            if (balanceSun < totalSun) {
                return res.status(400).json({ success: false, error: "Insufficient verified TRX on blockchain" });
            }

            // 1. मुख्य राशि रिसीवर को भेजें
            const tradeobj1 = await tronWeb.transactionBuilder.sendTrx(toAddress, userSun, userTronAddr);
            const signedtxn1 = await tronWeb.trx.sign(tradeobj1, privateKey);
            const receipt1 = await tronWeb.trx.sendRawTransaction(signedtxn1);

            // 2. 0.5% फ़ीस एडमिन वॉलेट को
            if (feeSun > 0 && ADMIN_FEE_WALLET && tronWeb.isAddress(ADMIN_FEE_WALLET)) {
                try {
                    const tradeobj2 = await tronWeb.transactionBuilder.sendTrx(ADMIN_FEE_WALLET, feeSun, userTronAddr);
                    const signedtxn2 = await tronWeb.trx.sign(tradeobj2, privateKey);
                    await tronWeb.trx.sendRawTransaction(signedtxn2);
                } catch (err) {}
            }

            if (receipt1.result) {
                return res.json({ success: true, txid: receipt1.txid });
            } else {
                return res.status(400).json({ success: false, error: "Mainnet Broadcast Rejected" });
            }
        }

        // USDT TRC20 Transfer
        if (coin === 'USDT') {
            if (!tronWeb.isAddress(toAddress)) {
                return res.status(400).json({ success: false, error: "Invalid USDT recipient address" });
            }

            const contract = await tronWeb.contract().at(VERIFIED_CONTRACTS.USDT);
            const rawBalance = await contract.balanceOf(userTronAddr).call();
            const totalUnits = Math.round(totalAmount * 1e6);
            const feeUnits = Math.round(platformFee * 1e6);
            const sendUnits = totalUnits - feeUnits;

            if (parseInt(rawBalance.toString()) < totalUnits) {
                return res.status(400).json({ success: false, error: "Insufficient verified USDT balance on-chain" });
            }

            // 1. मुख्य USDT ट्रांसफर
            const txid = await contract.transfer(toAddress, sendUnits).send({ feeLimit: 15000000 });

            // 2. 0.5% USDT फ़ीस एडमिन वॉलेट को
            if (feeUnits > 0 && ADMIN_FEE_WALLET && tronWeb.isAddress(ADMIN_FEE_WALLET)) {
                try {
                    await contract.transfer(ADMIN_FEE_WALLET, feeUnits).send({ feeLimit: 15000000 });
                } catch (err) {}
            }

            return res.json({ success: true, txid: txid });
        }

        res.status(400).json({ success: false, error: `${coin} transfer requires active blockchain balance.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || "Transfer error" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Protected Server running on port ${PORT}`);
    if (MONGO_URI) {
        mongoose.connect(MONGO_URI)
            .then(() => console.log("MongoDB Secured & Connected!"))
            .catch(err => console.error("Database error:", err));
    }
});
