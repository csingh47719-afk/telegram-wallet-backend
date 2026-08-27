const express = require("express");
const mongoose = require("mongoose");
const { TronWeb } = require("tronweb");
const { ethers } = require("ethers");
const CryptoJS = require("crypto-js");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(express.json({ limit: "20kb" }));
app.use(cors({ origin: "*" }));

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 10000;

const MONGO_URI = process.env.MONGO_URI || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "";

const TRONGRID_API_KEY =
    (process.env.TRONGRID_API_KEY || "").trim();

const PLATFORM_FEE_ADDRESS =
    "0x3e0ad2f060bacb9da968bf4321fda71bc29d014b";

const PLATFORM_FEE_PERCENT = 0.005; // 0.5%
const MIN_RECEIVE_USD = 1.00;

/* =========================================================
   RATE LIMIT
========================================================= */

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: "Too many requests. Please try again later."
    }
});

app.use("/api/", apiLimiter);

/* =========================================================
   TRON
========================================================= */

const tronHeaders = {};

if (TRONGRID_API_KEY) {
    tronHeaders["TRON-PRO-API-KEY"] = TRONGRID_API_KEY;
}

const tronWeb = new TronWeb({
    fullHost: "https://api.trongrid.io",
    headers: tronHeaders
});

const VERIFIED_CONTRACTS = {
    TRON: {
        USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
    }
};

/* =========================================================
   EVM NETWORKS
========================================================= */

const EVM_NETWORKS = {
    ETH: {
        name: "Ethereum Mainnet",
        chainId: 1,
        rpc: "https://ethereum-rpc.publicnode.com"
    },

    OPTIMISM: {
        name: "Optimism",
        chainId: 10,
        rpc: "https://optimism-rpc.publicnode.com"
    },

    ARBITRUM: {
        name: "Arbitrum One",
        chainId: 42161,
        rpc: "https://arbitrum-one-rpc.publicnode.com"
    },

    BASE: {
        name: "Base",
        chainId: 8453,
        rpc: "https://base-rpc.publicnode.com"
    }
};

/* =========================================================
   DATABASE
========================================================= */

const UserSchema = new mongoose.Schema(
    {
        telegramId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },

        walletAddress: {
            type: String,
            required: true
        },

        encryptedPrivateKey: {
            type: String,
            required: true
        },

        createdAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        versionKey: false
    }
);

const User = mongoose.model("User", UserSchema);

/* =========================================================
   ENCRYPTION
========================================================= */

function getEncryptionKey() {
    if (!ENCRYPTION_KEY) {
        throw new Error("ENCRYPTION_KEY is missing");
    }

    return ENCRYPTION_KEY;
}

function encryptKey(privateKey) {
    return CryptoJS.AES
        .encrypt(privateKey, getEncryptionKey())
        .toString();
}

function decryptKey(ciphertext) {
    const bytes = CryptoJS.AES.decrypt(
        ciphertext,
        getEncryptionKey()
    );

    const result = bytes.toString(CryptoJS.enc.Utf8);

    if (!result) {
        throw new Error("Private key decryption failed");
    }

    return result;
}

/* =========================================================
   TELEGRAM WEB APP VERIFICATION
========================================================= */

function verifyTelegramWebAppData(initData) {
    if (!initData) {
        return false;
    }

    if (!BOT_TOKEN) {
        return false;
    }

    try {
        const urlParams = new URLSearchParams(initData);

        const receivedHash = urlParams.get("hash");

        if (!receivedHash) {
            return false;
        }

        urlParams.delete("hash");

        const dataCheckArr = [];

        for (const [key, value] of urlParams.entries()) {
            dataCheckArr.push(`${key}=${value}`);
        }

        dataCheckArr.sort();

        const dataCheckString = dataCheckArr.join("\n");

        const secretKey = crypto
            .createHmac("sha256", "WebAppData")
            .update(BOT_TOKEN)
            .digest();

        const calculatedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        return crypto.timingSafeEqual(
            Buffer.from(calculatedHash),
            Buffer.from(receivedHash)
        );
    } catch (error) {
        console.error("Telegram verification error:", error.message);
        return false;
    }
}

/* =========================================================
   BASIC VALIDATION
========================================================= */

function isValidEvmAddress(address) {
    try {
        return ethers.isAddress(address);
    } catch {
        return false;
    }
}

function isValidTronAddress(address) {
    try {
        return tronWeb.isAddress(address);
    } catch {
        return false;
    }
}

