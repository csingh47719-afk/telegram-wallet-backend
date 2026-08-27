const express = require("express");
const mongoose = require("mongoose");
const TronWebModule = require("tronweb");
const TronWeb = TronWebModule.TronWeb || TronWebModule;
const { ethers } = require("ethers");
const CryptoJS = require("crypto-js");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { ECPairFactory } = require("ecpair");
const {
Connection,
PublicKey,
Keypair,
SystemProgram,
Transaction,
sendAndConfirmTransaction
} = require("@solana/web3.js");

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

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
const TRONGRID_API_KEY = (process.env.TRONGRID_API_KEY || "").trim();

const PLATFORM_FEE_PERCENT = 0.005; // 0.5%
const MIN_RECEIVE_USD = 1.00;

/*

These may be overridden by environment variables.

Do not put private keys/secrets in source code.
*/
const FEE_ADDRESSES = {
ETHEREUM:
process.env.FEE_ADDRESS_ETHEREUM ||
"0x3e0ad2f060bacb9da968bf4321fda71bc29d014b",
TRON:
process.env.FEE_ADDRESS_TRON ||
"TLmgAsP4r8ckuGyRN8S65dtpL1cJaWC62R",
BITCOIN:
process.env.FEE_ADDRESS_BITCOIN ||
"bc1qdhsgcdq58kd70m687c5xnfl0ntxprcejzzj577",
SOLANA:
process.env.FEE_ADDRESS_SOLANA ||
"7wqydLqn2skKNZjrSvYPGooGjoM9vf9FpWNaiNE6KKwd"
};


const EVM_NETWORKS = {
ETH: {
name: "Ethereum Mainnet",
chainId: 1,
rpc: process.env.ETH_RPC || "https://ethereum-rpc.publicnode.com",
usdt:
process.env.ETH_USDT_CONTRACT ||
"0xdAC17F958D2ee523a2206206994597C13D831ec7"
},
OPTIMISM: {
name: "Optimism",
chainId: 10,
rpc: process.env.OPTIMISM_RPC || "https://optimism-rpc.publicnode.com",
usdt:
process.env.OPTIMISM_USDT_CONTRACT ||
""
},
ARBITRUM: {
name: "Arbitrum One",
chainId: 42161,
rpc: process.env.ARBITRUM_RPC || "https://arbitrum-one-rpc.publicnode.com",
usdt:
process.env.ARBITRUM_USDT_CONTRACT ||
"0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"
},
BASE: {
name: "Base",
chainId: 8453,
rpc: process.env.BASE_RPC || "https://base-rpc.publicnode.com",
usdt:
process.env.BASE_USDT_CONTRACT ||
"0x0000000000000000000000000000000000000000"
}
};

/*

IMPORTANT:

Verify every token contract address before enabling that network.

The Base value above is deliberately disabled until a verified

USDT contract is supplied through BASE_USDT_CONTRACT.
*/


const VERIFIED_CONTRACTS = {
TRON: {
USDT:
process.env.TRON_USDT_CONTRACT ||
"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
}
};

const SOLANA_RPC =
process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

const BITCOIN_NETWORK = bitcoin.networks.bitcoin;
const BLOCKSTREAM_API =
process.env.BLOCKSTREAM_API || "https://blockstream.info/api";

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
{ versionKey: false }
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
return CryptoJS.AES.encrypt(
privateKey,
getEncryptionKey()
).toString();
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
TELEGRAM AUTH
========================================================= */

