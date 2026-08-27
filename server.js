const express = require("express");
const mongoose = require("mongoose");
const TronWeb = require("tronweb");
const { ethers } = require("ethers");
const CryptoJS = require("crypto-js");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(express.json({ limit: "10kb" }));
app.use(cors({ origin: "*" }));

// ============================================================
// CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

const ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ||
    "SuperSecretUltraSecureKey_2026";

const MONGO_URI =
    process.env.MONGO_URI || "";

const BOT_TOKEN =
    process.env.BOT_TOKEN || "";

const TRONGRID_API_KEY =
    process.env.TRONGRID_API_KEY || "";

const PLATFORM_FEE_RATE = 0.005; // 0.5%
const MIN_RECIPIENT_USD = 1.00;

// Optional: अपने platform wallet का EVM address Render में डालें
const PLATFORM_FEE_ADDRESS =
    process.env.PLATFORM_FEE_ADDRESS || "";

// ============================================================
// RATE LIMIT
// ============================================================

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: "Too many requests. Please try again later."
    }
});

app.use("/api/", apiLimiter);

// ============================================================
// TRON
// ============================================================

const HttpProvider = TronWeb.providers.HttpProvider;

const tronHeaders = TRONGRID_API_KEY
    ? { "TRON-PRO-API-KEY": TRONGRID_API_KEY }
    : {};

const fullNode = new HttpProvider(
    "https://api.trongrid.io",
    30000,
    false,
    false,
    tronHeaders
);

const solidityNode = new HttpProvider(
    "https://api.trongrid.io",
    30000,
    false,
    false,
    tronHeaders
);

const eventServer = new HttpProvider(
    "https://api.trongrid.io",
    30000,
    false,
    false,
    tronHeaders
);

const tronWeb = new TronWeb(
    fullNode,
    solidityNode,
    eventServer
);

// ============================================================
// VERIFIED CONTRACTS
// ============================================================

const VERIFIED_CONTRACTS = {
    TRON: {
        USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
    }
};

// ============================================================
// EVM NETWORKS
// ============================================================

const EVM_RPCS = {
    ETH: "https://rpc.ankr.com/eth",
    ARBITRUM: "https://arb1.arbitrum.io/rpc",
    OPTIMISM: "https://mainnet.optimism.io",
    BASE: "https://mainnet.base.org"
};

// ============================================================
// DATABASE
// ============================================================

const UserSchema = new mongoose.Schema({
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
});

const User = mongoose.model("User", UserSchema);

// ============================================================
// TELEGRAM VERIFICATION
// ============================================================

function verifyTelegramWebAppData(initData) {

    if (!initData) return false;

    // Development compatibility
    if (!BOT_TOKEN) return true;

    try {

        const params =
            new URLSearchParams(initData);

        const hash =
            params.get("hash");

        if (!hash) return false;

        params.delete("hash");

        const dataCheckArray = [];

        for (const [key, value] of params.entries()) {
            dataCheckArray.push(
                `${key}=${value}`
            );
        }

        dataCheckArray.sort();

        const dataCheckString =
            dataCheckArray.join("\n");

        const secretKey =
            crypto
                .createHmac(
                    "sha256",
                    "WebAppData"
                )
                .update(BOT_TOKEN)
                .digest();

        const calculatedHash =
            crypto
                .createHmac(
                    "sha256",
                    secretKey
                )
                .update(dataCheckString)
                .digest("hex");

        return calculatedHash === hash;

    } catch (error) {

        console.error(
            "Telegram verification:",
            error.message
        );

        return false;
    }
}

// ============================================================
// ENCRYPTION
// ============================================================

function encryptKey(privateKey) {

    return CryptoJS.AES
        .encrypt(
            privateKey,
            ENCRYPTION_KEY
        )
        .toString();
}

function decryptKey(ciphertext) {

    const bytes =
        CryptoJS.AES.decrypt(
            ciphertext,
            ENCRYPTION_KEY
        );

    const privateKey =
        bytes.toString(
            CryptoJS.enc.Utf8
        );

    if (!privateKey) {
        throw new Error(
            "Private key decryption failed"
        );
    }

    return privateKey;
}

// ============================================================
// NORMALIZE EVM PRIVATE KEY
// ============================================================

