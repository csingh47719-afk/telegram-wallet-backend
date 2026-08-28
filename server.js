
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
fs.mkdirSync('./data', { recursive: true });
import { Address, Cell, contractAddress, domainSignVerify, loadStateInit } from '@ton/ton';
import { TonClient } from '@ton/ton';

const app = express();
const db = new Database('./data/open.sqlite');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  address TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0,
  mining_started_at INTEGER,
  successful_referrals INTEGER NOT NULL DEFAULT 0,
  deposit_bonus INTEGER NOT NULL DEFAULT 0,
  referrer TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces(
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deposits(
  invoice_id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL,
  address TEXT NOT NULL,
  amount_nano TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS referrals(
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const PORT = Number(process.env.PORT || 3000);
const NETWORK = process.env.TON_NETWORK || '-239';
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS || '';

const MIN_NANO = BigInt(
  Math.round(
    Number(process.env.MIN_DEPOSIT_TON || 0.01) * 1e9
  )
);

const TONCENTER_ENDPOINT =
  process.env.TONCENTER_ENDPOINT ||
  'https://toncenter.com/api/v2/jsonRPC';

const TONCENTER_API_KEY =
  process.env.TONCENTER_API_KEY || '';

const tonClient = new TonClient({
  endpoint: TONCENTER_ENDPOINT,
  apiKey: TONCENTER_API_KEY || undefined
});

if (!DEPOSIT_ADDRESS) {
  console.warn(
    'DEPOSIT_ADDRESS is not configured; deposits will be disabled.'
  );
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(
  express.json({
    limit: '64kb'
  })
);

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static('public'));

const sha = (s) =>
  crypto.createHash('sha256').update(s).digest('hex');

function now() {
  return Date.now();
}

function sessionAddress(req) {
  const t =
    req.headers.authorization?.replace(/^Bearer\s+/, '') ||
    req.cookies?.open_session;

  if (!t) return null;

  const r = db
    .prepare(
      'SELECT address FROM sessions WHERE token_hash=? AND expires_at>?'
    )
    .get(sha(t), now());

  return r?.address || null;
}

function auth(req, res, next) {
  const a = sessionAddress(req);

  if (!a) {
    return res
      .status(401)
      .json({
        error: 'Wallet authentication required'
      });
  }

  req.address = a;
  next();
}

function speedFor(u) {
  return (
    0.001 *
    (
      1 +
      0.10 * u.successful_referrals +
      0.10 * (u.deposit_bonus ? 1 : 0)
    )
  );
}

function accrue(u) {
  if (!u.mining_started_at) return u;

  const elapsed = Math.max(
    0,
    Math.min(
      now() - u.mining_started_at,
      24 * 60 * 60 * 1000
    )
  );

  const earned =
    speedFor(u) *
    (elapsed / 3600000);

  if (earned > 0) {
    db.prepare(
      'UPDATE users SET balance=balance+?, mining_started_at=? WHERE address=?'
    ).run(
      earned,
      u.mining_started_at + elapsed,
      u.address
    );
  }

  return db
    .prepare(
      'SELECT * FROM users WHERE address=?'
    )
    .get(u.address);
}

app.get('/api/auth/nonce', (req, res) => {
  const n = crypto
    .randomBytes(24)
    .toString('hex');

  db.prepare(
    'INSERT INTO nonces VALUES(?,?)'
  ).run(n, now());

  db.prepare(
    'DELETE FROM nonces WHERE created_at<?'
  ).run(
    now() - 15 * 60 * 1000
  );

  res.json({
    nonce: n
  });
});

function sha256(buf) {
  return crypto
    .createHash('sha256')
    .update(buf)
    .digest();
}

function signatureDomain(network) {
  return network === '-239' ||
    network === '-3'
    ? { type: 'empty' }
    : {
        type: 'l2',
        globalId: Number(network)
      };
}

function proofDigest(address, proof) {
  const wc = Buffer.alloc(4);

  wc.writeInt32BE(
    address.workChain,
    0
  );

  const domainBytes = Buffer.from(
    proof.domain.value,
    'utf8'
  );

  if (
    proof.domain.lengthBytes !==
    domainBytes.length
  ) {
    throw new Error(
      'domain length mismatch'
    );
  }

  const dl = Buffer.alloc(4);

  dl.writeUInt32LE(
    proof.domain.lengthBytes,
    0
  );

  const ts = Buffer.alloc(8);

  ts.writeBigUInt64LE(
    BigInt(proof.timestamp),
    0
  );

  const msg = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'),
    wc,
    Buffer.from(address.hash),
    dl,
    domainBytes,
    ts,
    Buffer.from(proof.payload)
  ]);

  return sha256(
    Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from('ton-connect'),
      sha256(msg)
    ])
  );
}