function verifyTelegramWebAppData(initData) {
if (!initData || !BOT_TOKEN) return false;

try {
const urlParams = new URLSearchParams(initData);
const receivedHash = urlParams.get("hash");

if (!receivedHash) return false;  

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

function getTelegramUserIdFromInitData(initData) {
try {
const params = new URLSearchParams(initData);
const userJson = params.get("user");

if (!userJson) return null;  

const telegramUser = JSON.parse(userJson);  

if (!telegramUser.id) return null;  

return String(telegramUser.id);

} catch {
return null;
}
}

function authenticateTelegramRequest(telegramId, initData) {
if (!BOT_TOKEN) return false;

if (!initData) return false;

if (!verifyTelegramWebAppData(initData)) {
return false;
}

const verifiedTelegramId =
getTelegramUserIdFromInitData(initData);

return (
!!verifiedTelegramId &&
verifiedTelegramId === String(telegramId)
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

function isValidBitcoinAddress(address) {
try {
bitcoin.address.toOutputScript(
address,
BITCOIN_NETWORK
);
return true;
} catch {
return false;
}
}

function parsePositiveDecimal(value, name) {
const s = String(value ?? "").trim();

if (!/^(?:\d+.?\d*|.\d+)$/.test(s)) {
throw new Error(Invalid ${name});
}

const n = Number(s);

if (!Number.isFinite(n) || n <= 0) {
throw new Error(Invalid ${name});
}

return n;
}

/* =========================================================
WALLET DERIVATION
========================================================= */

function deriveEvmWalletFromTronPrivateKey(tronPrivateKey) {
const hash = CryptoJS.SHA256(
"OPEN_WALLET_EVM_V2:" + tronPrivateKey
).toString(CryptoJS.enc.Hex);

return new ethers.Wallet("0x" + hash);
}

function deriveSolanaKeypairFromTronPrivateKey(tronPrivateKey) {
const hash = crypto
.createHash("sha256")
.update(
"OPEN_WALLET_SOLANA_V1:" +
tronPrivateKey
)
.digest();

return Keypair.fromSeed(new Uint8Array(hash));
}

function deriveBitcoinKeyPairFromTronPrivateKey(tronPrivateKey) {
const hash = crypto
.createHash("sha256")
.update(
"OPEN_WALLET_BITCOIN_V1:" +
tronPrivateKey
)
.digest();

return ECPair.fromPrivateKey(hash, {
compressed: true,
network: BITCOIN_NETWORK
});
}

function deriveBitcoinAddress(tronPrivateKey) {
const keyPair =
deriveBitcoinKeyPairFromTronPrivateKey(
tronPrivateKey
);

return bitcoin.payments.p2wpkh({
pubkey: Buffer.from(keyPair.publicKey),
network: BITCOIN_NETWORK
}).address;
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
{ staticNetwork: true }
);
}

function getSolanaConnection() {
return new Connection(
SOLANA_RPC,
"confirmed"
);
}

/* =========================================================
PRICE
========================================================= */

async function getUsdPrice(coin) {
const symbol =
String(coin || "").toUpperCase();

if (symbol === "USDT") return 1;

let id = "";

if (symbol === "ETH") id = "ethereum";
else if (symbol === "TRX") id = "tron";
else if (symbol === "BTC") id = "bitcoin";
else if (symbol === "SOL") id = "solana";
else {
throw new Error("Unsupported price asset");
}

const url =
"https://api.coingecko.com/api/v3/simple/price" +
?ids=${encodeURIComponent(id)} +
"&vs_currencies=usd";

const response = await fetch(url);

if (!response.ok) {
throw new Error(
Price API failed: HTTP ${response.status}
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
const sun =
await tronWeb.trx.getBalance(address);

trx = Number(sun) / 1e6;

} catch (error) {
console.error(
"TRX balance error:",
error.message
);
}

try {
const contract =
await tronWeb
.contract()
.at(VERIFIED_CONTRACTS.TRON.USDT);

const raw =  
  await contract.balanceOf(address).call();  

usdt =  
  Number(raw.toString()) / 1e6;

} catch (error) {
console.error(
"USDT balance error:",
error.message
);
}

return { trx, usdt };
}

/* =========================================================
EVM BALANCES
========================================================= */

async function getEvmBalance(
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

async function getErc20Balance(
networkKey,
address
) {
const network =
EVM_NETWORKS[
String(networkKey).toUpperCase()
];

if (!network || !network.usdt) {
throw new Error(
"Unsupported EVM network"
);
}

if (
network.usdt ===
"0x0000000000000000000000000000000000000000"
) {
throw new Error(
"USDT contract is not configured for this network"
);
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
ethers.formatUnits(raw, decimals)
);
}

/* =========================================================
USER
========================================================= */

async function getOrCreateUser(telegramId) {
const id = String(telegramId);

let user =
await User.findOne({
telegramId: id
});

if (user) return user;

const tronAccount =
await tronWeb.createAccount();

user = new User({
telegramId: id,
walletAddress:
tronAccount.address.base58,
encryptedPrivateKey:
encryptKey(
tronAccount.privateKey
)
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
version: "3.0.0",
fakeTxid: false,
platformFee: "0.5% on Send; 0% on Swipe/Swap"
});
});

/* =========================================================
WALLET
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
  await getOrCreateUser(  
    telegramId  
  );  

const tronPrivateKey =  
  decryptKey(  
    user.encryptedPrivateKey  
  );  

const evmWallet =  
  deriveEvmWalletFromTronPrivateKey(  
    tronPrivateKey  
  );  

const solanaKeypair =  
  deriveSolanaKeypairFromTronPrivateKey(  
    tronPrivateKey  
  );  

const bitcoinAddress =  
  deriveBitcoinAddress(  
    tronPrivateKey  
  );  

const tronBalances =  
  await getTronBalances(  
    user.walletAddress  
  );  

const evmBalances = {};  
const evmUsdtBalances = {};  

for (  
  const networkKey of Object.keys(  
    EVM_NETWORKS  
  )  
) {  
  try {  
    evmBalances[networkKey] =  
      await getEvmBalance(  
        networkKey,  
        evmWallet.address  
      );  
  } catch {  
    evmBalances[networkKey] = 0;  
  }  

  try {  
    evmUsdtBalances[networkKey] =  
      await getErc20Balance(  
        networkKey,  
        evmWallet.address  
      );  
  } catch {  
    evmUsdtBalances[networkKey] = 0;  
  }  
}  

let solBalance = 0;  

try {  
  const lamports =  
    await getSolanaConnection()  
      .getBalance(  
        solanaKeypair.publicKey  
      );  

  solBalance =  
    lamports / 1e9;  
} catch (error) {  
  console.error(  
    "SOL balance error:",  
    error.message  
  );  
}  

return res.json({  
  success: true,  

  address:  
    user.walletAddress,  

  addresses: {  
    TRX: user.walletAddress,  
    USDT_TRON: user.walletAddress,  

    ETH: evmWallet.address,  
    USDT_ETH: evmWallet.address,  

    BTC: bitcoinAddress,  

    SOL:  
      solanaKeypair.publicKey.toBase58()  
  },  

  verifiedBalances: {  
    trx: Number(  
      tronBalances.trx.toFixed(6)  
    ),  
    usdt_tron: Number(  
      tronBalances.usdt.toFixed(6)  
    ),  

    eth: Number(  
      (evmBalances.ETH || 0)  
        .toFixed(8)  
    ),  
    usdt_eth: Number(  
      (evmUsdtBalances.ETH || 0)  
        .toFixed(6)  
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
    sol: Number(  
      solBalance.toFixed(9)  
    )  
  },  

  platformFee: {  
    sendPercent: 0.5,  
    swipePercent: 0,  
    swapPercent: 0,  

    addresses: FEE_ADDRESSES  
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
    "On-chain balance query failed",  
  fakeTxid: false  
});

}
});

/* =========================================================
FEE CALCULATION
========================================================= */

function calculateFeeUnits(grossUnits) {
const fee =
grossUnits * 5n / 1000n;

const receive =
grossUnits - fee;

if (fee <= 0n || receive <= 0n) {
throw new Error(
"Amount is too small after 0.5% fee"
);
}

return {
feeUnits: fee,
receiveUnits: receive
};
}

/* =========================================================
EVM NATIVE SEND
ETH / OPTIMISM / ARBITRUM / BASE
========================================================= */

async function processEvmNativeTransfer(
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
FEE_ADDRESSES.ETHEREUM.toLowerCase()
) {
throw new Error(
"Recipient cannot be the platform fee address"
);
}

const grossWei =
ethers.parseEther(
String(grossAmount)
);

const {
feeUnits: feeWei,
receiveUnits: receiveWei
} = calculateFeeUnits(grossWei);

const ethUsd =
await getUsdPrice("ETH");

const receiveAmount =
Number(
ethers.formatEther(
receiveWei
)
);

const receiveUsd =
receiveAmount * ethUsd;

if (receiveUsd < MIN_RECEIVE_USD) {
throw new Error(
After 0.5% fee, recipient must receive at least $1.00 USD. Current value: $${receiveUsd.toFixed(2)}
);
}

const provider =
getEvmProvider(networkKey);

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const wallet =
deriveEvmWalletFromTronPrivateKey(
tronPrivateKey
).connect(provider);

const balance =
await provider.getBalance(
wallet.address
);

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

const recipientGas =
await provider.estimateGas({
from: wallet.address,
to: toAddress,
value: receiveWei
});

const platformGas =
await provider.estimateGas({
from: wallet.address,
to: FEE_ADDRESSES.ETHEREUM,
value: feeWei
});

const totalGas =
recipientGas + platformGas;

const gasCost =
totalGas * gasPrice;

if (
balance <
grossWei + gasCost
) {
throw new Error(
"Insufficient native coin balance for amount + 0.5% fee + network gas"
);
}

/*

IMPORTANT:

Two real blockchain transactions are required:

1. recipient payment



2. platform fee



If #2 fails after #1 succeeds, the response explicitly

reports partialSuccess. No fake fee TXID is ever created.
*/


const recipientTx =
await wallet.sendTransaction({
to: toAddress,
value: receiveWei,
gasLimit: recipientGas
});

const recipientReceipt =
await recipientTx.wait();

if (
!recipientReceipt ||
recipientReceipt.status !== 1
) {
throw new Error(
"Recipient transaction was not confirmed"
);
}

try {
const feeTx =
await wallet.sendTransaction({
to: FEE_ADDRESSES.ETHEREUM,
value: feeWei,
gasLimit: platformGas
});

const feeReceipt =  
  await feeTx.wait();  

if (  
  !feeReceipt ||  
  feeReceipt.status !== 1  
) {  
  throw new Error(  
    "Platform fee transaction was not confirmed"  
  );  
}  

return {  
  success: true,  
  partialSuccess: false,  
  fakeTxid: false,  
  chain: networkKey,  
  asset: "NATIVE",  
  grossAmount: String(grossAmount),  
  feeAmount:  
    ethers.formatEther(feeWei),  
  receiveAmount:  
    ethers.formatEther(receiveWei),  
  recipientTxid:  
    recipientTx.hash,  
  feeTxid:  
    feeTx.hash,  
  feePending: false,  
  feeAddress:  
    FEE_ADDRESSES.ETHEREUM  
};

} catch (feeError) {
console.error(
"Platform fee failed:",
feeError.message
);

return {  
  success: false,  
  partialSuccess: true,  
  fakeTxid: false,  
  chain: networkKey,  
  asset: "NATIVE",  
  recipientTxid:  
    recipientTx.hash,  
  feeTxid: null,  
  feePending: true,  
  error:  
    "Recipient transfer was confirmed, but platform fee transfer was not confirmed.",  
  feeAddress:  
    FEE_ADDRESSES.ETHEREUM  
};

}
}

/* =========================================================
EVM USDT ERC20 SEND
========================================================= */

async function processEvmUsdtTransfer(
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
network.usdt ===
"0x0000000000000000000000000000000000000000"
) {
throw new Error(
"USDT contract is not configured for this network"
);
}

const amountString =
String(grossAmount);

const provider =
getEvmProvider(networkKey);

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const wallet =
deriveEvmWalletFromTronPrivateKey(
tronPrivateKey
).connect(provider);

const tokenAbi = [
"function transfer(address to,uint256 value) returns (bool)",
"function balanceOf(address owner) view returns (uint256)",
"function decimals() view returns (uint8)"
];

const token =
new ethers.Contract(
network.usdt,
tokenAbi,
wallet
);

const decimals =
await token.decimals();

const grossUnits =
ethers.parseUnits(
amountString,
decimals
);

const {
feeUnits,
receiveUnits
} = calculateFeeUnits(
grossUnits
);

const receiveAmount =
Number(
ethers.formatUnits(
receiveUnits,
decimals
)
);

if (receiveAmount < MIN_RECEIVE_USD) {
throw new Error(
After 0.5% fee, recipient must receive at least $1.00 USDT. Current value: $${receiveAmount.toFixed(2)}
);
}

const tokenBalance =
await token.balanceOf(
wallet.address
);

if (
tokenBalance <
grossUnits
) {
throw new Error(
"Insufficient USDT balance"
);
}

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

const recipientTxRequest =
await token.transfer.populateTransaction(
toAddress,
receiveUnits
);

const feeTxRequest =
await token.transfer.populateTransaction(
FEE_ADDRESSES.ETHEREUM,
feeUnits
);

const recipientGas =
await provider.estimateGas({
...recipientTxRequest,
from: wallet.address
});

const feeGas =
await provider.estimateGas({
...feeTxRequest,
from: wallet.address
});

const nativeBalance =
await provider.getBalance(
wallet.address
);

const gasCost =
(recipientGas + feeGas) *
gasPrice;

if (nativeBalance < gasCost) {
throw new Error(
"Insufficient native coin for ERC20 network gas"
);
}

const recipientTx =
await token.transfer(
toAddress,
receiveUnits,
{ gasLimit: recipientGas }
);

const recipientReceipt =
await recipientTx.wait();

if (
!recipientReceipt ||
recipientReceipt.status !== 1
) {
throw new Error(
"USDT recipient transaction was not confirmed"
);
}

try {
const feeTx =
await token.transfer(
FEE_ADDRESSES.ETHEREUM,
feeUnits,
{ gasLimit: feeGas }
);

const feeReceipt =  
  await feeTx.wait();  

if (  
  !feeReceipt ||  
  feeReceipt.status !== 1  
) {  
  throw new Error(  
    "USDT platform fee transaction was not confirmed"  
  );  
}  

return {  
  success: true,  
  partialSuccess: false,  
  fakeTxid: false,  
  chain: networkKey,  
  asset: "USDT",  
  grossAmount: amountString,  
  feeAmount:  
    ethers.formatUnits(  
      feeUnits,  
      decimals  
    ),  
  receiveAmount:  
    ethers.formatUnits(  
      receiveUnits,  
      decimals  
    ),  
  recipientTxid:  
    recipientTx.hash,  
  feeTxid:  
    feeTx.hash,  
  feePending: false,  
  feeAddress:  
    FEE_ADDRESSES.ETHEREUM,  
  contract:  
    network.usdt  
};

} catch (feeError) {
console.error(
"USDT platform fee failed:",
feeError.message
);

return {  
  success: false,  
  partialSuccess: true,  
  fakeTxid: false,  
  chain: networkKey,  
  asset: "USDT",  
  recipientTxid:  
    recipientTx.hash,  
  feeTxid: null,  
  feePending: true,  
  error:  
    "USDT recipient transfer was confirmed, but platform fee transfer was not confirmed.",  
  feeAddress:  
    FEE_ADDRESSES.ETHEREUM,  
  contract:  
    network.usdt  
};

}
}

/* =========================================================
TRON NATIVE TRX SEND
========================================================= */

async function processTrxTransfer(
user,
toAddress,
grossAmount
) {
if (!isValidTronAddress(toAddress)) {
throw new Error(
"Invalid TRON recipient address"
);
}

if (
toAddress ===
FEE_ADDRESSES.TRON
) {
throw new Error(
"Recipient cannot be the platform fee address"
);
}

const grossSun =
tronWeb.toSun(
String(grossAmount)
);

const {
feeUnits: feeSun,
receiveUnits: receiveSun
} = calculateFeeUnits(
BigInt(grossSun)
);

const receiveAmount =
Number(receiveSun) / 1e6;

const trxUsd =
await getUsdPrice("TRX");

if (
receiveAmount * trxUsd <
MIN_RECEIVE_USD
) {
throw new Error(
"After 0.5% fee, recipient must receive at least $1.00 USD"
);
}

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const sender =
tronWeb.address.fromPrivateKey(
tronPrivateKey
);

const balance =
await tronWeb.trx.getBalance(
sender
);

/*

Build and broadcast recipient transaction.

Fee transaction is a separate real TRX transaction.
*/


const recipientTx =
await tronWeb.transactionBuilder.sendTrx(
toAddress,
Number(receiveSun),
sender
);

const signedRecipient =
await tronWeb.trx.sign(
recipientTx,
tronPrivateKey
);

const broadcastRecipient =
await tronWeb.trx.sendRawTransaction(
signedRecipient
);

if (
!broadcastRecipient.result
) {
throw new Error(
"TRX recipient transaction was not broadcast successfully"
);
}

const recipientConfirmed =
await waitForTronConfirmation(
broadcastRecipient.txid
);

if (!recipientConfirmed) {
throw new Error(
"TRX recipient transaction was not confirmed"
);
}

try {
const feeTx =
await tronWeb.transactionBuilder.sendTrx(
FEE_ADDRESSES.TRON,
Number(feeSun),
sender
);

const signedFee =  
  await tronWeb.trx.sign(  
    feeTx,  
    tronPrivateKey  
  );  

const broadcastFee =  
  await tronWeb.trx.sendRawTransaction(  
    signedFee  
  );  

if (!broadcastFee.result) {  
  throw new Error(  
    "TRON fee transaction was not broadcast successfully"  
  );  
}  

const feeConfirmed =  
  await waitForTronConfirmation(  
    broadcastFee.txid  
  );  

if (!feeConfirmed) {  
  throw new Error(  
    "TRON fee transaction was not confirmed"  
  );  
}  

return {  
  success: true,  
  partialSuccess: false,  
  fakeTxid: false,  
  chain: "TRON",  
  asset: "TRX",  
  grossAmount: String(grossAmount),  
  feeAmount:  
    Number(feeSun) / 1e6,  
  receiveAmount,  
  recipientTxid:  
    broadcastRecipient.txid,  
  feeTxid:  
    broadcastFee.txid,  
  feePending: false,  
  feeAddress:  
    FEE_ADDRESSES.TRON  
};

} catch (error) {
return {
success: false,
partialSuccess: true,
fakeTxid: false,
chain: "TRON",
asset: "TRX",
recipientTxid:
broadcastRecipient.txid,
feeTxid: null,
feePending: true,
error:
"TRX recipient transfer was confirmed, but platform fee transfer was not confirmed.",
feeAddress:
FEE_ADDRESSES.TRON
};
}
}

async function waitForTronConfirmation(
txid,
timeoutMs = 120000
) {
const started =
Date.now();

while (
Date.now() - started <
timeoutMs
) {
try {
const info =
await tronWeb.trx.getTransactionInfo(
txid
);

if (  
    info &&  
    info.id === txid  
  ) {  
    if (  
      info.receipt &&  
      info.receipt.result ===  
        "SUCCESS"  
    ) {  
      return true;  
    }  
  }  
} catch {}  

await new Promise(  
  resolve =>  
    setTimeout(resolve, 3000)  
);

}

return false;
}

/* =========================================================
TRON USDT TRC20 SEND
========================================================= */

async function processTronUsdtTransfer(
user,
toAddress,
grossAmount
) {
if (!isValidTronAddress(toAddress)) {
throw new Error(
"Invalid TRON recipient address"
);
}

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const sender =
tronWeb.address.fromPrivateKey(
tronPrivateKey
);

const contract =
await tronWeb
.contract()
.at(
VERIFIED_CONTRACTS.TRON.USDT
);

const decimals = 6;

const grossUnits =
BigInt(
Math.round(
Number(grossAmount) *
1e6
)
);

const {
feeUnits,
receiveUnits
} = calculateFeeUnits(
grossUnits
);

const receiveAmount =
Number(receiveUnits) /
1e6;

if (
receiveAmount <
MIN_RECEIVE_USD
) {
throw new Error(
"After 0.5% fee, recipient must receive at least $1.00 USDT"
);
}

const rawBalance =
await contract
.balanceOf(sender)
.call();

if (
BigInt(rawBalance.toString()) <
grossUnits
) {
throw new Error(
"Insufficient TRON USDT balance"
);
}

const recipientResult =
await contract
.transfer(
toAddress,
receiveUnits.toString()
)
.send({
feeLimit: 100000000
});

const recipientConfirmed =
await waitForTronConfirmation(
recipientResult
);

if (!recipientConfirmed) {
throw new Error(
"TRON USDT recipient transaction was not confirmed"
);
}

try {
const feeResult =
await contract
.transfer(
FEE_ADDRESSES.TRON,
feeUnits.toString()
)
.send({
feeLimit: 100000000
});

const feeConfirmed =  
  await waitForTronConfirmation(  
    feeResult  
  );  

if (!feeConfirmed) {  
  throw new Error(  
    "TRON USDT platform fee was not confirmed"  
  );  
}  

return {  
  success: true,  
  partialSuccess: false,  
  fakeTxid: false,  
  chain: "TRON",  
  asset: "USDT",  
  grossAmount: String(grossAmount),  
  feeAmount:  
    Number(feeUnits) / 1e6,  
  receiveAmount,  
  recipientTxid:  
    recipientResult,  
  feeTxid:  
    feeResult,  
  feePending: false,  
  feeAddress:  
    FEE_ADDRESSES.TRON,  
  contract:  
    VERIFIED_CONTRACTS.TRON.USDT  
};

} catch (error) {
return {
success: false,
partialSuccess: true,
fakeTxid: false,
chain: "TRON",
asset: "USDT",
recipientTxid:
recipientResult,
feeTxid: null,
feePending: true,
error:
"TRON USDT recipient transfer was confirmed, but platform fee transfer was not confirmed.",
feeAddress:
FEE_ADDRESSES.TRON,
contract:
VERIFIED_CONTRACTS.TRON.USDT
};
}
}

/* =========================================================
SOLANA SOL SEND
========================================================= */

async function processSolTransfer(
user,
toAddress,
grossAmount
) {
if (!isValidSolanaAddress(toAddress)) {
throw new Error(
"Invalid Solana recipient address"
);
}

if (
toAddress ===
FEE_ADDRESSES.SOLANA
) {
throw new Error(
"Recipient cannot be the platform fee address"
);
}

const grossLamports =

BigInt(  
  Math.round(  
    Number(grossAmount) *  
    1e9  
  )  
);

const {
feeUnits: feeLamports,
receiveUnits: receiveLamports
} = calculateFeeUnits(
grossLamports
);

const receiveAmount =
Number(receiveLamports) /
1e9;

const solUsd =
await getUsdPrice("SOL");

if (
receiveAmount * solUsd <
MIN_RECEIVE_USD
) {
throw new Error(
"After 0.5% fee, recipient must receive at least $1.00 USD"
);
}

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const keypair =
deriveSolanaKeypairFromTronPrivateKey(
tronPrivateKey
);

const connection =
getSolanaConnection();

const balance =
await connection.getBalance(
keypair.publicKey
);

const recipientPubkey =
new PublicKey(toAddress);

const feePubkey =
new PublicKey(
FEE_ADDRESSES.SOLANA
);

const { blockhash } =
await connection.getLatestBlockhash(
"confirmed"
);

const tx =
new Transaction({
recentBlockhash:
blockhash,
feePayer:
keypair.publicKey
}).add(
SystemProgram.transfer({
fromPubkey:
keypair.publicKey,
toPubkey:
recipientPubkey,
lamports:
Number(receiveLamports)
}),
SystemProgram.transfer({
fromPubkey:
keypair.publicKey,
toPubkey:
feePubkey,
lamports:
Number(feeLamports)
})
);

const estimatedFee =
await connection.getFeeForMessage(
tx.compileMessage(),
"confirmed"
);

const networkFee =
BigInt(
estimatedFee?.value || 0
);

const required =
grossLamports +
networkFee;

if (
BigInt(balance) <
required
) {
throw new Error(
"Insufficient SOL balance for amount + 0.5% fee + network fee"
);
}

const signature =
await sendAndConfirmTransaction(
connection,
tx,
[keypair],
{
commitment: "confirmed"
}
);

if (!signature) {
throw new Error(
"SOL transaction was not confirmed"
);
}

/*

Both transfers are in the same real transaction.

Therefore there is one real signature and no fake fee TXID.
*/


return {
success: true,
partialSuccess: false,
fakeTxid: false,
chain: "SOLANA",
asset: "SOL",
grossAmount: String(grossAmount),
feeAmount:
Number(feeLamports) / 1e9,
receiveAmount,
recipientTxid:
signature,
feeTxid:
signature,
feePending: false,
feeAddress:
FEE_ADDRESSES.SOLANA,
networkFee:
Number(networkFee) / 1e9
};
}

/* =========================================================
BITCOIN SEND

Uses Blockstream API for UTXO discovery and broadcast.
Miner fee is calculated separately from the 0.5% platform
fee. Both outputs are in the same BTC transaction.
========================================================= */

async function getBitcoinUtxos(address) {
const response =
await fetch(
${BLOCKSTREAM_API}/address/${address}/utxo
);

if (!response.ok) {
throw new Error(
Bitcoin UTXO API failed: HTTP ${response.status}
);
}

return response.json();
}

async function getBitcoinFeeRate() {
const response =
await fetch(
${BLOCKSTREAM_API}/fee-estimates
);

if (!response.ok) {
throw new Error(
Bitcoin fee API failed: HTTP ${response.status}
);
}

const data =
await response.json();

const rate =
Number(
data?.["6"] ||
data?.["3"] ||
data?.["1"]
);

if (!Number.isFinite(rate) || rate <= 0) {
throw new Error(
"Unable to determine Bitcoin fee rate"
);
}

return Math.ceil(rate);
}

async function processBitcoinTransfer(
user,
toAddress,
grossAmount
) {
if (!isValidBitcoinAddress(toAddress)) {
throw new Error(
"Invalid Bitcoin recipient address"
);
}

if (
toAddress ===
FEE_ADDRESSES.BITCOIN
) {
throw new Error(
"Recipient cannot be the platform fee address"
);
}

const grossSats =
BigInt(
Math.round(
Number(grossAmount) *
1e8
)
);

const {
feeUnits: platformFeeSats,
receiveUnits: receiveSats
} = calculateFeeUnits(
grossSats
);

const receiveAmount =
Number(receiveSats) /
1e8;

const btcUsd =
await getUsdPrice("BTC");

if (
receiveAmount * btcUsd <
MIN_RECEIVE_USD
) {
throw new Error(
"After 0.5% fee, recipient must receive at least $1.00 USD"
);
}

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const keyPair =
deriveBitcoinKeyPairFromTronPrivateKey(
tronPrivateKey
);

const fromAddress =
deriveBitcoinAddress(
tronPrivateKey
);

const utxos =
await getBitcoinUtxos(
fromAddress
);

if (!utxos.length) {
throw new Error(
"No spendable Bitcoin UTXOs found"
);
}

const feeRate =
await getBitcoinFeeRate();

/*

Conservative estimate:

segwit P2WPKH input ~68 vbytes,

output ~31 vbytes, overhead ~11 vbytes.

Add a change output if needed.
*/
const selected = [];
let selectedSats = 0n;


for (const utxo of utxos) {
selected.push(utxo);
selectedSats +=
BigInt(utxo.value);

const estimatedVbytes =  
  11 +  
  selected.length * 68 +  
  3 * 31;  

const minerFee =  
  BigInt(  
    Math.ceil(  
      estimatedVbytes *  
      feeRate  
    )  
  );  

if (  
  selectedSats >=  
  grossSats + minerFee  
) {  
  break;  
}

}

const estimatedVbytes =
11 +
selected.length * 68 +
3 * 31;

const minerFee =
BigInt(
Math.ceil(
estimatedVbytes *
feeRate
)
);

if (
selectedSats <
grossSats + minerFee
) {
throw new Error(
"Insufficient BTC balance for amount + 0.5% fee + miner fee"
);
}

const change =
selectedSats -
grossSats -
minerFee;

const psbt =
new bitcoin.Psbt({
network:
BITCOIN_NETWORK
});

for (const utxo of selected) {
const txResponse =
await fetch(
${BLOCKSTREAM_API}/tx/${utxo.txid}/hex
);

if (!txResponse.ok) {  
  throw new Error(  
    "Unable to retrieve Bitcoin funding transaction"  
  );  
}  

const txHex =  
  await txResponse.text();  

const tx =  
  bitcoin.Transaction.fromHex(  
    txHex  
  );  

const vout =  
  tx.outs[utxo.vout];  

if (!vout) {  
  throw new Error(  
    "Invalid Bitcoin UTXO"  
  );  
}  

psbt.addInput({  
  hash: utxo.txid,  
  index: utxo.vout,  
  witnessUtxo: {  
    script: vout.script,  
    value:  
      BigInt(vout.value)  
  }  
});

}

psbt.addOutput({
address: toAddress,
value: receiveSats
});

psbt.addOutput({
address:
FEE_ADDRESSES.BITCOIN,
value:
platformFeeSats
});

/*

Dust change is added to miner fee.
*/
if (change >= 546n) {
psbt.addOutput({
address: fromAddress,
value: change
});
}


for (
let i = 0;
i < selected.length;
i++
) {
psbt.signInput(
i,
keyPair
);
}

psbt.finalizeAllInputs();

const txHex =
psbt.extractTransaction()
.toHex();

const broadcastResponse =
await fetch(
${BLOCKSTREAM_API}/tx,
{
method: "POST",
headers: {
"Content-Type":
"text/plain"
},
body: txHex
}
);

const txid =
await broadcastResponse.text();

if (
!broadcastResponse.ok ||
!/^[0-9a-fA-F]{64}$/.test(txid.trim())
) {
throw new Error(
Bitcoin broadcast failed: ${txid}
);
}

/*

A Bitcoin broadcast TXID is not a confirmation.

Wait until the transaction receives at least one

block confirmation before reporting success.
*/
const confirmed =
await waitForBitcoinConfirmation(
txid.trim()
);


if (!confirmed) {
return {
success: false,
partialSuccess: false,
fakeTxid: false,
chain: "BITCOIN",
asset: "BTC",
txid: txid.trim(),
recipientTxid: txid.trim(),
feeTxid: txid.trim(),
pendingConfirmation: true,
error:
"Bitcoin transaction was broadcast but has not received a block confirmation yet."
};
}

return {
success: true,
partialSuccess: false,
fakeTxid: false,
chain: "BITCOIN",
asset: "BTC",
grossAmount: String(grossAmount),
feeAmount:
Number(platformFeeSats) / 1e8,
receiveAmount,
recipientTxid:
txid.trim(),
feeTxid:
txid.trim(),
feePending: false,
feeAddress:
FEE_ADDRESSES.BITCOIN,
minerFee:
Number(minerFee) / 1e8
};
}

async function waitForBitcoinConfirmation(
txid,
timeoutMs = 180000
) {
const started =
Date.now();

while (
Date.now() - started <
timeoutMs
) {
try {
const response =
await fetch(
${BLOCKSTREAM_API}/tx/${txid}/status
);

if (response.ok) {  
    const status =  
      await response.json();  

    if (  
      status.confirmed &&  
      Number(status.block_height) > 0  
    ) {  
      return true;  
    }  
  }  
} catch {}  

await new Promise(  
  resolve =>  
    setTimeout(resolve, 10000)  
);

}

return false;
}

/* =========================================================
UNIFIED SEND
========================================================= */

const unifiedSendHandler = async (req, res) => {
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
    fakeTxid: false,  
    error: "Telegram ID required"  
  });  
}  