function normalizePrivateKey(key) {

    let value =
        String(key || "").trim();

    if (!value.startsWith("0x")) {
        value = "0x" + value;
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(
            "Invalid EVM private key"
        );
    }

    return value;
}

// ============================================================
// GET EVM ADDRESS FROM PRIVATE KEY
// ============================================================

function getEvmAddress(privateKey) {

    try {

        const key =
            normalizePrivateKey(
                privateKey
            );

        const wallet =
            new ethers.Wallet(key);

        return wallet.address;

    } catch (error) {

        console.error(
            "EVM address error:",
            error.message
        );

        return "";
    }
}

// ============================================================
// ADDRESS OBJECT
// ============================================================

function buildAddresses(
    privateKey,
    tronAddress
) {

    const ethAddress =
        getEvmAddress(
            privateKey
        );

    return {

        ETH:
            ethAddress,

        ARBITRUM:
            ethAddress,

        OPTIMISM:
            ethAddress,

        BASE:
            ethAddress,

        TRX:
            tronAddress,

        USDT:
            tronAddress,

        BTC: "",

        TON: "",

        SOL: "",

        LTC: "",

        DOGE: ""
    };
}

// ============================================================
// NETWORK NORMALIZER
// ============================================================

function normalizeNetwork(chain) {

    const value =
        String(chain || "ETH")
            .trim()
            .toUpperCase();

    if (
        value === "ETH" ||
        value === "ETHEREUM" ||
        value === "MAINNET" ||
        value === "ETHEREUM MAINNET"
    ) {
        return "ETH";
    }

    if (
        value === "ARBITRUM" ||
        value === "ARBITRUM ONE"
    ) {
        return "ARBITRUM";
    }

    if (
        value === "OPTIMISM" ||
        value === "OP"
    ) {
        return "OPTIMISM";
    }

    if (value === "BASE") {
        return "BASE";
    }

    return null;
}

// ============================================================
// EVM PROVIDER
// ============================================================

function getProvider(network) {

    const rpc =
        EVM_RPCS[network];

    if (!rpc) {
        throw new Error(
            "Unsupported EVM network"
        );
    }

    return new ethers.JsonRpcProvider(
        rpc
    );
}

// ============================================================
// GET REAL EVM BALANCE
// ============================================================

async function getEvmBalance(
    network,
    address
) {

    try {

        if (!ethers.isAddress(address)) {
            return 0;
        }

        const provider =
            getProvider(network);

        const balance =
            await provider.getBalance(
                address
            );

        return Number(
            ethers.formatEther(balance)
        );

    } catch (error) {

        console.error(
            `${network} balance:`,
            error.message
        );

        return 0;
    }
}

// ============================================================
// GET ALL EVM BALANCES
// ============================================================

async function getAllEvmBalances(address) {

    const balances = {
        ETH: 0,
        ARBITRUM: 0,
        OPTIMISM: 0,
        BASE: 0
    };

    if (!ethers.isAddress(address)) {
        return balances;
    }

    await Promise.all(
        Object.keys(EVM_RPCS).map(
            async (network) => {

                balances[network] =
                    await getEvmBalance(
                        network,
                        address
                    );
            }
        )
    );

    return balances;
}

// ============================================================
// FEE CALCULATION
// ============================================================

function calculateTransfer(
    grossAmount,
    priceUsd
) {

    const amount =
        Number(grossAmount);

    const price =
        Number(priceUsd);

    if (
        !Number.isFinite(amount) ||
        amount <= 0
    ) {
        throw new Error(
            "Invalid amount"
        );
    }

    if (
        !Number.isFinite(price) ||
        price <= 0
    ) {
        throw new Error(
            "Invalid asset price"
        );
    }

    const fee =
        amount *
        PLATFORM_FEE_RATE;

    const recipientAmount =
        amount - fee;

    const recipientUsd =
        recipientAmount *
        price;

    const minimumGross =
        MIN_RECIPIENT_USD /
        (
            (1 - PLATFORM_FEE_RATE) *
            price
        );

    return {

        grossAmount:
            amount,

        fee:
            fee,

        recipientAmount:
            recipientAmount,

        recipientUsd:
            recipientUsd,

        minimumGross:
            minimumGross
    };
}