function extractPublicKeyFromStateInit(
  stateInit
) {
  try {
    const s = loadStateInit(
      Cell.fromBase64(stateInit)
        .beginParse()
    );

    if (!s.data) return null;

    const d = s.data.beginParse();

    d.loadUint(32);
    d.loadUint(32);

    return Buffer.from(
      d.loadUintBig(256)
        .toString(16)
        .padStart(64, '0'),
      'hex'
    );
  } catch {
    return null;
  }
}

async function verifyTonProof(input) {
  const {
    proof,
    address,
    walletStateInit,
    network
  } = input;

  if (
    !proof ||
    !address ||
    !walletStateInit ||
    network !== NETWORK
  ) {
    throw new Error(
      'Invalid wallet proof data'
    );
  }

  const expectedDomain =
    new URL(
      process.env.PUBLIC_BASE_URL ||
      'http://localhost:' + PORT
    ).hostname;

  if (
    proof.domain.value !==
    expectedDomain
  ) {
    throw new Error(
      'Wrong proof domain'
    );
  }

  const exists = db
    .prepare(
      'SELECT nonce FROM nonces WHERE nonce=? AND created_at>?'
    )
    .get(
      proof.payload,
      now() - 15 * 60 * 1000
    );

  if (!exists) {
    throw new Error(
      'Proof nonce expired or already used'
    );
  }

  const ts = Number(
    proof.timestamp
  );

  if (
    !Number.isFinite(ts) ||
    Math.abs(
      Math.floor(Date.now() / 1000) - ts
    ) > 900
  ) {
    throw new Error(
      'Proof expired'
    );
  }

  const wanted = Address.parse(address);

  const st = loadStateInit(
    Cell.fromBase64(walletStateInit)
      .beginParse()
  );

  const derived = contractAddress(
    wanted.workChain,
    st
  );

  if (!derived.equals(wanted)) {
    throw new Error(
      'Wallet state does not match address'
    );
  }

  let publicKey =
    extractPublicKeyFromStateInit(
      walletStateInit
    );

  if (!publicKey) {
    const r = await tonClient.runMethod(
      wanted,
      'get_public_key'
    );

    const n = r.stack.readBigNumber();

    publicKey = Buffer.from(
      n.toString(16)
        .padStart(64, '0'),
      'hex'
    );
  }

  const ok = domainSignVerify({
    data: proofDigest(
      wanted,
      proof
    ),
    signature: Buffer.from(
      proof.signature,
      'base64'
    ),
    publicKey,
    domain: signatureDomain(network)
  });

  if (!ok) {
    throw new Error(
      'Invalid TON proof signature'
    );
  }

  return true;
}

app.post(
  '/api/auth/verify',
  async (req, res) => {
    try {
      await verifyTonProof(
        req.body
      );

      const {
        address,
        proof
      } = req.body;

      db.prepare(
        'DELETE FROM nonces WHERE nonce=?'
      ).run(
        proof.payload
      );

      db.prepare(
        `INSERT INTO users(address,created_at)
         VALUES(?,?)
         ON CONFLICT(address) DO NOTHING`
      ).run(
        address,
        now()
      );

      const token =
        crypto.randomBytes(32)
          .toString('base64url');

      db.prepare(
        'INSERT INTO sessions VALUES(?,?,?)'
      ).run(
        sha(token),
        address,
        now() +
          30 * 24 * 3600 * 1000
      );

      const secure =
        process.env.COOKIE_SECURE !==
        'false';

      res.setHeader(
        'Set-Cookie',
        `open_session=${token}; Path=/; HttpOnly; SameSite=Lax${
          secure ? '; Secure' : ''
        }; Max-Age=2592000`
      );

      res.json({
        ok: true
      });

    } catch (e) {
      res
        .status(400)
        .json({
          error: e.message
        });
    }
  }
);