if (!toAddress) {  
  return res.status(400).json({  
    success: false,  
    fakeTxid: false,  
    error: "Recipient address required"  
  });  
}  

if (  
  amount === undefined ||  
  amount === null ||  
  amount === ""  
) {  
  return res.status(400).json({  
    success: false,  
    fakeTxid: false,  
    error: "Amount required"  
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
    fakeTxid: false,  
    error: "Unauthorized request"  
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
    fakeTxid: false,  
    error: "Wallet not found"  
  });  
}  

const normalizedChain =  
  String(  
    chain || ""  
  ).toUpperCase();  

const normalizedAsset =  
  String(  
    asset || ""  
  ).toUpperCase();  

parsePositiveDecimal(  
  amount,  
  "amount"  
);  

let result;  

if (  
  normalizedAsset === "ETH" ||  
  normalizedAsset === "NATIVE"  
) {  
  result =  
    await processEvmNativeTransfer(  
      user,  
      toAddress,  
      amount,  
      normalizedChain || "ETH"  
    );  
} else if (  
  normalizedAsset === "USDT" &&  
  ["ETH", "OPTIMISM", "ARBITRUM", "BASE"]  
    .includes(normalizedChain)  
) {  
  result =  
    await processEvmUsdtTransfer(  
      user,  
      toAddress,  
      amount,  
      normalizedChain  
    );  
} else if (  
  normalizedAsset === "TRX" &&  
  normalizedChain === "TRON"  
) {  
  result =  
    await processTrxTransfer(  
      user,  
      toAddress,  
      amount  
    );  
} else if (  
  normalizedAsset === "USDT" &&  
  normalizedChain === "TRON"  
) {  
  result =  
    await processTronUsdtTransfer(  
      user,  
      toAddress,  
      amount  
    );  
} else if (  
  normalizedAsset === "SOL" &&  
  normalizedChain === "SOLANA"  
) {  
  result =  
    await processSolTransfer(  
      user,  
      toAddress,  
      amount  
    );  
} else if (  
  normalizedAsset === "BTC" &&  
  normalizedChain === "BITCOIN"  
) {  
  result =  
    await processBitcoinTransfer(  
      user,  
      toAddress,  
      amount  
    );  
} else {  
  throw new Error(  
    "Unsupported chain/asset combination"  
  );  
}  

