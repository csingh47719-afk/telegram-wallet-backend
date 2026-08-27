// server.js
// OPEN WALLET - Safe Non-Custodial Backend

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { ethers } = require("ethers");
const TronWebModule = require("tronweb");
const { Connection, PublicKey } = require("@solana/web3.js");

const TronWeb = TronWebModule.TronWeb || TronWebModule;

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const MONGO_URI = process.env.MONGO_URI || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TRONGRID_API_KEY = (process.env.TRONGRID_API_KEY || "").trim();

const PLATFORM_FEE_PERCENT = 0.5;
const MIN_RECEIVE_USD = 1;

/* =========================================================
   FEE ADDRESSES
========================================================= */

const FEE_ADDRESSES = {
  ETHEREUM: process.env.FEE_ADDRESS_ETHEREUM || "",
  TRON: process.env.FEE_ADDRESS_TRON || "",
  BITCOIN: process.env.FEE_ADDRESS_BITCOIN || "",
  SOLANA: process.env.FEE_ADDRESS_SOLANA || ""
};

/* =========================================================
   NETWORKS
========================================================= */

const EVM_NETWORKS = {
  ETH: {
    name: "Ethereum Mainnet",
    chainId: 1,
    rpc:
      process.env.ETH_RPC ||
      "https://ethereum-rpc.publicnode.com",
    usdt:
      process.env.ETH_USDT_CONTRACT ||
      "0xdAC17F958D2ee523a2206206994597C13D831ec7"
  },

  OPTIMISM: {
    name: "Optimism",
    chainId: 10,
    rpc:
      process.env.OPTIMISM_RPC ||
      "https://optimism-rpc.publicnode.com",
    usdt: process.env.OPTIMISM_USDT_CONTRACT || ""
  },

  ARBITRUM: {
    name: "Arbitrum One",
    chainId: 42161,
    rpc:
      process.env.ARBITRUM_RPC ||
      "https://arbitrum-one-rpc.publicnode.com",
    usdt:
      process.env.ARBITRUM_USDT_CONTRACT ||
      "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"
  },

  BASE: {
    name: "Base",
    chainId: 8453,
    rpc:
      process.env.BASE_RPC ||
      "https://base-rpc.publicnode.com",
    usdt: process.env.BASE_USDT_CONTRACT || ""
  }
};

const TRON_USDT_CONTRACT =
  process.env.TRON_USDT_CONTRACT ||
  "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const SOLANA_RPC =
  process.env.SOLANA_RPC ||
  "https://api.mainnet-beta.solana.com";

const BITCOIN_API =
  process.env.BITCOIN_API ||
  "https://blockstream.info/api";

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  express.json({
    limit: "20kb"
  })
);