app.get(
  '/api/me',
  auth,
  (req, res) => {
    let u = db
      .prepare(
        'SELECT * FROM users WHERE address=?'
      )
      .get(
        req.address
      );

    u = accrue(u);

    const active =
      !!u.mining_started_at;

    const end =
      active
        ? u.mining_started_at +
          24 * 3600000
        : null;

    const left =
      end
        ? end - now()
        : 0;

    res.json({
      address: u.address,
      balance: u.balance,
      miningActive: left > 0,
      nextClaimAt:
        left > 0
          ? new Date(end).toISOString()
          : null,
      successfulReferrals:
        u.successful_referrals,
      referralBonusPercent:
        u.successful_referrals * 10,
      depositBonus:
        !!u.deposit_bonus,
      totalBonusPercent:
        u.successful_referrals * 10 +
        (u.deposit_bonus ? 10 : 0),
      speed: speedFor(u)
    });
  }
);

app.post(
  '/api/mining/start',
  auth,
  (req, res) => {
    try {
      const result =
        db.transaction(() => {

          let u = db
            .prepare(
              'SELECT * FROM users WHERE address=?'
            )
            .get(
              req.address
            );

          u = accrue(u);

          if (
            u.mining_started_at &&
            now() <
              u.mining_started_at +
              24 * 3600000
          ) {
            throw Object.assign(
              new Error(
                'Mining is already active'
              ),
              {
                status: 409
              }
            );
          }

          const wasNeverStarted =
            !u.mining_started_at;

          const startedAt =
            now();

          db.prepare(
            'UPDATE users SET mining_started_at=? WHERE address=?'
          ).run(
            startedAt,
            req.address
          );

          if (
            wasNeverStarted &&
            u.referrer
          ) {
            db.prepare(
              `UPDATE users
               SET successful_referrals=
               successful_referrals+1
               WHERE address=?`
            ).run(
              u.referrer
            );

            db.prepare(
              `UPDATE users
               SET referrer=NULL
               WHERE address=?`
            ).run(
              req.address
            );
          }

          return {
            ok: true,
            startedAt
          };
        })();

      res.json(result);

    } catch (e) {
      res
        .status(
          e.status || 500
        )
        .json({
          error:
            e.message ||
            'Unable to start mining'
        });
    }
  }
);

