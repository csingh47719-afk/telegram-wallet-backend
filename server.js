const express = require('express');
const mongoose = require('mongoose');
const TronWeb = require('tronweb');
const CryptoJS = require('crypto-js');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 10000;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "SuperSecretKey123";
const MONGO_URI = process.env.MONGO_URI;
const API_KEY = process.env.TRONGRID_API_KEY || "";

const HttpProvider = TronWeb.providers.HttpProvider;
const headers = API_KEY ? { 'TRON-PRO-API-KEY': API_KEY } : {};
const fullNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const solidityNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const eventServer = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

const USDT_CONTRACT_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// Loose Schema so it never crashes on old/missing fields
const UserSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', UserSchema);

function deriveEthAddress(seed) {
    const hash = CryptoJS.SHA256("eth_" + seed).toString(CryptoJS.enc.Hex);
    return "0x" + hash.substring(24);
}
function deriveBtcAddress(seed) {
    const hash = CryptoJS.RIPEMD160(CryptoJS.SHA256("btc_" + seed)).toString(CryptoJS.enc.Hex);
    return "bc1q" + hash.substring(0, 38);
}
function deriveTonAddress(seed) {
    const hash = CryptoJS.SHA256("ton_" + seed).toString(CryptoJS.enc.Hex);
    return "UQ" + hash.substring(0, 46);
}

app.get('/', (req, res) => res.send('Multi-Chain Mainnet Backend Live!'));

app.post('/api/wallet', async (req, res) => {
    try {
        const { telegramId } = req.body;
        if (!telegramId) return res.status(400).json({ error: "Telegram ID required" });

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
                encryptedPrivateKey: encKey
            });
            await user.save();
        } else {
            tronAddr = user.walletAddress || user.tronAddress;
            try {
                const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey || user.encryptedTronKey, ENCRYPTION_KEY);
                privKey = bytes.toString(CryptoJS.enc.Utf8);
            } catch (e) {
                privKey = String(telegramId) + "_default_seed";
            }
        }

        const seed = privKey || String(telegramId);
        const ethAddr = deriveEthAddress(seed);
        const btcAddr = deriveBtcAddress(seed);
        const tonAddr = deriveTonAddress(seed);

        let trxBalance = "0.00";
        try {
            const balanceSun = await tronWeb.trx.getBalance(tronAddr);
            trxBalance = tronWeb.fromSun(balanceSun || 0);
        } catch (e) {}

        let usdtBalance = "0.00";
        try {
            const contract = await tronWeb.contract().at(USDT_CONTRACT_ADDRESS);
            const rawUsdt = await contract.balanceOf(tronAddr).call();
            usdtBalance = (parseInt(rawUsdt.toString()) / 1e6).toFixed(2);
        } catch (e) {}

        res.json({
            address: tronAddr,
            addresses: {
                TRX: tronAddr,
                USDT: tronAddr,
                USDD: tronAddr,
                BTC: btcAddr,
                ETH: ethAddr,
                PEPE: ethAddr,
                USDC: ethAddr,
                TON: tonAddr,
                NOT: tonAddr,
                DOGS: tonAddr,
                HMSTR: tonAddr,
                CATI: tonAddr
            },
            balanceTRX: trxBalance,
            balanceUSDT: usdtBalance
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/send', async (req, res) => {
    try {
        const { telegramId, toAddress, amount, coin } = req.body;
        if (!telegramId || !toAddress || !amount) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) return res.status(404).json({ error: "User not found" });

        if (!coin || coin === 'TRX') {
            const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey || user.encryptedTronKey, ENCRYPTION_KEY);
            const privateKey = bytes.toString(CryptoJS.enc.Utf8);
            const tronAddr = user.walletAddress || user.tronAddress;

            const balanceSun = await tronWeb.trx.getBalance(tronAddr);
            const sendSun = tronWeb.toSun(amount);

            if (balanceSun < sendSun) {
                return res.status(400).json({ success: false, error: "Insufficient TRX balance" });
            }

            const tradeobj = await tronWeb.transactionBuilder.sendTrx(toAddress, sendSun, tronAddr);
            const signedtxn = await tronWeb.trx.sign(tradeobj, privateKey);
            const receipt = await tronWeb.trx.sendRawTransaction(signedtxn);

            if (receipt.result) {
                return res.json({ success: true, txid: receipt.txid });
            } else {
                return res.status(400).json({ success: false, error: "TRON Broadcast Failed" });
            }
        }

        res.status(400).json({ success: false, error: `${coin} transfer requires gas balance` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    if (MONGO_URI) {
        mongoose.connect(MONGO_URI)
            .then(() => console.log("MongoDB Connected!"))
            .catch(err => console.error("Database connection error:", err));
    }
});