app.use(
  cors({
    origin: "*"
  })
);

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

    addresses: {
      tron: {
        type: String,
        required: true
      },

      evm: {
        type: String,
        required: true
      },

      solana: {
        type: String,
        required: true
      },

      bitcoin: {
        type: String,
        required: true
      }
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
   TELEGRAM AUTH
========================================================= */

function verifyTelegramWebAppData(initData) {
  if (!initData || !BOT_TOKEN) {
    return false;
  }

  try {
    const params = new URLSearchParams(initData);

    const receivedHash = params.get("hash");

    if (!receivedHash) {
      return false;
    }

    params.delete("hash");

    const dataCheckArr = [];

    for (const [key, value] of params.entries()) {
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

    if (calculatedHash.length !== receivedHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "utf8"),
      Buffer.from(receivedHash, "utf8")
    );
  } catch (error) {
    console.error(
      "Telegram verification error:",
      error.message
    );

    return false;
  }
}

function getTelegramUserId(initData) {
  try {
    const params = new URLSearchParams(initData);

    const userJson = params.get("user");

    if (!userJson) {
      return null;
    }

    const user = JSON.parse(userJson);

    if (!user.id) {
      return null;
    }

    return String(user.id);
  } catch {
    return null;
  }
}

function authenticateTelegramRequest(
  telegramId,
  initData
) {
  if (!telegramId || !initData || !BOT_TOKEN) {
    return false;
  }

  if (!verifyTelegramWebAppData(initData)) {
    return false;
  }

  const verifiedId = getTelegramUserId(initData);

  return (
    verifiedId !== null &&
    verifiedId === String(telegramId)
  );
}

/* =========================================================
   VALIDATION
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

function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function isValidAmount(value) {
  const s = String(value ?? "").trim();

  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) {
    return false;
  }

  const n = Number(s);

  return Number.isFinite(n) && n > 0;
}

/* =========================================================
   WALLET GENERATION
========================================================= */

function createEvmWallet() {
  return ethers.Wallet.createRandom();
}

async function createUser(telegramId) {
  const existing = await User.findOne({
    telegramId: String(telegramId)
  });

  if (existing) {
    return existing;
  }

  /*
   * IMPORTANT:
   * The private key is NOT stored on this server.
   *
   * In a production non-custodial wallet,
   * key generation/signing should happen client-side.
   */

  const evmWallet = createEvmWallet();

  /*
   * This address is only returned as an address record.
   * The corresponding private key must remain with the user.
   *
   * For a production wallet, replace this with
   * client-side wallet generation.
   */

  const tronAccount = await tronWeb.createAccount();

  const solana = PublicKey.unique
    ? PublicKey.unique()
    : null;

  const user = new User({
    telegramId: String(telegramId),

    addresses: {
      tron: tronAccount.address.base58,
      evm: evmWallet.address,
      solana: solana
        ? solana.toBase58()
        : "",
      bitcoin: ""
    }
  });

  await user.save();

  return user;
}

/* =========================================================
   PROVIDERS
========================================================= */

function getEvmProvider(networkKey) {
  const key = String(networkKey || "").toUpperCase();

  const network = EVM_NETWORKS[key];

  if (!network) {
    throw new Error("Unsupported EVM network");
  }

  return new ethers.JsonRpcProvider(
    network.rpc,
    {
      name: network.name,
      chainId: network.chainId
    },
    {
      staticNetwork: true
    }
  );
}

function getSolanaConnection() {
  return new Connection(
    SOLANA_RPC,
    "confirmed"
  );
}

/* =========================================================
   BALANCES
========================================================= */

async function getTronBalances(address) {
  let trx = 0;
  let usdt = 0;

  try {
    const balance =
      await tronWeb.trx.getBalance(address);

    trx = Number(balance) / 1e6;
  } catch (error) {
    console.error(
      "TRX balance error:",
      error.message
    );
  }

  try {
    const contract =
      await tronWeb.contract().at(
        TRON_USDT_CONTRACT
      );

    const raw =
      await contract
        .balanceOf(address)
        .call();

    usdt =
      Number(raw.toString()) / 1e6;
  } catch (error) {
    console.error(
      "TRC20 USDT balance error:",
      error.message
    );
  }

  return {
    trx,
    usdt
  };
}

async function getEvmNativeBalance(
  networkKey,
  address
) {
  const provider =
    getEvmProvider(networkKey);

  const balance =
    await provider.getBalance(address);

  return Number(
    ethers.formatEther(balance)
  );
}

async function getEvmUsdtBalance(
  networkKey,
  address
) {
  const network =
    EVM_NETWORKS[
      String(networkKey).toUpperCase()
    ];

  if (!network || !network.usdt) {
    return 0;
  }

  const provider =
    getEvmProvider(networkKey);

  const abi = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
  ];

  const contract =
    new ethers.Contract(
      network.usdt,
      abi,
      provider
    );

  const [raw, decimals] =
    await Promise.all([
      contract.balanceOf(address),
      contract.decimals()
    ]);

  return Number(
    ethers.formatUnits(
      raw,
      decimals
    )
  );
}