app.get(
  '/api/referral/link',
  auth,
  (req, res) => {
    let r = db
      .prepare(
        'SELECT code FROM referrals WHERE owner=?'
      )
      .get(
        req.address
      );

    if (!r) {
      const code =
        crypto.randomBytes(8)
          .toString('hex');

      db.prepare(
        'INSERT INTO referrals VALUES(?,?,?)'
      ).run(
        code,
        req.address,
        now()
      );

      r = {
        code
      };
    }

    const base =
      process.env.PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get('host')}`;

    res.json({
      url:
        `${base}/?ref=${r.code}`
    });
  }
);

app.post(
  '/api/referral/attach',
  auth,
  (req, res) => {
    const {
      code
    } = req.body;

    const ref = db
      .prepare(
        'SELECT owner FROM referrals WHERE code=?'
      )
      .get(code);

    if (
      !ref ||
      ref.owner === req.address
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid referral'
        });
    }

    const u = db
      .prepare(
        'SELECT referrer FROM users WHERE address=?'
      )
      .get(
        req.address
      );

    if (u.referrer) {
      return res
        .status(409)
        .json({
          error:
            'Referral already attached'
        });
    }

    db.prepare(
      'UPDATE users SET referrer=? WHERE address=?'
    ).run(
      ref.owner,
      req.address
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  '/api/deposit/invoice',
  auth,
  (req, res) => {
    if (!DEPOSIT_ADDRESS) {
      return res
        .status(503)
        .json({
          error:
            'Deposit address not configured'
        });
    }

    const invoiceId =
      crypto.randomUUID();

    const payload =
      `OPEN:${invoiceId}`;

    db.prepare(
      'INSERT INTO deposits VALUES(?,?,?,?,?,?,?)'
    ).run(
      invoiceId,
      req.address,
      DEPOSIT_ADDRESS,
      MIN_NANO.toString(),
      payload,
      now(),
      'pending'
    );

    res.json({
      invoiceId,
      address:
        DEPOSIT_ADDRESS,
      amountNano:
        MIN_NANO.toString(),
      payload
    });
  }
);

async function scanDeposits() {
  if (
    !DEPOSIT_ADDRESS ||
    !TONCENTER_ENDPOINT
  ) {
    return;
  }

  try {
    const u =
      new URL(
        TONCENTER_ENDPOINT
          .replace(/\/$/, '')
          .replace(
            '/jsonRPC',
            '/getTransactions'
          )
      );

    u.searchParams.set(
      'address',
      DEPOSIT_ADDRESS
    );

    u.searchParams.set(
      'limit',
      '50'
    );

    u.searchParams.set(
      'archival',
      'true'
    );

    const headers = {
      accept:
        'application/json'
    };

    if (TONCENTER_API_KEY) {
      headers['X-API-Key'] =
        TONCENTER_API_KEY;
    }

    const r = await fetch(
      u,
      {
        headers
      }
    );

    if (!r.ok) return;

    const j =
      await r.json();

    if (
      !j.ok ||
      !Array.isArray(j.result)
    ) {
      return;
    }

    const pending =
      db.prepare(
        `SELECT * FROM deposits
         WHERE status='pending'
         ORDER BY created_at ASC
         LIMIT 100`
      ).all();

    for (const d of pending) {

      const hit =
        j.result.find(tx => {

          const m =
            tx.in_msg;

          if (!m) return false;

          const msg =
            m.message || '';

          return (
            m.destination ===
              d.address &&
            BigInt(
              m.value || '0'
            ) >=
              BigInt(
                d.amount_nano
              ) &&
            msg ===
              d.payload &&
            !db.prepare(
              'SELECT 1 FROM deposits WHERE tx_hash=?'
            ).get(
              tx.transaction_id?.hash ||
                ''
            )
          );
        });

      if (!hit) continue;

      const txHash =
        hit.transaction_id?.hash;

      if (!txHash) continue;

      const owner =
        d.owner_address;

      const tx =
        db.transaction(() => {

          db.prepare(
            `UPDATE deposits
             SET status='confirmed',
                 tx_hash=?
             WHERE invoice_id=?
             AND status='pending'`
          ).run(
            txHash,
            d.invoice_id
          );

          db.prepare(
            `UPDATE users
             SET deposit_bonus=1
             WHERE address=?`
          ).run(
            owner
          );
        });

      tx();
    }

  } catch (e) {
    console.error(
      'deposit scan',
      e.message
    );
  }
}

setInterval(
  scanDeposits,
  15000
);

scanDeposits();

app.post(
  '/api/deposit/check',
  auth,
  (req, res) => {

    const d =
      db.prepare(
        `SELECT status,tx_hash
         FROM deposits
         WHERE owner_address=?
         ORDER BY created_at DESC
         LIMIT 1`
      ).get(
        req.address
      );

    res.json(
      d || {
        status: 'none',
        tx_hash: null
      }
    );
  }
);

app.get(
  '/api/health',
  (req, res) =>
    res.json({
      ok: true,
      network: NETWORK,
      depositConfigured:
        !!DEPOSIT_ADDRESS
    })
);

app.listen(
  PORT,
  () =>
    console.log(
      `OPEN Coin server listening on :${PORT}`
    )
);