/* =========================================================
   EVM WALLET DERIVATION
=========================================================

   Important:
   The old code used a hard-coded ETH address while using
   another private key for sending.

   This version derives the EVM wallet from the actual
   encrypted TRON private key so address and signing key match.
========================================================= */

function deriveEvmWalletFromTronPrivateKey(tronPrivateKey) {
    const hash = CryptoJS.SHA256(
        "OPEN_WALLET_EVM_V2:" + tronPrivateKey
    ).toString(CryptoJS.enc.Hex);

    const evmPrivateKey = "0x" + hash;

    return new ethers.Wallet(evmPrivateKey);
}

/* =========================================================
   PRICE
========================================================= */

async function getUsdPrice(coin) {
    const symbol = String(coin || "").toUpperCase();

    if (symbol === "USDT") {
        return 1;
    }

    let id = "";

    if (symbol === "ETH") {
        id = "ethereum";
    } else if (symbol === "TRX") {
        id = "tron";
    } else if (symbol === "BTC") {
        id = "bitcoin";
    } else {
        throw new Error("Unsupported price asset");
    }

    const url =
        "https://api.coingecko.com/api/v3/simple/price" +
        `?ids=${encodeURIComponent(id)}&vs_currencies=usd`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Price API failed: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    const price = Number(data?.[id]?.usd);

    if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid USD price");
    }

    return price;
}

/* =========================================================
   TRON BALANCES
========================================================= */

async function getTronBalances(address) {
    let trx = 0;
    let usdt = 0;

    try {
        const sun = await tronWeb.trx.getBalance(address);

        trx = Number(sun) / 1e6;
    } catch (error) {
        console.error(
            "TRX balance error:",
            error.message
        );
    }

    try {
        const contract = await tronWeb
            .contract()
            .at(VERIFIED_CONTRACTS.TRON.USDT);

        const raw = await contract
            .balanceOf(address)
            .call();

        usdt = Number(raw.toString()) / 1e6;
    } catch (error) {
        console.error(
            "USDT balance error:",
            error.message
        );
    }

    return {
        trx,
        usdt
    };
}

/* =========================================================
   EVM BALANCE
========================================================= */

async function getEvmBalance(networkKey, address) {
    const network = EVM_NETWORKS[networkKey];

    if (!network) {
        throw new Error("Unsupported EVM network");
    }

    const provider = new ethers.JsonRpcProvider(
        network.rpc,
        {
            name: network.name,
            chainId: network.chainId
        },
        {
            staticNetwork: true
        }
    );

    const balance = await provider.getBalance(address);

    return Number(
        ethers.formatEther(balance)
    );
}

/* =========================================================
   CREATE / GET USER
========================================================= */

async function getOrCreateUser(telegramId) {
    const id = String(telegramId);

    let user = await User.findOne({
        telegramId: id
    });

    if (user) {
        return user;
    }

    const tronAccount = await tronWeb.createAccount();

    const tronPrivateKey = tronAccount.privateKey;
    const tronAddress = tronAccount.address.base58;

    user = new User({
        telegramId: id,
        walletAddress: tronAddress,
        encryptedPrivateKey: encryptKey(tronPrivateKey)
    });

    await user.save();

    return user;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "OPEN WALLET",
        status: "LIVE",
        version: "2.0.0",
        fakeTxid: false
    });
});

/* =========================================================
   WALLET / BALANCE
========================================================= */