async function getBitcoinBalance(address) {
  if (!address) {
    return 0;
  }

  try {
    const response = await fetch(
      `${BITCOIN_API}/address/${encodeURIComponent(
        address
      )}`
    );

    if (!response.ok) {
      throw new Error(
        `Bitcoin API HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const funded =
      Number(
        data.chain_stats?.funded_txo_sum || 0
      );

    const spent =
      Number(
        data.chain_stats?.spent_txo_sum || 0
      );

    return (funded - spent) / 1e8;
  } catch (error) {
    console.error(
      "Bitcoin balance error:",
      error.message
    );

    return 0;
  }
}

/* =========================================================
   WALLET API
========================================================= */

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
          error: "Telegram ID required"
        });
      }

      if (
        !authenticateTelegramRequest(
          telegramId,
          initData
        )
      ) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized request"
        });
      }

      const user =
        await createUser(telegramId);

      const tronBalances =
        await getTronBalances(
          user.addresses.tron
        );

      const evmBalances = {};
      const usdtBalances = {};

      for (
        const networkKey of Object.keys(
          EVM_NETWORKS
        )
      ) {
        try {
          evmBalances[networkKey] =
            await getEvmNativeBalance(
              networkKey,
              user.addresses.evm
            );
        } catch (error) {
          evmBalances[networkKey] = 0;
        }

        try {
          usdtBalances[networkKey] =
            await getEvmUsdtBalance(
              networkKey,
              user.addresses.evm
            );
        } catch (error) {
          usdtBalances[networkKey] = 0;
        }
      }

      let sol = 0;

      try {
        if (user.addresses.solana) {
          const lamports =
            await getSolanaConnection()
              .getBalance(
                new PublicKey(
                  user.addresses.solana
                )
              );

          sol = lamports / 1e9;
        }
      } catch (error) {
        console.error(
          "SOL balance error:",
          error.message
        );
      }

      const btc =
        await getBitcoinBalance(
          user.addresses.bitcoin
        );

      return res.json({
        success: true,

        addresses: {
          TRX: user.addresses.tron,
          USDT_TRON: user.addresses.tron,

          ETH: user.addresses.evm,
          USDT_ETH: user.addresses.evm,
          OPTIMISM: user.addresses.evm,
          ARBITRUM: user.addresses.evm,
          BASE: user.addresses.evm,

          SOL: user.addresses.solana,
          BTC: user.addresses.bitcoin
        },

        verifiedBalances: {
          trx: Number(
            tronBalances.trx.toFixed(6)
          ),

          usdt_tron: Number(
            tronBalances.usdt.toFixed(6)
          ),

          eth: Number(
            (evmBalances.ETH || 0).toFixed(8)
          ),

          usdt_eth: Number(
            (usdtBalances.ETH || 0).toFixed(6)
          ),

          optimism: Number(
            (evmBalances.OPTIMISM || 0).toFixed(8)
          ),

          arbitrum: Number(
            (evmBalances.ARBITRUM || 0).toFixed(8)
          ),

          base: Number(
            (evmBalances.BASE || 0).toFixed(8)
          ),

          btc: Number(
            btc.toFixed(8)
          ),

          sol: Number(
            sol.toFixed(9)
          )
        },

        platformFee: {
          sendPercent:
            PLATFORM_FEE_PERCENT,

          swipePercent: 0,
          swapPercent: 0,

          addresses:
            FEE_ADDRESSES
        }
      });
    } catch (error) {
      console.error(
        "Wallet API error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "On-chain balance query failed"
      });
    }
  }
);

/* =========================================================
   SEND PREPARATION
========================================================= */

app.post(
  "/api/send/prepare",
  async (req, res) => {
    try {
      const {
        telegramId,
        initData,
        toAddress,
        amount,
        chain,
        asset
      } = req.body;

      if (!telegramId) {
        return res.status(400).json({
          success: false,
          error: "Telegram ID required"
        });
      }

      if (
        !authenticateTelegramRequest(
          telegramId,
          initData
        )
      ) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized request"
        });
      }

      if (!toAddress) {
        return res.status(400).json({
          success: false,
          error:
            "Recipient address required"
        });
      }

      if (!isValidAmount(amount)) {
        return res.status(400).json({
          success: false,
          error: "Invalid amount"
        });
      }

      const normalizedChain =
        String(chain || "").toUpperCase();

      const normalizedAsset =
        String(asset || "").toUpperCase();

      /*
       * 0.5% fee
       */
      const gross = Number(amount);

      const fee =
        gross * (PLATFORM_FEE_PERCENT / 100);

      const receive =
        gross - fee;

      if (receive <= 0) {
        throw new Error(
          "Amount is too small after fee"
        );
      }

      if (normalizedAsset === "ETH") {
        if (
          !EVM_NETWORKS[
            normalizedChain
          ]
        ) {
          throw new Error(
            "Unsupported EVM network"
          );
        }

        if (
          !isValidEvmAddress(
            toAddress
          )
        ) {
          throw new Error(
            "Invalid EVM recipient address"
          );
        }
      }

      if (normalizedAsset === "TRX") {
        if (
          normalizedChain !== "TRON"
        ) {
          throw new Error(
            "Invalid TRON network"
          );
        }

        if (
          !isValidTronAddress(
            toAddress
          )
        ) {
          throw new Error(
            "Invalid TRON recipient address"
          );
        }
      }

      if (normalizedAsset === "SOL") {
        if (
          normalizedChain !== "SOLANA"
        ) {
          throw new Error(
            "Invalid Solana network"
          );
        }

        if (
          !isValidSolanaAddress(
            toAddress
          )
        ) {
          throw new Error(
            "Invalid Solana recipient address"
          );
        }
      }

      return res.json({
        success: true,

        signingRequired: true,

        chain:
          normalizedChain,

        asset:
          normalizedAsset,

        recipient:
          toAddress,

        grossAmount:
          String(amount),

        platformFee:
          fee.toFixed(8),

        receiveAmount:
          receive.toFixed(8),

        platformFeePercent:
          PLATFORM_FEE_PERCENT,

        feeAddress:
          FEE_ADDRESSES,

        message:
          "Transaction prepared. Sign it with the user's wallet."
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error.message ||
          "Transaction preparation failed"
      });
    }
  }
);

/* =========================================================
   SWAP
========================================================= */

app.post(
  "/api/swipe-swap/prepare",
  async (req, res) => {
    try {
      const {
        telegramId,
        initData
      } = req.body;

      if (
        !authenticateTelegramRequest(
          telegramId,
          initData
        )
      ) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized request"
        });
      }

      return res.json({
        success: true,
        platformFeePercent: 0,
        platformFee: 0,
        networkFeeOnly: true,
        signingRequired: true,
        message:
          "A DEX route must be selected and signed by the user's wallet."
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error:
          error.message ||
          "Swap preparation failed"
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "OPEN WALLET",
    status: "LIVE",
    version: "4.0.0",
    fakeTxid: false,
    custodialPrivateKeys: false,
    platformFee:
      "0.5% on Send; 0% on Swipe/Swap"
  });
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found"
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error
    );

    res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    if (!MONGO_URI) {
      throw new Error(
        "MONGO_URI is missing"
      );
    }

    if (!BOT_TOKEN) {
      throw new Error(
        "BOT_TOKEN is missing"
      );
    }

    await mongoose.connect(
      MONGO_URI
    );

    console.log(
      "MongoDB connected"
    );

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `OPEN WALLET server running on port ${PORT}`
        );

        console.log(
          "Platform fee: 0.5%"
        );

        console.log(
          "Swipe/Swap fee: 0%"
        );

        console.log(
          "Custodial private keys: DISABLED"
        );
      }
    );
  } catch (error) {
    console.error(
      "Server startup failed:",
      error.message
    );

    process.exit(1);
  }
}

startServer();