// ============================================================
// WALLET BALANCE SNAPSHOT
// ============================================================

async function getWalletSnapshot(
    user
) {

    const privateKey =
        decryptKey(
            user.encryptedPrivateKey
        );

    const addresses =
        buildAddresses(
            privateKey,
            user.walletAddress
        );

    // ---------------- TRX ----------------

    let trxBalance = 0;

    try {

        const sun =
            await tronWeb.trx.getBalance(
                user.walletAddress
            );

        trxBalance =
            Number(sun) / 1e6;

    } catch (error) {

        console.error(
            "TRX balance:",
            error.message
        );
    }

    // ---------------- USDT ----------------

    let usdtBalance = 0;

    try {

        const contract =
            await tronWeb
                .contract()
                .at(
                    VERIFIED_CONTRACTS.TRON.USDT
                );

        const raw =
            await contract
                .balanceOf(
                    user.walletAddress
                )
                .call();

        usdtBalance =
            Number(raw) / 1e6;

    } catch (error) {

        console.error(
            "USDT balance:",
            error.message
        );
    }

    // ---------------- EVM ----------------

    const evmBalances =
        await getAllEvmBalances(
            addresses.ETH
        );

    return {

        address:
            user.walletAddress,

        addresses:
            addresses,

        evmBalances:
            evmBalances,

        verifiedBalances: {

            trx:
                Number(
                    trxBalance.toFixed(6)
                ),

            usdt:
                Number(
                    usdtBalance.toFixed(6)
                ),

            btc: 0,

            eth:
                Number(
                    evmBalances.ETH.toFixed(8)
                ),

            arbitrum:
                Number(
                    evmBalances.ARBITRUM.toFixed(8)
                ),

            optimism:
                Number(
                    evmBalances.OPTIMISM.toFixed(8)
                ),

            base:
                Number(
                    evmBalances.BASE.toFixed(8)
                ),

            ton: 0,

            sol: 0
        }
    };
}

// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {

    res.json({

        success: true,

        message:
            "🛡️ OPEN WALLET Mainnet Backend Active",

        platformFee:
            "0.5%",

        minimumRecipientValue:
            "$1.00",

        fakeTxId:
            false,

        networks: [
            "Ethereum Mainnet",
            "Arbitrum One",
            "Optimism",
            "Base",
            "TRON",
            "TRON USDT"
        ]
    });
});

// ============================================================
// WALLET API
// ============================================================

app.post(
    "/api/wallet",
    async (req, res) => {

        try {

            const {
                telegramId,
                initData
            } = req.body;

            if (!telegramId) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Telegram ID required"
                });
            }

            if (
                initData &&
                !verifyTelegramWebAppData(
                    initData
                )
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Unauthorized request"
                });
            }

            let user =
                await User.findOne({
                    telegramId:
                        String(telegramId)
                });

            // =================================================
            // CREATE NEW WALLET
            // =================================================

            if (!user) {

                const account =
                    await tronWeb.createAccount();

                const tronAddress =
                    account.address.base58;

                const privateKey =
                    account.privateKey;

                user =
                    new User({

                        telegramId:
                            String(telegramId),

                        walletAddress:
                            tronAddress,

                        encryptedPrivateKey:
                            encryptKey(
                                privateKey
                            )
                    });

                await user.save();

                console.log(
                    "New wallet created:",
                    telegramId
                );
            }

            // =================================================
            // REAL BALANCE
            // =================================================

            const snapshot =
                await getWalletSnapshot(
                    user
                );

            return res.json({

                success: true,

                ...snapshot
            });

        } catch (error) {

            console.error(
                "WALLET ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to load real blockchain balance"
            });
        }
    }
);

// ============================================================
// SEND API
// ============================================================

