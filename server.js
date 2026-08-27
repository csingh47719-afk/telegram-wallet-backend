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
const TRONGRID_API_KEY =
(process.env.TRONGRID_API_KEY || "").trim();

const PLATFORM_FEE_PERCENT = 0.005;
const MIN_RECEIVE_USD = 1.00;

/* =========================================================
FEE ADDRESSES
========================================================= */

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

/* =========================================================
EVM NETWORKS
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

usdt:  
  process.env.OPTIMISM_USDT_CONTRACT ||  
  ""

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

usdt:  
  process.env.BASE_USDT_CONTRACT ||  
  ""

}
};

/* =========================================================
VERIFIED CONTRACTS
========================================================= */

const VERIFIED_CONTRACTS = {
TRON: {
USDT:
process.env.TRON_USDT_CONTRACT ||
"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
}
};

const SOLANA_RPC =
process.env.SOLANA_RPC ||
"https://api.mainnet-beta.solana.com";

const BITCOIN_NETWORK =
bitcoin.networks.bitcoin;

const BLOCKSTREAM_API =
process.env.BLOCKSTREAM_API ||
"https://blockstream.info/api";

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
error:
"Too many requests. Please try again later."
}
});

app.use("/api/", apiLimiter);

/* =========================================================
TRON
========================================================= */

const tronHeaders = {};

if (TRONGRID_API_KEY) {
tronHeaders["TRON-PRO-API-KEY"] =
TRONGRID_API_KEY;
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

{
versionKey: false
}
);

const User =
mongoose.model("User", UserSchema);

/* =========================================================
ENCRYPTION
========================================================= */