app.post("/api/wallet", async (req, res) => {
    try {
        const {
            telegramId,
            initData
        } = req.body;

        if (!telegramId) {
            return res.status(400).json({
                success: false,
                error: "Telegram ID required"
            });
        }

        /*
         * If BOT_TOKEN exists, verify Telegram data when
         * initData is supplied.
         */
        if (BOT_TOKEN && initData) {
            if (!verifyTelegramWebAppData(initData)) {
                return res.status(401).json({
                    success: false,
                    error: "Unauthorized request"
                });
            }
        }

        const user = await getOrCreateUser(
            telegramId
        );

        const tronPrivateKey = decryptKey(
            user.encryptedPrivateKey
        );

        const evmWallet =
            deriveEvmWalletFromTronPrivateKey(
                tronPrivateKey
            );

        const tronBalances =
            await getTronBalances(
                user.walletAddress
            );

        const evmBalances = {};

        for (const networkKey of Object.keys(
            EVM_NETWORKS
        )) {
            try {
                evmBalances[networkKey] =
                    await getEvmBalance(
                        networkKey,
                        evmWallet.address
                    );
            } catch (error) {
                console.error(
                    `${networkKey} balance error:`,
                    error.message
                );

                evmBalances[networkKey] = 0;
            }
        }

        return res.json({
            success: true,

            address: user.walletAddress,

            addresses: {
                TRX: user.walletAddress,
                USDT: user.walletAddress,

                ETH: evmWallet.address,

                BTC: "",
                TON: "",
                SOL: "",
                LTC: "",
                DOGE: ""
            },

            verifiedBalances: {
                trx: Number(
                    tronBalances.trx.toFixed(6)
                ),

                usdt: Number(
                    tronBalances.usdt.toFixed(6)
                ),

                eth: Number(
                    (evmBalances.ETH || 0)
                        .toFixed(8)
                ),

                optimism: Number(
                    (evmBalances.OPTIMISM || 0)
                        .toFixed(8)
                ),

                arbitrum: Number(
                    (evmBalances.ARBITRUM || 0)
                        .toFixed(8)
                ),

                base: Number(
                    (evmBalances.BASE || 0)
                        .toFixed(8)
                ),

                btc: 0,
                ton: 0,
                sol: 0,
                ltc: 0,
                doge: 0
            },

            platformFee: {
                percent: 0.5,
                address: PLATFORM_FEE_ADDRESS
            }
        });

    } catch (error) {
        console.error(
            "Wallet API error:",
            error
        );

        return res.status(500).json({
            success: false,
            error: "On-chain balance query failed"
        });
    }
});

/* =========================================================
   EVM ETH SEND
========================================================= */

async function sendEvmEth({
    user,
    toAddress,
    amount
}) {
    if (!isValidEvmAddress(toAddress)) {
        throw new Error(
            "Invalid Ethereum/EVM recipient address"
        );
    }

    const tronPrivateKey =
        decryptKey(
            user.encryptedPrivateKey
        );

    const wallet =
        deriveEvmWalletFromTronPrivateKey(
            tronPrivateKey
        );

    const networkKey =
        String(arguments[0]?.chain || "")
            .toUpperCase();
}

/* =========================================================
   ACTUAL EVM TRANSFER
========================================================= */