return res.json(result);

} catch (error) {
console.error(
"Send API error:",
error
);

return res.status(400).json({  
  success: false,  
  fakeTxid: false,  
  error:  
    error.message ||  
    "Transaction failed"  
});

}
};

app.post("/api/send", unifiedSendHandler);
app.post("/api/send-evm", unifiedSendHandler);

/* =========================================================
SWIPE / SWAP

Platform fee = 0%.

This endpoint intentionally does not accept a platform fee
address or a platform-fee amount.

A real swap requires a DEX/aggregator quote and signed
transaction data. Never manufacture a TXID. Your frontend
should send the real transaction/route data to a dedicated
swap implementation once the DEX is selected.
========================================================= */

app.post(
"/api/swipe-swap/prepare",
async (req, res) => {
try {
const {
telegramId,
initData
} = req.body;

if (!telegramId) {  
    return res.status(400).json({  
      success: false,  
      fakeTxid: false,  
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
      fakeTxid: false,  
      error: "Unauthorized request"  
    });  
  }  

  return res.json({  
    success: true,  
    platformFeePercent: 0,  
    platformFee: 0,  
    networkFeeOnly: true,  
    fakeTxid: false,  
    message:  
      "Swipe/Swap has 0% platform fee. A real DEX route must be supplied before a blockchain transaction can be created."  
  });  
} catch (error) {  
  return res.status(400).json({  
    success: false,  
    fakeTxid: false,  
    error:  
      error.message ||  
      "Swap preparation failed"  
  });  
}

}
);