function getEncryptionKey() {
if (!ENCRYPTION_KEY) {
throw new Error(
"ENCRYPTION_KEY is missing"
);
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
const bytes =
CryptoJS.AES.decrypt(
ciphertext,
getEncryptionKey()
);

const result =
bytes.toString(
CryptoJS.enc.Utf8
);

if (!result) {
throw new Error(
"Private key decryption failed"
);
}

return result;
}

/* =========================================================
TELEGRAM AUTH
========================================================= */

function verifyTelegramWebAppData(initData) {
if (!initData || !BOT_TOKEN) {
return false;
}

try {
const urlParams =
new URLSearchParams(initData);

const receivedHash =  
  urlParams.get("hash");  

if (!receivedHash) {  
  return false;  
}  

urlParams.delete("hash");  

const dataCheckArr = [];  

for (  
  const [key, value]  
  of urlParams.entries()  
) {  
  dataCheckArr.push(  
    `${key}=${value}`  
  );  
}  

dataCheckArr.sort();  

const dataCheckString =  
  dataCheckArr.join("\n");  

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

if (  
  calculatedHash.length !==  
  receivedHash.length  
) {  
  return false;  
}  

return crypto.timingSafeEqual(  
  Buffer.from(  
    calculatedHash,  
    "utf8"  
  ),  
  Buffer.from(  
    receivedHash,  
    "utf8"  
  )  
);

} catch (error) {
console.error(
"Telegram verification error:",
error.message
);

return false;

}
}

function getTelegramUserIdFromInitData(
initData
) {
try {
const params =
new URLSearchParams(initData);

const userJson =  
  params.get("user");  

if (!userJson) {  
  return null;  
}  

const telegramUser =  
  JSON.parse(userJson);  

if (!telegramUser.id) {  
  return null;  
}  

return String(  
  telegramUser.id  
);

} catch {
return null;
}
}

function authenticateTelegramRequest(
telegramId,
initData
) {
if (!BOT_TOKEN) {
return false;
}

if (!initData) {
return false;
}

if (
!verifyTelegramWebAppData(
initData
)
) {
return false;
}

const verifiedTelegramId =
getTelegramUserIdFromInitData(
initData
);

return (
!!verifiedTelegramId &&
verifiedTelegramId ===
String(telegramId)
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

/* =========================================================
IMPORTANT SYNTAX-FIXED FUNCTION
========================================================= */

function parsePositiveDecimal(
value,
name
) {
const s =
String(value ?? "").trim();

if (
!/^(?:\d+.?\d*|.\d+)$/.test(s)
) {
throw new Error(
Invalid ${name}
);
}

const n = Number(s);

if (
!Number.isFinite(n) ||
n <= 0
) {
throw new Error(
Invalid ${name}
);
}

return n;
}

/* =========================================================
WALLET DERIVATION
========================================================= */

function deriveEvmWalletFromTronPrivateKey(
tronPrivateKey
) {
const hash =
CryptoJS.SHA256(
"OPEN_WALLET_EVM_V2:" +
tronPrivateKey
).toString(
CryptoJS.enc.Hex
);

return new ethers.Wallet(
"0x" + hash
);
}

function deriveSolanaKeypairFromTronPrivateKey(
tronPrivateKey
) {
const hash =
crypto
.createHash("sha256")
.update(
"OPEN_WALLET_SOLANA_V1:" +
tronPrivateKey
)
.digest();

return Keypair.fromSeed(
new Uint8Array(hash)
);
}

function deriveBitcoinKeyPairFromTronPrivateKey(
tronPrivateKey
) {
const hash =
crypto
.createHash("sha256")
.update(
"OPEN_WALLET_BITCOIN_V1:" +
tronPrivateKey
)
.digest();

return ECPair.fromPrivateKey(
hash,
{
compressed: true,
network: BITCOIN_NETWORK
}
);
}

function deriveBitcoinAddress(
tronPrivateKey
) {
const keyPair =
deriveBitcoinKeyPairFromTronPrivateKey(
tronPrivateKey
);

return bitcoin.payments.p2wpkh({
pubkey:
Buffer.from(
keyPair.publicKey
),

network:  
  BITCOIN_NETWORK

}).address;
}

/* =========================================================
PROVIDERS
========================================================= */

function getEvmProvider(
networkKey
) {
const key =
String(
networkKey || ""
).toUpperCase();

const network =
EVM_NETWORKS[key];

if (!network) {
throw new Error(
"Unsupported EVM network"
);
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
PRICE
========================================================= */

async function getUsdPrice(coin) {
const symbol =
String(
coin || ""
).toUpperCase();

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
} else if (symbol === "SOL") {
id = "solana";
} else {
throw new Error(
"Unsupported price asset"
);
}

const url =
"https://api.coingecko.com/api/v3/simple/price" +
?ids=${encodeURIComponent(id)} +
"&vs_currencies=usd";

const response =
await fetch(url);

if (!response.ok) {
throw new Error(
Price API failed: HTTP ${response.status}
);
}

const data =
await response.json();

const price =
Number(
data?.[id]?.usd
);

if (
!Number.isFinite(price) ||
price <= 0
) {
throw new Error(
"Invalid USD price"
);
}

return price;
}

/* =========================================================
TRON BALANCES
========================================================= */

async function getTronBalances(
address
) {
let trx = 0;
let usdt = 0;

try {
const sun =
await tronWeb.trx.getBalance(
address
);

trx =  
  Number(sun) / 1e6;

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
.at(
VERIFIED_CONTRACTS.TRON.USDT
);

const raw =  
  await contract  
    .balanceOf(address)  
    .call();  

usdt =  
  Number(  
    raw.toString()  
  ) / 1e6;

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
EVM BALANCES
========================================================= */

async function getEvmBalance(
networkKey,
address
) {
const provider =
getEvmProvider(
networkKey
);

const balance =
await provider.getBalance(
address
);

return Number(
ethers.formatEther(
balance
)
);
}

async function getErc20Balance(
networkKey,
address
) {
const network =
EVM_NETWORKS[
String(
networkKey
).toUpperCase()
];

if (
!network ||
!network.usdt
) {
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
getEvmProvider(
networkKey
);

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

const [
raw,
decimals
] = await Promise.all([
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
/* =========================================================
USER
========================================================= */

async function getOrCreateUser(telegramId) {
const id = String(telegramId);

let user = await User.findOne({
telegramId: id
});

if (user) {
return user;
}

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
platformFee:
"0.5% on Send; 0% on Swipe/Swap"
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

/* -----------------------------------------------------  
   TRON BALANCES  
   ----------------------------------------------------- */  

const tronBalances =  
  await getTronBalances(  
    user.walletAddress  
  );  

/* -----------------------------------------------------  
   EVM BALANCES  
   ----------------------------------------------------- */  

const evmBalances = {};  
const evmUsdtBalances = {};  

for (  
  const networkKey of  
  Object.keys(EVM_NETWORKS)  
) {  
  try {  
    evmBalances[networkKey] =  
      await getEvmBalance(  
        networkKey,  
        evmWallet.address  
      );  
  } catch (error) {  
    console.error(  
      `${networkKey} native balance error:`,  
      error.message  
    );  

    evmBalances[networkKey] = 0;  
  }  

  try {  
    evmUsdtBalances[networkKey] =  
      await getErc20Balance(  
        networkKey,  
        evmWallet.address  
      );  
  } catch (error) {  
    console.error(  
      `${networkKey} USDT balance error:`,  
      error.message  
    );  

    evmUsdtBalances[networkKey] = 0;  
  }  
}  

/* -----------------------------------------------------  
   SOLANA BALANCE  
   ----------------------------------------------------- */  

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

/* -----------------------------------------------------  
   RESPONSE  
   ----------------------------------------------------- */  

return res.json({  
  success: true,  

  address:  
    user.walletAddress,  

  addresses: {  
    TRX:  
      user.walletAddress,  

    USDT_TRON:  
      user.walletAddress,  

    ETH:  
      evmWallet.address,  

    USDT_ETH:  
      evmWallet.address,  

    BTC:  
      bitcoinAddress,  

    SOL:  
      solanaKeypair  
        .publicKey  
        .toBase58()  
  },  

  verifiedBalances: {  
    trx:  
      Number(  
        tronBalances.trx  
          .toFixed(6)  
      ),  

    usdt_tron:  
      Number(  
        tronBalances.usdt  
          .toFixed(6)  
      ),  

    eth:  
      Number(  
        (  
          evmBalances.ETH || 0  
        ).toFixed(8)  
      ),  

    usdt_eth:  
      Number(  
        (  
          evmUsdtBalances.ETH ||  
          0  
        ).toFixed(6)  
      ),  

    optimism:  
      Number(  
        (  
          evmBalances.OPTIMISM ||  
          0  
        ).toFixed(8)  
      ),  

    arbitrum:  
      Number(  
        (  
          evmBalances.ARBITRUM ||  
          0  
        ).toFixed(8)  
      ),  

    base:  
      Number(  
        (  
          evmBalances.BASE ||  
          0  
        ).toFixed(8)  
      ),  

    btc: 0,  

    sol:  
      Number(  
        solBalance.toFixed(9)  
      )  
  },  

  platformFee: {  
    sendPercent: 0.5,  
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
    "On-chain balance query failed",  
  fakeTxid: false  
});

}
});

/* =========================================================
FEE CALCULATION
========================================================= */

function calculateFeeUnits(
grossUnits
) {
const fee =
grossUnits * 5n / 1000n;

const receive =
grossUnits - fee;

if (
fee <= 0n ||
receive <= 0n
) {
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
String(
chain || "ETH"
).toUpperCase();

const network =
EVM_NETWORKS[networkKey];

if (!network) {
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
"Invalid recipient address"
);
}

if (
toAddress.toLowerCase() ===
FEE_ADDRESSES
.ETHEREUM
.toLowerCase()
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
} =
calculateFeeUnits(
grossWei
);

const ethUsd =
await getUsdPrice(
"ETH"
);

const receiveAmount =
Number(
ethers.formatEther(
receiveWei
)
);

const receiveUsd =
receiveAmount *
ethUsd;

if (
receiveUsd <
MIN_RECEIVE_USD
) {
throw new Error(
After 0.5% fee, recipient must receive at least $1.00 USD. Current value: $${receiveUsd.toFixed(2)}
);
}

const provider =
getEvmProvider(
networkKey
);

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const wallet =
deriveEvmWalletFromTronPrivateKey(
tronPrivateKey
).connect(
provider
);

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

/* -----------------------------------------------------
ESTIMATE RECIPIENT GAS
----------------------------------------------------- */

const recipientGas =
await provider.estimateGas({
from:
wallet.address,

to:  
    toAddress,  

  value:  
    receiveWei  
});

/* -----------------------------------------------------
ESTIMATE PLATFORM FEE GAS
----------------------------------------------------- */

const platformGas =
await provider.estimateGas({
from:
wallet.address,

to:  
    FEE_ADDRESSES.ETHEREUM,  

  value:  
    feeWei  
});

const totalGas =
recipientGas +
platformGas;

const gasCost =
totalGas *
gasPrice;

if (
balance <
grossWei +
gasCost
) {
throw new Error(
"Insufficient native coin balance for amount + 0.5% fee + network gas"
);
}

/* -----------------------------------------------------
REAL RECIPIENT TRANSACTION
----------------------------------------------------- */

const recipientTx =
await wallet.sendTransaction({
to:
toAddress,

value:  
    receiveWei,  

  gasLimit:  
    recipientGas  
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

/* -----------------------------------------------------
REAL PLATFORM FEE TRANSACTION
----------------------------------------------------- */

try {
const feeTx =
await wallet.sendTransaction({
to:
FEE_ADDRESSES.ETHEREUM,

value:  
      feeWei,  

    gasLimit:  
      platformGas  
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

  chain:  
    networkKey,  

  asset:  
    "NATIVE",  

  grossAmount:  
    String(grossAmount),  

  feeAmount:  
    ethers.formatEther(  
      feeWei  
    ),  

  receiveAmount:  
    ethers.formatEther(  
      receiveWei  
    ),  

  recipientTxid:  
    recipientTx.hash,  

  feeTxid:  
    feeTx.hash,  

  feePending:  
    false,  

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

  chain:  
    networkKey,  

  asset:  
    "NATIVE",  

  recipientTxid:  
    recipientTx.hash,  

  feeTxid:  
    null,  

  feePending:  
    true,  

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
String(
chain || "ETH"
).toUpperCase();

const network =
EVM_NETWORKS[networkKey];

if (!network) {
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
getEvmProvider(
networkKey
);

const tronPrivateKey =
decryptKey(
user.encryptedPrivateKey
);

const wallet =
deriveEvmWalletFromTronPrivateKey(
tronPrivateKey
).connect(
provider
);

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
} =
calculateFeeUnits(
grossUnits
);

const receiveAmount =
Number(
ethers.formatUnits(
receiveUnits,
decimals
)
);

if (
receiveAmount <
MIN_RECEIVE_USD
) {
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

from:  
    wallet.address  
});

const feeGas =
await provider.estimateGas({
...feeTxRequest,

from:  
    wallet.address  
});

const nativeBalance =
await provider.getBalance(
wallet.address
);

const gasCost =
(recipientGas + feeGas) *
gasPrice;

if (
nativeBalance <
gasCost
) {
throw new Error(
"Insufficient native coin for ERC20 network gas"
);
}

/* -----------------------------------------------------
REAL USDT RECIPIENT TRANSACTION
----------------------------------------------------- */

const recipientTx =
await token.transfer(
toAddress,
receiveUnits,
{
gasLimit:
recipientGas
}
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

/* -----------------------------------------------------
REAL USDT PLATFORM FEE TRANSACTION
----------------------------------------------------- */

try {
const feeTx =
await token.transfer(
FEE_ADDRESSES.ETHEREUM,
feeUnits,
{
gasLimit:
feeGas
}
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

  chain:  
    networkKey,  

  asset:  
    "USDT",  

  grossAmount:  
    amountString,  

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

  feePending:  
    false,  

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

  chain:  
    networkKey,  

  asset:  
    "USDT",  

  recipientTxid:  
    recipientTx.hash,  

  feeTxid:  
    null,  

  feePending:  
    true,  

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

const user = await User.findOne({  
  telegramId: String(telegramId)  
});  

if (!user) {  
  return res.status(404).json({  
    success: false,  
    fakeTxid: false,  
    error: "Wallet not found"  
  });  
}  

const normalizedChain =  
  String(chain || "").toUpperCase();  

const normalizedAsset =  
  String(asset || "").toUpperCase();  

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
}  

else if (  
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
}  

else if (  
  normalizedAsset === "TRX" &&  
  normalizedChain === "TRON"  
) {  
  result =  
    await processTrxTransfer(  
      user,  
      toAddress,  
      amount  
    );  
}  

else if (  
  normalizedAsset === "USDT" &&  
  normalizedChain === "TRON"  
) {  
  result =  
    await processTronUsdtTransfer(  
      user,  
      toAddress,  
      amount  
    );  
}  

else if (  
  normalizedAsset === "SOL" &&  
  normalizedChain === "SOLANA"  
) {  
  result =  
    await processSolTransfer(  
      user,  
      toAddress,  
      amount  
    );  
}  

else if (  
  normalizedAsset === "BTC" &&  
  normalizedChain === "BITCOIN"  
) {  
  result =  
    await processBitcoinTransfer(  
      user,  
      toAddress,  
      amount  
    );  
}  

else {  
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

app.post(
"/api/send",
unifiedSendHandler
);

app.post(
"/api/send-evm",
unifiedSendHandler
);

/* =========================================================
SWIPE / SWAP
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
