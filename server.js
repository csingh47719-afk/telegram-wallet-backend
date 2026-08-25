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

// TRON Mainnet Configuration
const HttpProvider = TronWeb.providers.HttpProvider;
const headers = API_KEY ? { 'TRON-PRO-API-KEY': API_KEY } : {};

const fullNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const solidityNode = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);
const eventServer = new HttpProvider('https://api.trongrid.io', 30000, false, false, headers);

const tronWeb = new TronWeb(fullNode, solidityNode, eventServer);

// Mainnet USDT TRC-20 Contract Address
const USDT_CONTRACT_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const UserSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    walletAddress: { type: String, required: true },
    encryptedPrivateKey: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

// Root
app.get('/', (req, res) => res.send('TRON Mainnet Wallet Server Live!'));

// Get Wallet Balance (TRX + USDT)
app.post('/api/wallet', async (req, res) => {
    try {
        const { telegramId } = req.body;
        if (!telegramId) return res.status(400).json({ error: "Telegram ID required" });

        let user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) {
            const account = await tronWeb.createAccount();
            const encryptedKey = CryptoJS.AES.encrypt(account.privateKey, ENCRYPTION_KEY).toString();
            user = new User({
                telegramId: String(telegramId),
                walletAddress: account.address.base58,
                encryptedPrivateKey: encryptedKey
            });
            await user.save();
        }

        // TRX Balance
        const balanceSun = await tronWeb.trx.getBalance(user.walletAddress);
        const trxBalance = tronWeb.fromSun(balanceSun);

        // USDT TRC-20 Balance
        let usdtBalance = "0.00";
        try {
            const contract = await tronWeb.contract().at(USDT_CONTRACT_ADDRESS);
            const rawUsdt = await contract.balanceOf(user.walletAddress).call();
            usdtBalance = (parseInt(rawUsdt.toString()) / 1e6).toFixed(2);
        } catch (tokenErr) {
            console.error("USDT Fetch Error:", tokenErr);
        }

        res.json({
            address: user.walletAddress,
            balanceTRX: trxBalance,
            balanceUSDT: usdtBalance
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send TRX on Mainnet
app.post('/api/send', async (req, res) => {
    try {
        const { telegramId, toAddress, amount } = req.body;
        if (!telegramId || !toAddress || !amount) {
            return res.status(400).json({ error: "All fields are required" });
        }

        const user = await User.findOne({ telegramId: String(telegramId) });
        if (!user) return res.status(404).json({ error: "User not found" });

        const bytes = CryptoJS.AES.decrypt(user.encryptedPrivateKey, ENCRYPTION_KEY);
        const privateKey = bytes.toString(CryptoJS.enc.Utf8);

        const sunAmount = tronWeb.toSun(amount);
        const tradeobj = await tronWeb.transactionBuilder.sendTrx(toAddress, sunAmount, user.walletAddress);
        const signedtxn = await tronWeb.trx.sign(tradeobj, privateKey);
        const receipt = await tronWeb.trx.sendRawTransaction(signedtxn);

        if (receipt.result) {
            res.json({ success: true, txid: receipt.txid });
        } else {
            res.status(400).json({ success: false, error: "Mainnet Transaction failed" });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    if (MONGO_URI) {
        mongoose.connect(MONGO_URI)
            .then(() => console.log("MongoDB Connected Successfully!"))
            .catch(err => console.error("Database connection error:", err));
    }
});
                