async function processEvmEthTransfer(
    user,
    toAddress,
    grossAmount,
    chain
) {
    const networkKey =
        String(chain || "ETH").toUpperCase();

    const network =
        EVM_NETWORKS[networkKey];

    if (!network) {
        throw new Error(
            "Unsupported EVM network"
        );
    }

    if (!isValidEvmAddress(toAddress)) {
        throw new Error(
            "Invalid recipient address"
        );
    }

    if (
        toAddress.toLowerCase() ===
        PLATFORM_FEE_ADDRESS.toLowerCase()
    ) {
        throw new Error(
            "Recipient cannot be the platform fee address"
        );
    }

    const tronPrivateKey =
        decryptKey(
            user.encryptedPrivateKey
        );

    const wallet =
        deriveEvmWalletFromTronPrivateKey(
            tronPrivateKey
        );

    const provider =
        new ethers.JsonRpcProvider(
            network.rpc,
            {
                name: network.name,
                chainId: network.chainId
            },
            {
                staticNetwork: true
            }
        );

    const connectedWallet =
        wallet.connect(provider);

    const amount =
        Number(grossAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(
            "Invalid ETH amount"
        );
    }

    /* -----------------------------------------
       0.5% PLATFORM FEE
    ----------------------------------------- */

    const feeAmount =
        amount * PLATFORM_FEE_PERCENT;

    const receiveAmount =
        amount - feeAmount;

    if (receiveAmount <= 0) {
        throw new Error(
            "Amount after fee is zero"
        );
    }

    /* -----------------------------------------
       SERVER-SIDE USD PRICE
    ----------------------------------------- */

    const ethUsd =
        await getUsdPrice("ETH");

    const receiveUsd =
        receiveAmount * ethUsd;

    if (receiveUsd < MIN_RECEIVE_USD) {
        throw new Error(
            `After 0.5% fee, recipient must receive at least $1.00 USD. Current value: $${receiveUsd.toFixed(2)}`
        );
    }

    /* -----------------------------------------
       BALANCE
    ----------------------------------------- */

    const balance =
        await provider.getBalance(
            wallet.address
        );

    const receiveWei =
        ethers.parseEther(
            receiveAmount.toFixed(18)
        );

    const feeWei =
        ethers.parseEther(
            feeAmount.toFixed(18)
        );

    /* -----------------------------------------
       GAS PRICE
    ----------------------------------------- */

    const feeData =
        await provider.getFeeData();

    const gasPrice =
        feeData.maxFeePerGas ||
        feeData.gasPrice;

    if (!gasPrice) {
        throw new Error(
            "Unable to determine network gas price"
        );
    }

    /*
     * Two native ETH transfers:
     *
     * 1. Recipient
     * 2. Platform fee
     *
     * Estimate gas for both before broadcasting.
     */

    const recipientGas =
        await provider.estimateGas({
            from: wallet.address,
            to: toAddress,
            value: receiveWei
        });

    const platformGas =
        await provider.estimateGas({
            from: wallet.address,
            to: PLATFORM_FEE_ADDRESS,
            value: feeWei
        });

    const totalGas =
        (recipientGas + platformGas);

    const gasCost =
        totalGas * gasPrice;

    const required =
        receiveWei +
        feeWei +
        gasCost;

    if (balance < required) {
        throw new Error(
            "Insufficient ETH balance. You need recipient amount + 0.5% fee + network gas."
        );
    }

    /* -----------------------------------------
       SEND RECIPIENT PAYMENT
    ----------------------------------------- */

    const recipientTx =
        await connectedWallet.sendTransaction({
            to: toAddress,
            value: receiveWei
        });

    const recipientReceipt =
        await recipientTx.wait();

    if (
        !recipientReceipt ||
        recipientReceipt.status !== 1
    ) {
        throw new Error(
            "Recipient transaction failed"
        );
    }

    /* -----------------------------------------
       SEND PLATFORM FEE
    -----------------------------------------

       IMPORTANT:
       This is a second real blockchain transaction.
       No fake TXID is ever generated.
    */

    let feeTx;

    try {
        feeTx =
            await connectedWallet.sendTransaction({
                to: PLATFORM_FEE_ADDRESS,
                value: feeWei
            });

        const feeReceipt =
            await feeTx.wait();

        if (
            !feeReceipt ||
            feeReceipt.status !== 1
        ) {
            throw new Error(
                "Platform fee transaction failed"
            );
        }

    } catch (feeError) {

        /*
         * Recipient payment has already succeeded.
         * Never create a fake TXID.
         */

        return {
            success: false,

            partialSuccess: true,

            txid: recipientTx.hash,

            recipientTxid: recipientTx.hash,

            feeTxid: null,

            feePending: true,

            error:
                "Recipient transfer succeeded, but platform fee transfer failed. No fake TXID was generated.",

            chain: networkKey,

            grossAmount: amount,

            feeAmount,

            receiveAmount,

            receiveUsd,

            feeAddress:
                PLATFORM_FEE_ADDRESS
        };
    }

    return {
        success: true,

        txid: recipientTx.hash,

        recipientTxid: recipientTx.hash,

        feeTxid: feeTx.hash,

        feePending: false,

        chain: networkKey,

        grossAmount: amount,

        feeAmount,

        receiveAmount,

        receiveUsd,

        feePercent: 0.5,

        feeAddress:
            PLATFORM_FEE_ADDRESS
    };
}

/* =========================================================
   TRON TRX SEND
========================================================= */

async function sendTrxTransfer(
    user,
    toAddress,
    grossAmount
) {
    if (!isValidTronAddress(toAddress)) {
        throw new Error(
            "Invalid TRON address"
        );
    }

    const amount =
        Number(grossAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(
            "Invalid TRX amount"
        );
    }

    const fee =
        amount * PLATFORM_FEE_PERCENT;

    const receive =
        amount - fee;

    const trxUsd =
        await getUsdPrice("TRX");

    const receiveUsd =
        receive * trxUsd;

    if (receiveUsd < MIN_RECEIVE_USD) {
        throw new Error(
            `After 0.5% fee, recipient must receive at least $1.00 USD. Current value: $${receiveUsd.toFixed(2)}`
        );
    }

    const privateKey =
        decryptKey(
            user.encryptedPrivateKey
        );

    const from =
        user.walletAddress;

    const balanceSun =
        await tronWeb.trx.getBalance(
            from
        );

    const balanceTrx =
        Number(balanceSun) / 1e6;

    /*
     * Fee address is EVM.
     *
     * Therefore TRX fee cannot be sent to the
     * Ethereum fee address.
     *
     * For TRX, reject instead of pretending
     * the fee was paid.
     */

    throw new Error(
        "TRX transfer fee address is an EVM address. Configure a TRON fee address before enabling TRX transfers."
    );
}