app.post(
    "/api/send",
    async (req, res) => {

        try {

            const {
                telegramId,
                toAddress,
                amount,
                coin,
                chain,
                priceUsd,
                initData
            } = req.body;

            // =================================================
            // VALIDATION
            // =================================================

            if (
                !telegramId ||
                !toAddress ||
                amount === undefined ||
                amount === null
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Invalid parameters"
                });
            }

            if (
                initData &&
                !verifyTelegramWebAppData(
                    initData
                )
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Signature verification failed"
                });
            }

            // =================================================
            // FEE
            // =================================================

            let transfer;

            try {

                transfer =
                    calculateTransfer(
                        amount,
                        priceUsd
                    );

            } catch (error) {

                return res.status(400).json({

                    success: false,

                    error:
                        error.message
                });
            }

            // =================================================
            // MINIMUM $1 AFTER FEE
            // =================================================

            if (
                transfer.recipientUsd <
                MIN_RECIPIENT_USD
            ) {

                return res.status(400).json({

                    success: false,

                    error:
                        "After 0.5% fee, recipient must receive at least $1.00.",

                    currentRecipientValue:
                        Number(
                            transfer.recipientUsd
                                .toFixed(6)
                        ),

                    minimumRecipientValue:
                        MIN_RECIPIENT_USD,

                    minimumSendAmount:
                        Number(
                            transfer.minimumGross
                                .toFixed(12)
                        ),

                    feeRate:
                        "0.5%"
                });
            }

            // =================================================
            // FIND USER
            // =================================================

            const user =
                await User.findOne({

                    telegramId:
                        String(telegramId)

                });

            if (!user) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Wallet not found"
                });
            }

            // =================================================
            // PRIVATE KEY
            // =================================================

            let privateKey;

            try {

                privateKey =
                    decryptKey(
                        user.encryptedPrivateKey
                    );

            } catch (error) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Wallet private key unavailable"
                });
            }

            // =================================================
            // ETH / EVM
            // =================================================

            if (
                String(coin)
                    .toUpperCase() ===
                "ETH"
            ) {

                const network =
                    normalizeNetwork(
                        chain
                    );

                if (!network) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Unsupported Ethereum network"
                    });
                }

                if (
                    !ethers.isAddress(
                        toAddress
                    )
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Invalid Ethereum recipient address"
                    });
                }

                const provider =
                    getProvider(
                        network
                    );

                const wallet =
                    new ethers.Wallet(
                        normalizePrivateKey(
                            privateKey
                        ),
                        provider
                    );

                const from =
                    await wallet.getAddress();

                // =================================================
                // VERIFY WALLET ADDRESS
                // =================================================

                const balance =
                    await provider.getBalance(
                        from
                    );

                // =================================================
                // RECIPIENT VALUE
                // =================================================

                const recipientWei =
                    ethers.parseEther(
                        transfer.recipientAmount
                            .toFixed(18)
                    );

                // =================================================
                // GAS ESTIMATE
                // =================================================

                let gasLimit;

                try {

                    gasLimit =
                        await provider.estimateGas({

                            from:
                                from,

                            to:
                                toAddress,

                            value:
                                recipientWei
                        });

                } catch (error) {

                    gasLimit =
                        21000n;
                }

                // Add 20% safety
                gasLimit =
                    (
                        gasLimit *
                        120n
                    ) / 100n;

                const feeData =
                    await provider.getFeeData();

                let gasPrice;

                if (
                    feeData.maxFeePerGas
                ) {

                    gasPrice =
                        feeData.maxFeePerGas;

                } else if (
                    feeData.gasPrice
                ) {

                    gasPrice =
                        feeData.gasPrice;

                } else {

                    return res.status(503).json({

                        success: false,

                        error:
                            "Unable to get current gas price"
                    });
                }

                const gasCost =
                    gasLimit *
                    gasPrice;

                // =================================================
                // FEE
                // =================================================

                const platformFeeWei =
                    ethers.parseEther(
                        transfer.fee
                            .toFixed(18)
                    );

                // =================================================
                // REQUIRED BALANCE
                // =================================================

                let requiredBalance =
                    recipientWei +
                    gasCost;

                if (
                    PLATFORM_FEE_ADDRESS &&
                    ethers.isAddress(
                        PLATFORM_FEE_ADDRESS
                    )
                ) {

                    requiredBalance +=
                        platformFeeWei;
                }

                // =================================================
                // REAL BALANCE CHECK
                // =================================================

                if (
                    balance <
                    requiredBalance
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            `Insufficient ETH balance on ${network}.`,

                        network:
                            network,

                        available:
                            ethers.formatEther(
                                balance
                            ),

                        required:
                            ethers.formatEther(
                                requiredBalance
                            ),

                        recipientAmount:
                            transfer.recipientAmount,

                        platformFee:
                            transfer.fee
                    });
                }

                // =================================================
                // SEND RECIPIENT
                // =================================================

                let recipientTx;

                try {

                    recipientTx =
                        await wallet.sendTransaction({

                            to:
                                toAddress,

                            value:
                                recipientWei,

                            gasLimit:
                                gasLimit
                        });

                } catch (error) {

                    console.error(
                        "EVM send failed:",
                        error
                    );

                    return res.status(400).json({

                        success: false,

                        error:
                            error.shortMessage ||
                            error.reason ||
                            error.message ||
                            "Blockchain transaction failed"
                    });
                }

                // =================================================
                // WAIT CONFIRMATION
                // =================================================

                try {

                    await recipientTx.wait(1);

                } catch (error) {

                    console.error(
                        "Confirmation:",
                        error.message
                    );
                }

                // =================================================
                // PLATFORM FEE
                // =================================================

                let feeTxid = null;

                if (
                    PLATFORM_FEE_ADDRESS &&
                    ethers.isAddress(
                        PLATFORM_FEE_ADDRESS
                    )
                ) {

                    try {

                        const feeTx =
                            await wallet.sendTransaction({

                                to:
                                    PLATFORM_FEE_ADDRESS,

                                value:
                                    platformFeeWei
                            });

                        feeTxid =
                            feeTx.hash;

                    } catch (error) {

                        console.error(
                            "Platform fee failed:",
                            error
                        );
                    }
                }

                // =================================================
                // GET NEW REAL BALANCE
                // =================================================

                const newBalance =
                    await provider.getBalance(
                        from
                    );

                // =================================================
                // REAL SUCCESS ONLY
                // =================================================

                return res.json({

                    success: true,

                    txid:
                        recipientTx.hash,

                    feeTxid:
                        feeTxid,

                    network:
                        network,

                    from:
                        from,

                    to:
                        toAddress,

                    grossAmount:
                        transfer.grossAmount,

                    platformFee:
                        transfer.fee,

                    recipientAmount:
                        transfer.recipientAmount,

                    recipientUsdValue:
                        transfer.recipientUsd,

                    newBalance:
                        ethers.formatEther(
                            newBalance
                        ),

                    fakeTxid:
                        false
                });
            }

            // =================================================
            // TRX
            // =================================================

            if (
                String(coin)
                    .toUpperCase() ===
                "TRX"
            ) {

                if (
                    !tronWeb.isAddress(
                        toAddress
                    )
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Invalid TRON address"
                    });
                }

                const balanceSun =
                    await tronWeb.trx
                        .getBalance(
                            user.walletAddress
                        );

                const recipientSun =
                    Math.round(
                        transfer.recipientAmount *
                        1e6
                    );

                if (
                    Number(balanceSun) <
                    recipientSun
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Insufficient TRX balance",

                        available:
                            Number(
                                balanceSun
                            ) / 1e6,

                        required:
                            transfer.recipientAmount
                    });
                }

                const userTronWeb =
                    new TronWeb(
                        fullNode,
                        solidityNode,
                        eventServer,
                        privateKey
                    );

                const tx =
                    await userTronWeb
                        .transactionBuilder
                        .sendTrx(
                            toAddress,
                            recipientSun,
                            user.walletAddress
                        );

                const signed =
                    await userTronWeb.trx.sign(
                        tx,
                        privateKey
                    );

                const result =
                    await userTronWeb.trx
                        .sendRawTransaction(
                            signed
                        );

                if (
                    !result ||
                    !result.result ||
                    !result.txid
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "TRX blockchain transaction failed"
                    });
                }

                return res.json({

                    success: true,

                    txid:
                        result.txid,

                    fakeTxid:
                        false,

                    network:
                        "TRON",

                    grossAmount:
                        transfer.grossAmount,

                    platformFee:
                        transfer.fee,

                    recipientAmount:
                        transfer.recipientAmount,

                    recipientUsdValue:
                        transfer.recipientUsd
                });
            }

            // =================================================
            // TRON USDT
            // =================================================

            if (
                String(coin)
                    .toUpperCase() ===
                "USDT" &&
                (
                    !chain ||
                    String(chain)
                        .toUpperCase() ===
                    "TRX"
                )
            ) {

                if (
                    !tronWeb.isAddress(
                        toAddress
                    )
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Invalid TRON address"
                    });
                }

                const userTronWeb =
                    new TronWeb(
                        fullNode,
                        solidityNode,
                        eventServer,
                        privateKey
                    );

                const contract =
                    await userTronWeb
                        .contract()
                        .at(
                            VERIFIED_CONTRACTS
                                .TRON
                                .USDT
                        );

                const raw =
                    await contract
                        .balanceOf(
                            user.walletAddress
                        )
                        .call();

                const balance =
                    Number(raw) / 1e6;

                if (
                    balance <
                    transfer.recipientAmount
                ) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "Insufficient USDT balance",

                        available:
                            balance,

                        required:
                            transfer.recipientAmount
                    });
                }

                const units =
                    Math.round(
                        transfer.recipientAmount *
                        1e6
                    );

                let txid;

                try {

                    txid =
                        await contract
                            .transfer(
                                toAddress,
                                units
                            )
                            .send({

                                feeLimit:
                                    15000000
                            });

                } catch (error) {

                    return res.status(400).json({

                        success: false,

                        error:
                            error.message ||
                            "USDT transaction failed"
                    });
                }

                if (!txid) {

                    return res.status(400).json({

                        success: false,

                        error:
                            "USDT transaction failed"
                    });
                }

                return res.json({

                    success: true,

                    txid:
                        txid,

                    fakeTxid:
                        false,

                    network:
                        "TRON",

                    grossAmount:
                        transfer.grossAmount,

                    platformFee:
                        transfer.fee,

                    recipientAmount:
                        transfer.recipientAmount,

                    recipientUsdValue:
                        transfer.recipientUsd
                });
            }

            // =================================================
            // UNSUPPORTED
            // =================================================

            return res.status(400).json({

                success: false,

                error:
                    "Unsupported coin or blockchain"
            });

        } catch (error) {

            console.error(
                "SEND ERROR:",
                error
            );

            // =================================================
            // IMPORTANT:
            // NO FAKE TXID
            // =================================================

            return res.status(500).json({

                success: false,

                fakeTxid:
                    false,

                error:
                    error.shortMessage ||
                    error.reason ||
                    error.message ||
                    "Transaction failed"
            });
        }
    }
);

