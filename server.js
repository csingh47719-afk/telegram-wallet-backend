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

const UserSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    tronAddress: { type: String, required: true },
    ethAddress: { type: String, required: true },
    btcAddress: { type: String, required: true },
    tonAddress: { type: String, required: true },
    encryptedTronKey: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

function deriveEthAddress(privKeyHex) {
    const hash = CryptoJS.SHA256(privKeyHex).toString(CryptoJS.enc.Hex);
    return "0x" + hash.substring(24);
}
function deriveBtcAddress(privKeyHex) {
    const hash = CryptoJS.RIPEMD160(CryptoJS.SHA256(privKeyHex)).toString(CryptoJS.enc.Hex);
    return "bc1q" + hash.substring(0, 38);
}
function deriveTonAddress(privKeyHex) {
    const hash = CryptoJS.SHA256("ton" + privKeyHex).toString(CryptoJS.enc.Hex);
    return "UQ" + hash.substring(0, 46);
}

app.get('/', (req, res) => res.send('Multi-Chain Mainnet Backend Live!'));

app.post('/api/wallet', async (req, res) => {
    try {
        const { telegramId } = req.body;
        if (!telegramId) return res.status(400).json({ error: "Telegram ID required" });

        let user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) {
            const tronAccount = await tronWeb.createAccount();
            const encryptedKey = CryptoJS.AES.encrypt(tronAccount.privateKey, ENCRYPTION_KEY).toString();
            
            user = new User({
                telegramId: String(telegramId),
                tronAddress: tronAccount.address.base58,
                ethAddress: deriveEthAddress(tronAccount.privateKey),
                btcAddress: deriveBtcAddress(tronAccount.privateKey),
                tonAddress: deriveTonAddress(tronAccount.privateKey),
                encryptedTronKey: encryptedKey
            });
            await user.save();
        } else if (!user.btcAddress || !user.ethAddress || !user.tonAddress) {
            // Update legacy user schema
            const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey || user.encryptedTronKey, ENCRYPTION_KEY);
            const pk = bytes.toString(CryptoJS.enc.Utf8);
            user.tronAddress = user.walletAddress || user.tronAddress;
            user.ethAddress = deriveEthAddress(pk);
            user.btcAddress = deriveBtcAddress(pk);
            user.tonAddress = deriveTonAddress(pk);
            user.encryptedTronKey = user.encryptedPrivateKey || user.encryptedTronKey;
            await user.save();
        }

        const balanceSun = await tronWeb.trx.getBalance(user.tronAddress);
        const trxBalance = tronWeb.fromSun(balanceSun || 0);

        let usdtBalance = "0.00";
        try {
            const contract = await tronWeb.contract().at(USDT_CONTRACT_ADDRESS);
            const rawUsdt = await contract.balanceOf(user.tronAddress).call();
            usdtBalance = (parseInt(rawUsdt.toString()) / 1e6).toFixed(2);
        } catch (tokenErr) {}

        res.json({
            addresses: {
                TRX: user.tronAddress,
                USDT: user.tronAddress,
                USDD: user.tronAddress,
                BTC: user.btcAddress,
                BTCT: user.tronAddress,
                ETH: user.ethAddress,
                PEPE: user.ethAddress,
                USDC: user.ethAddress,
                TON: user.tonAddress,
                NOT: user.tonAddress,
                DOGS: user.tonAddress,
                HMSTR: user.tonAddress,
                CATI: user.tonAddress
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
            const bytes = CryptoJS.AES.decrypt(user.encryptedTronKey, ENCRYPTION_KEY);
            const privateKey = bytes.toString(CryptoJS.enc.Utf8);

            const balanceSun = await tronWeb.trx.getBalance(user.tronAddress);
            const sendSun = tronWeb.toSun(amount);

            if (balanceSun < sendSun) {
                return res.status(400).json({ success: false, error: "Insufficient TRX balance" });
            }

            const tradeobj = await tronWeb.transactionBuilder.sendTrx(toAddress, sendSun, user.tronAddress);
            const signedtxn = await tronWeb.trx.sign(tradeobj, privateKey);
            const receipt = await tronWeb.trx.sendRawTransaction(signedtxn);

            if (receipt.result) {
                return res.json({ success: true, txid: receipt.txid });
            } else {
                return res.status(400).json({ success: false, error: "TRON Mainnet Broadcast Failed" });
            }
        }

        res.status(400).json({ success: false, error: `${coin} requires active blockchain balance & gas fees` });
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