/* =========================================================
   TRON USDT SEND
========================================================= */

async function sendTronUsdtTransfer(
    user,
    toAddress,
    grossAmount
) {
    if (!isValidTronAddress(toAddress)) {
        throw new Error(
            "Invalid TRON USDT recipient address"
        );
    }

    const amount =
        Number(grossAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(
            "Invalid USDT amount"
        );
    }

    const fee =
        amount * PLATFORM_FEE_PERCENT;

    const receive =
        amount - fee;

    if (receive < MIN_RECEIVE_USD) {
        throw new Error(
            "After 0.5% fee, recipient must receive at least $1.00 USDT"
        );
    }

    /*
     * The supplied fee address is an Ethereum address.
     * It is NOT a TRON address.
     *
     * Never send TRC20 USDT to it.
     */

    throw new Error(
        "TRON USDT fee address is not configured. The supplied fee address is Ethereum/EVM, so TRON USDT transfer is disabled for safety."
    );
}

/* =========================================================
   SEND API
========================================================= */

app.post("/api/send", async (req, res) => {
    try {
        const {
            telegramId,
            toAddress,
            amount,
            coin,
            chain,
            initData
        } = req.body;

        if (
            !telegramId ||
            !toAddress ||
            amount === undefined ||
            amount === null
        ) {
            return res.status(400).json({
                success: false,
                error: "Missing required parameters"
            });
        }

        const amountNumber =
            Number(amount);

        if (
            !Number.isFinite(amountNumber) ||
            amountNumber <= 0
        ) {
            return res.status(400).json({
                success: false,
                error: "Invalid amount"
            });
        }

        /*
         * Telegram verification
         */

        if (BOT_TOKEN) {
            if (
                !initData ||
                !verifyTelegramWebAppData(initData)
            ) {
                return res.status(401).json({
                    success: false,
                    error:
                        "Telegram authentication failed"
                });
            }
        }

        const user =
            await User.findOne({
                telegramId:
                    String(telegramId)
            });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: "Wallet not found"
            });
        }

        const selectedCoin =
            String(coin || "")
                .toUpperCase();

        const selectedChain =
            String(chain || "ETH")
                .toUpperCase();

        /* =====================================
           ETH / EVM
        ===================================== */

        if (selectedCoin === "ETH") {

            const result =
                await processEvmEthTransfer(
                    user,
                    toAddress,
                    amountNumber,
                    selectedChain
                );

            if (!result.success) {
                return res.status(409).json(
                    result
                );
            }

            return res.json(result);
        }

        /* =====================================
           TRX
        ===================================== */

        if (selectedCoin === "TRX") {

            const result =
                await sendTrxTransfer(
                    user,
                    toAddress,
                    amountNumber
                );

            return res.json(result);
        }

        /* =====================================
           TRON USDT
        ===================================== */

        if (
            selectedCoin === "USDT" &&
            (
                !chain ||
                selectedChain === "TRX"
            )
        ) {

            const result =
                await sendTronUsdtTransfer(
                    user,
                    toAddress,
                    amountNumber
                );

            return res.json(result);
        }

        return res.status(400).json({
            success: false,
            error:
                `Unsupported asset/network combination: ${selectedCoin}/${selectedChain}`
        });

    } catch (error) {

        console.error(
            "SEND ERROR:",
            error
        );

        /*
         * NEVER generate a fake TXID.
         */

        return res.status(400).json({
            success: false,

            txid: null,

            error:
                error.message ||
                "Blockchain transaction failed"
        });
    }
});

/* =========================================================
   DATABASE
========================================================= */

async function startDatabase() {
    if (!MONGO_URI) {
        console.error(
            "WARNING: MONGO_URI is not configured."
        );
        return;
    }

    try {
        await mongoose.connect(
            MONGO_URI
        );

        console.log(
            "Database connected successfully."
        );

    } catch (error) {

        console.error(
            "Database connection error:",
            error.message
        );
    }
}

/* =========================================================
   SERVER
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    async () => {

        console.log(
            `OPEN WALLET backend running on port ${PORT}`
        );

        console.log(
            "Fake TXID generation: DISABLED"
        );

        console.log(
            "Platform fee: 0.5%"
        );

        console.log(
            "Platform fee address:",
            PLATFORM_FEE_ADDRESS
        );

        await startDatabase();
    }
);