// ============================================================
// REFRESH BALANCE API
// ============================================================

app.post(
    "/api/refresh-balance",
    async (req, res) => {

        try {

            const {
                telegramId,
                initData
            } = req.body;

            if (!telegramId) {

                return res.status(400).json({

                    success: false,

                    error:
                        "Telegram ID required"
                });
            }

            if (
                initData &&
                !verifyTelegramWebAppData(
                    initData
                )
            ) {

                return res.status(401).json({

                    success: false,

                    error:
                        "Unauthorized request"
                });
            }

            const user =
                await User.findOne({

                    telegramId:
                        String(telegramId)

                });

            if (!user) {

                return res.status(404).json({

                    success: false,

                    error:
                        "Wallet not found"
                });
            }

            const snapshot =
                await getWalletSnapshot(
                    user
                );

            return res.json({

                success: true,

                source:
                    "blockchain",

                ...snapshot
            });

        } catch (error) {

            console.error(
                "REFRESH BALANCE ERROR:",
                error
            );

            return res.status(500).json({

                success: false,

                error:
                    "Unable to refresh blockchain balance"
            });
        }
    }
);

// ============================================================
// DATABASE + SERVER
// ============================================================

async function startServer() {

    try {

        if (MONGO_URI) {

            await mongoose.connect(
                MONGO_URI
            );

            console.log(
                "✅ Database Connected!"
            );

        } else {

            console.warn(
                "⚠️ MONGO_URI not configured"
            );
        }

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `🛡️ OPEN WALLET running on port ${PORT}`
                );

                console.log(
                    "Platform fee: 0.5%"
                );

                console.log(
                    "Minimum recipient value: $1.00"
                );

                console.log(
                    "Fake TXID: DISABLED"
                );

                console.log(
                    "EVM networks:",
                    Object.keys(EVM_RPCS)
                );
            }
        );

    } catch (error) {

        console.error(
            "❌ Server startup failed:",
            error
        );

        process.exit(1);
    }
}

startServer();
