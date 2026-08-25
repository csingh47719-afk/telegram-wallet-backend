const express = require('express');
const mongoose = require('mongoose');
const TronWeb = require('tronweb');
const CryptoJS = require('crypto-js');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "SuperSecretKey123";
const MONGO_URI = process.env.MONGO_URI;

const tronWeb = new TronWeb({
    fullHost: 'https://nile.trongrid.io'
});

const UserSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    walletAddress: { type: String, required: true },
    encryptedPrivateKey: { type: String, required: true }
});
const User = mongoose.model('User', UserSchema);

app.get('/', (req, res) => res.send('Wallet Server Live!'));

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

        const balanceSun = await tronWeb.trx.getBalance(user.walletAddress);
        const trxBalance = tronWeb.fromSun(balanceSun);

        res.json({
            address: user.walletAddress,
            balanceTRX: trxBalance,
            balanceUSDT: "0.00"
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

mongoose.connect(MONGO_URI)
    .then(() => {
        app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    })
    .catch(err => console.error("Database connection error:", err));