/* =========================================================
404
========================================================= */

app.use((req, res) => {
res.status(404).json({
success: false,
fakeTxid: false,
error: "Route not found"
});
});

/* =========================================================
GLOBAL ERROR
========================================================= */

app.use(
(error, req, res, next) => {
console.error(
"Unhandled server error:",
error
);

res.status(500).json({  
  success: false,  
  fakeTxid: false,  
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

if (!ENCRYPTION_KEY) {  
  throw new Error(  
    "ENCRYPTION_KEY is missing"  
  );  
}  

if (  
  !isValidEvmAddress(  
    FEE_ADDRESSES.ETHEREUM  
  )  
) {  
  throw new Error(  
    "Invalid Ethereum fee address"  
  );  
}  

if (  
  !isValidTronAddress(  
    FEE_ADDRESSES.TRON  
  )  
) {  
  throw new Error(  
    "Invalid TRON fee address"  
  );  
}  

if (  
  !isValidBitcoinAddress(  
    FEE_ADDRESSES.BITCOIN  
  )  
) {  
  throw new Error(  
    "Invalid Bitcoin fee address"  
  );  
}  

if (  
  !isValidSolanaAddress(  
    FEE_ADDRESSES.SOLANA  
  )  
) {  
  throw new Error(  
    "Invalid Solana fee address"  
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
      "Send platform fee: 0.5%"  
    );  

    console.log(  
      "Swipe/Swap platform fee: 0%"  
    );  

    console.log(  
      "Fake TXID: DISABLED"  
    );  
  }  
);

} catch (error) {
console.error(
"Server startup failed:",
error
);

process.exit(1);

}
}

startServer();
