import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  sha256,
  blockhashFrom,
  makeSignature,
  mulberry32,
  pick,
  randInt,
  pubkeyFromSeed,
  LAMPORTS_PER_BKC,
} from './crypto.js';
import {
  CLUSTER,
  PROGRAMS,
  MINTS,
  LABELS,
  TOKEN_HOLDERS_EXTRA,
  materializeKeys,
} from './genesis.js';
import { recordEvent } from '../platform/tracker.js';

const FEE = CLUSTER.feeLamports;
const HISTORY_SLOTS = 360;
const LIVE_TX_MIN = 4;
const LIVE_TX_MAX = 14;

function schema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS accounts (
      pubkey TEXT PRIMARY KEY,
      lamports TEXT NOT NULL,
      owner TEXT NOT NULL,
      executable INTEGER DEFAULT 0,
      data TEXT,
      rent_epoch INTEGER DEFAULT 0,
      label TEXT
    );
    CREATE TABLE IF NOT EXISTS blocks (
      slot INTEGER PRIMARY KEY,
      blockhash TEXT UNIQUE NOT NULL,
      parent_slot INTEGER,
      previous_blockhash TEXT,
      block_time INTEGER,
      tx_count INTEGER,
      leader TEXT,
      rewards TEXT DEFAULT '0'
    );
    CREATE TABLE IF NOT EXISTS transactions (
      signature TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      block_time INTEGER,
      fee INTEGER,
      status TEXT,
      err TEXT,
      fee_payer TEXT,
      signer TEXT,
      instructions TEXT,
      account_keys TEXT,
      logs TEXT,
      compute_units INTEGER,
      amount TEXT,
      currency TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_slot ON transactions(slot);
    CREATE INDEX IF NOT EXISTS idx_tx_signer ON transactions(signer);
    CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(block_time DESC);
    CREATE TABLE IF NOT EXISTS tx_accounts (
      signature TEXT,
      pubkey TEXT,
      PRIMARY KEY (signature, pubkey)
    );
    CREATE INDEX IF NOT EXISTS idx_txa_pubkey ON tx_accounts(pubkey);
    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT,
      symbol TEXT,
      decimals INTEGER,
      supply TEXT,
      mint_authority TEXT,
      freeze_authority TEXT,
      description TEXT
    );
    CREATE TABLE IF NOT EXISTS token_accounts (
      pubkey TEXT PRIMARY KEY,
      mint TEXT,
      owner TEXT,
      amount TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ta_owner ON token_accounts(owner);
    CREATE INDEX IF NOT EXISTS idx_ta_mint ON token_accounts(mint);
    CREATE TABLE IF NOT EXISTS validators (
      identity TEXT PRIMARY KEY,
      vote TEXT,
      name TEXT,
      commission INTEGER,
      activated_stake TEXT,
      last_vote INTEGER,
      delinquent INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS platform_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      slot INTEGER,
      signature TEXT,
      payload TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pe_slot ON platform_events(slot);
    CREATE TABLE IF NOT EXISTS banking_ledger (
      id TEXT PRIMARY KEY,
      account_pubkey TEXT,
      amount TEXT,
      currency TEXT,
      status TEXT,
      blockchain_hash TEXT UNIQUE,
      oracle_signature TEXT,
      validator_node_id TEXT,
      note TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bl_hash ON banking_ledger(blockchain_hash);
  `);
}

function metaGet(db, key, fallback = null) {
  const row = db.query('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function metaSet(db, key, value) {
  db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
function bi(v) {
  return BigInt(v ?? 0);
}
function accGet(db, pubkey) {
  return db.query('SELECT * FROM accounts WHERE pubkey = ?').get(pubkey);
}
function accSetLamports(db, pubkey, lamports) {
  db.query('UPDATE accounts SET lamports = ? WHERE pubkey = ?').run(String(lamports), pubkey);
}
function tokenAccGet(db, pubkey) {
  return db.query('SELECT * FROM token_accounts WHERE pubkey = ?').get(pubkey);
}
function tokenAccSet(db, pubkey, amount) {
  db.query('UPDATE token_accounts SET amount = ? WHERE pubkey = ?').run(String(amount), pubkey);
}
function ensureTokenAccount(db, mint, owner) {
  const pubkey = pubkeyFromSeed(`tokenacc:${mint}:${owner}`);
  const existing = tokenAccGet(db, pubkey);
  if (existing) return existing;
  db.query(
    'INSERT INTO token_accounts (pubkey, mint, owner, amount) VALUES (?, ?, ?, ?)',
  ).run(pubkey, mint, owner, '0');
  db.query(
    `INSERT INTO accounts (pubkey, lamports, owner, executable, data, label)
     VALUES (?, '0', ?, 0, ?, ?)
     ON CONFLICT(pubkey) DO NOTHING`,
  ).run(pubkey, PROGRAMS.token, JSON.stringify({ mint, owner, amount: '0' }), `BKCX account`);
  return tokenAccGet(db, pubkey);
}

function insertAccount(db, { pubkey, lamports, owner, executable = 0, data = null, label = null }) {
  db.query(
    `INSERT INTO accounts (pubkey, lamports, owner, executable, data, label)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET lamports = excluded.lamports, label = COALESCE(excluded.label, accounts.label)`,
  ).run(pubkey, String(lamports), owner, executable, data, label);
}

function bootstrap(db) {
  const keys = materializeKeys();
  const now = Date.now() - HISTORY_SLOTS * CLUSTER.slotMs;
  metaSet(db, 'slot', '0');
  metaSet(db, 'transaction_count', '0');
  metaSet(db, 'genesis_hash', CLUSTER.genesisHash);
  metaSet(db, 'genesis_time', String(now));
  metaSet(db, 'cluster', CLUSTER.cluster);
  metaSet(db, 'native_symbol', 'BKC');
  metaSet(db, 'repo', 'bankchainai/BankchainAI-TheBlocksofthefuture');

  insertAccount(db, {
    pubkey: PROGRAMS.system, lamports: 1, owner: PROGRAMS.system, executable: 1, label: 'System Program',
  });
  for (const [id, pk] of Object.entries(PROGRAMS)) {
    if (id === 'system') continue;
    insertAccount(db, {
      pubkey: pk, lamports: 1, owner: PROGRAMS.system, executable: 1, label: LABELS[pk],
    });
  }

  for (const a of Object.values(keys.accounts)) {
    insertAccount(db, {
      pubkey: a.pubkey, lamports: a.lamports, owner: PROGRAMS.system, label: a.label,
    });
  }
  for (const c of keys.customers) {
    insertAccount(db, {
      pubkey: c.pubkey, lamports: c.lamports, owner: PROGRAMS.system, label: c.label,
    });
  }
  for (const v of keys.validators) {
    insertAccount(db, {
      pubkey: v.identity, lamports: 2_000_000_000, owner: PROGRAMS.system, label: v.name,
    });
    insertAccount(db, {
      pubkey: v.vote, lamports: 1, owner: PROGRAMS.vote, label: `${v.name} (vote)`,
      data: JSON.stringify({ nodePubkey: v.identity, commission: v.commission }),
    });
    insertAccount(db, {
      pubkey: v.stakeAccount, lamports: v.lamports, owner: PROGRAMS.stake, label: `${v.name} (stake)`,
      data: JSON.stringify({ voter: v.vote, stake: String(v.lamports) }),
    });
    db.query(
      `INSERT INTO validators (identity, vote, name, commission, activated_stake, last_vote, delinquent)
       VALUES (?, ?, ?, ?, ?, 0, 0)`,
    ).run(v.identity, v.vote, v.name, v.commission, String(v.lamports));
  }

  const bkcxSupply = TOKEN_HOLDERS_EXTRA.reduce((s, h) => s + BigInt(h.amount), 0n)
    + keys.customers.reduce((s, c) => s + BigInt(c.bkcx), 0n);
  db.query(
    `INSERT INTO tokens (mint, name, symbol, decimals, supply, mint_authority, freeze_authority, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    MINTS.bkcx,
    'Bank Tokens',
    'BKCX',
    6,
    String(bkcxSupply),
    keys.accounts.treasury.pubkey,
    keys.accounts.treasury.pubkey,
    'BankChainAI Bank Tokens (BKCX) — platform settlement asset tracked by The Blocks of the Future',
  );
  insertAccount(db, {
    pubkey: MINTS.bkcx,
    lamports: 1,
    owner: PROGRAMS.token,
    label: 'BKCX (Bank Tokens)',
    data: JSON.stringify({ mint: true, decimals: 6, symbol: 'BKCX' }),
  });

  for (const extra of TOKEN_HOLDERS_EXTRA) {
    const owner = keys.accounts[extra.key].pubkey;
    const ta = ensureTokenAccount(db, MINTS.bkcx, owner);
    tokenAccSet(db, ta.pubkey, extra.amount);
  }
  for (const c of keys.customers) {
    const ta = ensureTokenAccount(db, MINTS.bkcx, c.pubkey);
    tokenAccSet(db, ta.pubkey, c.bkcx);
  }

  recordEvent(db, 'genesis', 0, CLUSTER.genesisHash, {
    cluster: CLUSTER.name,
    native: 'BKC',
    token: 'BKCX',
    repo: 'Mw-2025/bankchainai-Theblocksofthefuture',
  });

  const rng = mulberry32(0xbcc1);
  const startTime = now;
  for (let i = 1; i <= HISTORY_SLOTS; i++) {
    produceBlock(db, {
      forcedTime: startTime + i * CLUSTER.slotMs,
      rng,
      historical: true,
    });
  }
}

function leaders(db) {
  return db.query('SELECT * FROM validators ORDER BY identity').all();
}

function ixCompute() {
  return {
    programId: PROGRAMS.computeBudget,
    programName: 'Compute Budget',
    type: 'SetComputeUnitLimit',
    parsed: { units: 200_000 },
    accounts: [],
  };
}

function applyBkcTransfer(db, from, to, amount) {
  const src = accGet(db, from);
  const dst = accGet(db, to);
  if (!src || !dst) return { ok: false, err: 'AccountNotFound' };
  const need = bi(amount) + BigInt(FEE);
  if (bi(src.lamports) < need) return { ok: false, err: 'InsufficientFunds' };
  accSetLamports(db, from, bi(src.lamports) - need);
  accSetLamports(db, to, bi(dst.lamports) + bi(amount));
  return { ok: true };
}

function applyBkcxTransfer(db, fromOwner, toOwner, amount) {
  const fromTa = ensureTokenAccount(db, MINTS.bkcx, fromOwner);
  const toTa = ensureTokenAccount(db, MINTS.bkcx, toOwner);
  if (bi(fromTa.amount) < bi(amount)) return { ok: false, err: 'InsufficientTokens' };
  const payer = accGet(db, fromOwner);
  if (!payer || bi(payer.lamports) < BigInt(FEE)) return { ok: false, err: 'InsufficientFunds' };
  accSetLamports(db, fromOwner, bi(payer.lamports) - BigInt(FEE));
  tokenAccSet(db, fromTa.pubkey, bi(fromTa.amount) - bi(amount));
  tokenAccSet(db, toTa.pubkey, bi(toTa.amount) + bi(amount));
  return { ok: true, fromTa: fromTa.pubkey, toTa: toTa.pubkey };
}

function insertTx(db, tx) {
  db.query(
    `INSERT INTO transactions
      (signature, slot, block_time, fee, status, err, fee_payer, signer, instructions, account_keys, logs, compute_units, amount, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tx.signature, tx.slot, tx.block_time, tx.fee, tx.status, tx.err || null, tx.fee_payer, tx.signer,
    JSON.stringify(tx.instructions, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    JSON.stringify(tx.account_keys), JSON.stringify(tx.logs),
    tx.compute_units, tx.amount || '0', tx.currency || 'BKC',
  );
  const uniq = [...new Set(tx.account_keys)];
  const stmt = db.query('INSERT OR IGNORE INTO tx_accounts (signature, pubkey) VALUES (?, ?)');
  for (const pk of uniq) stmt.run(tx.signature, pk);
  const n = Number(metaGet(db, 'transaction_count', '0')) + 1;
  metaSet(db, 'transaction_count', n);
}

function makeTx({ slot, index, payer, instructions, account_keys, status, err, amount, currency, logs, block_time }) {
  const payload = JSON.stringify({ slot, index, payer, instructions, amount: String(amount ?? 0), currency, status });
  return {
    signature: makeSignature(slot, index, payload),
    slot,
    block_time,
    fee: FEE,
    status,
    err,
    fee_payer: payer,
    signer: payer,
    instructions,
    account_keys,
    logs: logs || [
      `Program ${instructions[0]?.programId} invoke [1]`,
      status === 'success' ? 'Program log: Instruction: ' + (instructions.find((i) => i.type !== 'SetComputeUnitLimit')?.type || 'Unknown') : `Program log: Error: ${err}`,
      status === 'success' ? `Program ${instructions[instructions.length - 1]?.programId} success` : `Program failed: ${err}`,
    ],
    compute_units: status === 'success' ? 4120 + (index % 800) : 1200,
    amount: String(amount || 0),
    currency: currency || 'BKC',
  };
}

function randomLiveTx(db, slot, index, rng, block_time) {
  const customers = db.query(
    `SELECT pubkey, lamports, label FROM accounts
     WHERE label LIKE 'Bank Customer%' ORDER BY pubkey`,
  ).all();
  const treasury = db.query(`SELECT pubkey FROM accounts WHERE label = 'BKF Treasury'`).get();
  const roll = rng();
  const from = pick(rng, customers);
  let to = pick(rng, customers);
  if (to.pubkey === from.pubkey) to = pick(rng, customers);

  if (roll < 0.55) {
    const maxSend = bi(from.lamports) / 200n;
    const amount = maxSend > 1_000_000n ? BigInt(randInt(rng, 1_000_000, Number(maxSend > 50_000_000_000n ? 50_000_000_000n : maxSend))) : 1_000_000n;
    const res = applyBkcTransfer(db, from.pubkey, to.pubkey, amount);
    const ixs = [
      ixCompute(),
      {
        programId: PROGRAMS.system,
        programName: 'System Program',
        type: 'Transfer',
        parsed: { source: from.pubkey, destination: to.pubkey, lamports: String(amount), amountBkc: Number(amount) / Number(LAMPORTS_PER_BKC) },
        accounts: [from.pubkey, to.pubkey],
      },
    ];
    return makeTx({
      slot, index, payer: from.pubkey, instructions: ixs,
      account_keys: [from.pubkey, to.pubkey, PROGRAMS.system, PROGRAMS.computeBudget],
      status: res.ok ? 'success' : 'fail', err: res.err, amount, currency: 'BKC', block_time,
    });
  }

  if (roll < 0.82) {
    const fromTa = ensureTokenAccount(db, MINTS.bkcx, from.pubkey);
    const raw = bi(fromTa.amount);
    const amount = raw > 1_000_000n ? BigInt(randInt(rng, 100_000, Number(raw > 25_000_000n ? 25_000_000n : raw / 8n || 100_000n))) : 100_000n;
    const res = applyBkcxTransfer(db, from.pubkey, to.pubkey, amount);
    const ixs = [
      ixCompute(),
      {
        programId: PROGRAMS.token,
        programName: 'Bank Token Program',
        type: 'Transfer',
        parsed: {
          source: res.fromTa || from.pubkey,
          destination: res.toTa || to.pubkey,
          authority: from.pubkey,
          mint: MINTS.bkcx,
          amount: String(amount),
          uiAmount: Number(amount) / 1_000_000,
          symbol: 'BKCX',
        },
        accounts: [res.fromTa, res.toTa, from.pubkey, MINTS.bkcx].filter(Boolean),
      },
    ];
    return makeTx({
      slot, index, payer: from.pubkey, instructions: ixs,
      account_keys: [from.pubkey, to.pubkey, MINTS.bkcx, PROGRAMS.token, PROGRAMS.computeBudget],
      status: res.ok ? 'success' : 'fail', err: res.err, amount, currency: 'BKCX', block_time,
    });
  }

  if (roll < 0.90 && treasury) {
    const memo = `BankChainAI ledger sync · customer ${from.label}`;
    const ixs = [
      {
        programId: PROGRAMS.memo,
        programName: 'Memo Program',
        type: 'Memo',
        parsed: { memo },
        accounts: [from.pubkey],
      },
    ];
    const payer = accGet(db, from.pubkey);
    if (payer && bi(payer.lamports) >= BigInt(FEE)) {
      accSetLamports(db, from.pubkey, bi(payer.lamports) - BigInt(FEE));
    }
    return makeTx({
      slot, index, payer: from.pubkey, instructions: ixs,
      account_keys: [from.pubkey, PROGRAMS.memo],
      status: 'success', amount: 0, currency: 'BKC', block_time,
      logs: [`Program ${PROGRAMS.memo} invoke [1]`, `Program log: Memo (len ${memo.length}): ${memo}`, 'Program success'],
    });
  }

  if (roll < 0.97 && treasury) {
    const amount = BigInt(randInt(rng, 50_000, 400_000));
    const mintAuth = treasury.pubkey;
    const ta = ensureTokenAccount(db, MINTS.bkcx, from.pubkey);
    const authAcc = accGet(db, mintAuth);
    if (authAcc && bi(authAcc.lamports) >= BigInt(FEE)) {
      accSetLamports(db, mintAuth, bi(authAcc.lamports) - BigInt(FEE));
      tokenAccSet(db, ta.pubkey, bi(ta.amount) + amount);
      const tok = db.query('SELECT supply FROM tokens WHERE mint = ?').get(MINTS.bkcx);
      db.query('UPDATE tokens SET supply = ? WHERE mint = ?').run(String(bi(tok.supply) + amount), MINTS.bkcx);
    }
    const ixs = [
      ixCompute(),
      {
        programId: PROGRAMS.token,
        programName: 'Bank Token Program',
        type: 'MintTo',
        parsed: { mint: MINTS.bkcx, account: ta.pubkey, mintAuthority: mintAuth, amount: String(amount), symbol: 'BKCX', uiAmount: Number(amount) / 1_000_000 },
        accounts: [MINTS.bkcx, ta.pubkey, mintAuth],
      },
    ];
    return makeTx({
      slot, index, payer: mintAuth, instructions: ixs,
      account_keys: [mintAuth, from.pubkey, MINTS.bkcx, PROGRAMS.token, PROGRAMS.computeBudget],
      status: 'success', amount, currency: 'BKCX', block_time,
    });
  }

  const amount = 5_000_000_000n;
  const ixs = [
    ixCompute(),
    {
      programId: PROGRAMS.system,
      programName: 'System Program',
      type: 'Transfer',
      parsed: { source: from.pubkey, destination: to.pubkey, lamports: String(amount) },
      accounts: [from.pubkey, to.pubkey],
    },
  ];
  return makeTx({
    slot, index, payer: from.pubkey, instructions: ixs,
    account_keys: [from.pubkey, to.pubkey, PROGRAMS.system],
    status: 'fail', err: 'InsufficientFunds', amount, currency: 'BKC', block_time,
  });
}

function produceBlock(db, { forcedTime, rng, historical } = {}) {
  const parent = Number(metaGet(db, 'slot', '0'));
  const slot = parent + 1;
  const vals = leaders(db);
  const leader = vals[slot % vals.length];
  const prevHash = parent === 0
    ? CLUSTER.genesisHash
    : (db.query('SELECT blockhash FROM blocks WHERE slot = ?').get(parent)?.blockhash || CLUSTER.genesisHash);
  const blockhash = blockhashFrom(slot, prevHash);
  const block_time = forcedTime || Date.now();
  const nRng = rng || Math.random;
  const rand = typeof nRng === 'function' && nRng() < 2 ? nRng : nRng;
  const rnd = historical ? rng : () => Math.random();
  const txCount = historical ? randInt(rnd, 6, 16) : randInt(rnd, LIVE_TX_MIN, LIVE_TX_MAX);

  const txs = [];
  for (let i = 0; i < txCount; i++) {
    txs.push(randomLiveTx(db, slot, i, rnd, block_time));
  }

  const reward = 50_000_000n + BigInt(txCount * FEE);
  const leaderAcc = accGet(db, leader.identity);
  if (leaderAcc) accSetLamports(db, leader.identity, bi(leaderAcc.lamports) + reward);

  db.query(
    `INSERT INTO blocks (slot, blockhash, parent_slot, previous_blockhash, block_time, tx_count, leader, rewards)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(slot, blockhash, parent === 0 ? null : parent, prevHash, block_time, txs.length, leader.identity, String(reward));

  for (const tx of txs) {
    insertTx(db, tx);
    const kind = tx.currency === 'BKCX'
      ? (tx.instructions.some((i) => i.type === 'MintTo') ? 'token_mint' : 'token_transfer')
      : (tx.instructions.some((i) => i.type === 'Memo') ? 'memo' : 'transfer');
    recordEvent(db, kind, slot, tx.signature, {
      status: tx.status,
      currency: tx.currency,
      amount: tx.amount,
      signer: tx.signer,
    });
    if (tx.status === 'success' && (tx.currency === 'BKC' || tx.currency === 'BKCX') && kind !== 'memo') {
      const id = pubkeyFromSeed(`ledger:${tx.signature}`).slice(0, 36);
      db.query(
        `INSERT OR IGNORE INTO banking_ledger
          (id, account_pubkey, amount, currency, status, blockchain_hash, oracle_signature, validator_node_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        tx.signer,
        tx.amount,
        tx.currency,
        tx.status === 'success' ? 'COMPLETED' : 'REJECTED',
        tx.signature,
        sha256('oracle', tx.signature).toString('hex').slice(0, 64),
        leader.identity,
        `Indexed from BKC slot ${slot}`,
        block_time,
      );
    }
  }

  db.query('UPDATE validators SET last_vote = ?').run(slot);
  metaSet(db, 'slot', slot);
  recordEvent(db, 'block_produced', slot, blockhash, {
    leader: leader.identity,
    leaderName: leader.name,
    txCount: txs.length,
    rewards: String(reward),
  });

  if (slot % CLUSTER.slotsPerEpoch === 0 && slot > 0) {
    recordEvent(db, 'epoch_boundary', slot, blockhash, { epoch: Math.floor(slot / CLUSTER.slotsPerEpoch) });
  }

  void rand;
  return { slot, blockhash, txCount: txs.length };
}

function parsePayload(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const k of ['instructions', 'account_keys', 'logs', 'payload', 'data']) {
    if (typeof copy[k] === 'string') {
      try { copy[k] = JSON.parse(copy[k]); } catch { /* keep */ }
    }
  }
  return copy;
}

function epochInfo(slot) {
  const epoch = Math.floor(slot / CLUSTER.slotsPerEpoch);
  const slotIndex = slot % CLUSTER.slotsPerEpoch;
  return {
    epoch,
    slotIndex,
    slotsInEpoch: CLUSTER.slotsPerEpoch,
    absoluteSlot: slot,
    blockHeight: slot,
    transactionCount: null,
    epochProgress: slotIndex / CLUSTER.slotsPerEpoch,
  };
}

export function createChain({ dbPath, startProducer = true } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  schema(db);
  const empty = !db.query('SELECT 1 FROM meta WHERE key = ?').get('genesis_hash');
  if (empty) {
    db.exec('BEGIN');
    bootstrap(db);
    db.exec('COMMIT');
  }

  let timer = null;
  const produceLive = () => {
    try {
      db.exec('BEGIN');
      produceBlock(db, {});
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      console.error('block production failed', err);
    }
  };
  if (startProducer) timer = setInterval(produceLive, CLUSTER.slotMs);

  const api = {
    db,
    cluster: CLUSTER,
    programs: PROGRAMS,
    mints: MINTS,
    labels: LABELS,
    produceNow: produceLive,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    close() {
      api.stop();
      db.close();
    },
    stats() {
      const slot = Number(metaGet(db, 'slot', '0'));
      const txCount = Number(metaGet(db, 'transaction_count', '0'));
      const genesisTime = Number(metaGet(db, 'genesis_time', '0'));
      const samples = db.query(
        `SELECT block_time, tx_count FROM blocks WHERE slot > ? ORDER BY slot DESC LIMIT 150`,
      ).all(Math.max(0, slot - 150));
      let tps = 0;
      let slotMs1m = CLUSTER.slotMs;
      const asMs = (t) => (Number(t) > 1e12 ? Number(t) : Number(t) * 1000);
      if (samples.length >= 2) {
        const newest = asMs(samples[0].block_time);
        const oldest = asMs(samples[samples.length - 1].block_time);
        const dt = Math.max(1, newest - oldest);
        const txs = samples.reduce((s, b) => s + b.tx_count, 0);
        tps = txs / (dt / 1000);
        slotMs1m = dt / Math.max(1, samples.length - 1);
      }
      const hour = db.query(
        `SELECT MIN(block_time) AS a, MAX(block_time) AS b, COUNT(*) AS n FROM blocks WHERE block_time >= ?`,
      ).get(Date.now() - 3600_000);
      let slotMs1h = CLUSTER.slotMs;
      if (hour && hour.n > 1) slotMs1h = (asMs(hour.b) - asMs(hour.a)) / (hour.n - 1);
      const ep = epochInfo(slot);
      const remainingSlots = ep.slotsInEpoch - ep.slotIndex;
      const remainingSec = (remainingSlots * slotMs1m) / 1000;
      const supply = api.supply();
      const stake = db.query('SELECT SUM(CAST(activated_stake AS INTEGER)) AS n FROM validators').get()?.n || 0;
      return {
        cluster: CLUSTER.cluster,
        clusterName: CLUSTER.name,
        genesisHash: metaGet(db, 'genesis_hash'),
        repo: metaGet(db, 'repo'),
        slot,
        blockHeight: slot,
        blockTime: db.query('SELECT block_time FROM blocks WHERE slot = ?').get(slot)?.block_time || Math.floor(Date.now() / 1000),
        slotTime1m: slotMs1m,
        slotTime1h: slotMs1h,
        epoch: ep.epoch,
        epochProgress: ep.epochProgress,
        epochSlotIndex: ep.slotIndex,
        slotsInEpoch: ep.slotsInEpoch,
        epochTimeRemaining: remainingSec,
        transactionCount: txCount,
        tps,
        tps1m: tps,
        circulatingSupply: supply.circulating,
        totalSupply: supply.total,
        nonCirculating: supply.nonCirculating,
        activeStake: String(stake),
        nativeSymbol: 'BKC',
        tokenSymbol: 'BKCX',
        genesisTime,
      };
    },
    recentBlocks(limit = 25) {
      return db.query(
        `SELECT b.*, v.name AS leader_name
         FROM blocks b LEFT JOIN validators v ON v.identity = b.leader
         ORDER BY b.slot DESC LIMIT ?`,
      ).all(Math.min(Number(limit) || 25, 100));
    },
    recentTxs(limit = 25) {
      return db.query(
        `SELECT signature, slot, block_time, fee, status, err, fee_payer, signer, instructions, amount, currency
         FROM transactions ORDER BY slot DESC, signature DESC LIMIT ?`,
      ).all(Math.min(Number(limit) || 25, 100)).map(parsePayload);
    },
    getBlock(slot) {
      const b = db.query(
        `SELECT b.*, v.name AS leader_name
         FROM blocks b LEFT JOIN validators v ON v.identity = b.leader
         WHERE b.slot = ?`,
      ).get(Number(slot));
      if (!b) return null;
      const txs = db.query(
        `SELECT * FROM transactions WHERE slot = ? ORDER BY signature`,
      ).all(Number(slot)).map(parsePayload);
      return { ...b, transactions: txs };
    },
    getTx(signature) {
      const tx = db.query('SELECT * FROM transactions WHERE signature = ?').get(signature);
      if (!tx) return null;
      const block = db.query('SELECT blockhash, leader FROM blocks WHERE slot = ?').get(tx.slot);
      return { ...parsePayload(tx), blockhash: block?.blockhash, leader: block?.leader };
    },
    getAccount(pubkey) {
      const acc = accGet(db, pubkey);
      if (!acc) return null;
      const tokens = db.query(
        `SELECT ta.*, t.symbol, t.name, t.decimals, t.mint
         FROM token_accounts ta JOIN tokens t ON t.mint = ta.mint
         WHERE ta.owner = ? OR ta.pubkey = ?`,
      ).all(pubkey, pubkey);
      const txCount = db.query('SELECT COUNT(*) AS n FROM tx_accounts WHERE pubkey = ?').get(pubkey)?.n || 0;
      const recent = db.query(
        `SELECT t.signature, t.slot, t.block_time, t.status, t.fee, t.amount, t.currency, t.instructions, t.signer
         FROM tx_accounts a JOIN transactions t ON t.signature = a.signature
         WHERE a.pubkey = ? ORDER BY t.slot DESC LIMIT 30`,
      ).all(pubkey).map(parsePayload);
      const owned = db.query('SELECT * FROM token_accounts WHERE pubkey = ?').get(pubkey);
      return {
        ...parsePayload(acc),
        label: acc.label || LABELS[pubkey] || null,
        tokens,
        txCount,
        recent,
        tokenAccount: owned || null,
        executable: !!acc.executable,
      };
    },
    getToken(mint) {
      const t = db.query('SELECT * FROM tokens WHERE mint = ?').get(mint);
      if (!t) return null;
      const holders = db.query(
        `SELECT ta.*, a.label FROM token_accounts ta
         LEFT JOIN accounts a ON a.pubkey = ta.owner
         WHERE ta.mint = ? ORDER BY CAST(ta.amount AS INTEGER) DESC LIMIT 25`,
      ).all(mint);
      const recent = db.query(
        `SELECT signature, slot, block_time, status, signer, amount, currency, instructions
         FROM transactions WHERE currency = 'BKCX' ORDER BY slot DESC LIMIT 20`,
      ).all().map(parsePayload);
      const holderCount = db.query('SELECT COUNT(*) AS n FROM token_accounts WHERE mint = ? AND CAST(amount AS INTEGER) > 0').get(mint)?.n || 0;
      return { ...t, holders, recent, holderCount };
    },
    tokens() {
      return db.query('SELECT * FROM tokens').all().map((t) => {
        const holders = db.query('SELECT COUNT(*) AS n FROM token_accounts WHERE mint = ? AND CAST(amount AS INTEGER) > 0').get(t.mint)?.n || 0;
        return { ...t, holderCount: holders };
      });
    },
    supply() {
      const rows = db.query('SELECT lamports, label FROM accounts').all();
      let total = 0n;
      let non = 0n;
      for (const r of rows) {
        const v = bi(r.lamports);
        total += v;
        if (r.label && /non-circulating|Reserves|stake\)/i.test(r.label)) non += v;
      }
      const stake = db.query(`SELECT SUM(CAST(lamports AS INTEGER)) AS n FROM accounts WHERE owner = ?`).get(PROGRAMS.stake);
      return {
        total: String(total),
        circulating: String(total - non),
        nonCirculating: String(non),
        circulatingBkc: Number(total - non) / Number(LAMPORTS_PER_BKC),
        totalBkc: Number(total) / Number(LAMPORTS_PER_BKC),
        nativeDecimals: 9,
        stakeLamports: String(stake?.n || 0),
      };
    },
    validators() {
      const slot = Number(metaGet(db, 'slot', '0'));
      return db.query('SELECT * FROM validators ORDER BY CAST(activated_stake AS INTEGER) DESC').all()
        .map((v) => ({ ...v, lastVote: v.last_vote, epochCredits: slot }));
    },
    search(q) {
      const query = String(q || '').trim();
      if (!query) return { type: 'empty' };
      if (/^\d+$/.test(query)) {
        const b = api.getBlock(Number(query));
        if (b) return { type: 'block', slot: Number(query) };
      }
      const tx = db.query('SELECT signature FROM transactions WHERE signature = ?').get(query);
      if (tx) return { type: 'transaction', signature: query };
      if (query === MINTS.bkcx || query.toUpperCase() === 'BKCX') return { type: 'token', mint: MINTS.bkcx };
      if (query.toUpperCase() === 'BKC') return { type: 'supply' };
      const acc = accGet(db, query);
      if (acc) return { type: 'account', pubkey: query };
      const label = db.query('SELECT pubkey, label FROM accounts WHERE label LIKE ? LIMIT 8').all(`%${query}%`);
      if (label.length === 1) return { type: 'account', pubkey: label[0].pubkey };
      if (label.length > 1) return { type: 'accounts', matches: label };
      const prefixTx = db.query('SELECT signature FROM transactions WHERE signature LIKE ? LIMIT 1').get(`${query}%`);
      if (prefixTx) return { type: 'transaction', signature: prefixTx.signature };
      const prefixAcc = db.query('SELECT pubkey FROM accounts WHERE pubkey LIKE ? LIMIT 1').get(`${query}%`);
      if (prefixAcc) return { type: 'account', pubkey: prefixAcc.pubkey };
      return { type: 'not_found', query };
    },
    performance() {
      const slot = Number(metaGet(db, 'slot', '0'));
      const rows = db.query(
        `SELECT CAST(slot / 150 AS INTEGER) AS bucket, COUNT(*) AS slots, SUM(tx_count) AS txs,
                MIN(block_time) AS t0, MAX(block_time) AS t1
         FROM blocks WHERE slot > ? GROUP BY bucket ORDER BY bucket DESC LIMIT 12`,
      ).all(Math.max(0, slot - 1800));
      return rows.map((r) => ({
        numSlots: r.slots,
        numTransactions: r.txs,
        samplePeriodSecs: Math.max(1, r.t1 - r.t0),
        slot: r.bucket * 150,
      }));
    },
    submitBankingTx({ from, to, amount, currency = 'BKC', note }) {
      const slot = Number(metaGet(db, 'slot', '0')) + 1;
      // applied in next block by inserting a pending? For demo, execute immediately inside a mini-block append is wrong.
      // Instead apply now and include in a synthetic recorded tx at current slot end — simpler: apply and store, explorer shows it.
      const now = Math.floor(Date.now() / 1000);
      const amt = BigInt(amount);
      let res;
      let ixs;
      let keys;
      if (currency === 'BKCX') {
        res = applyBkcxTransfer(db, from, to, amt);
        ixs = [ixCompute(), {
          programId: PROGRAMS.token, programName: 'Bank Token Program', type: 'Transfer',
          parsed: { authority: from, destination: to, amount: String(amt), mint: MINTS.bkcx, symbol: 'BKCX', note },
          accounts: [from, to, MINTS.bkcx],
        }];
        keys = [from, to, MINTS.bkcx, PROGRAMS.token];
      } else {
        res = applyBkcTransfer(db, from, to, amt);
        ixs = [ixCompute(), {
          programId: PROGRAMS.system, programName: 'System Program', type: 'Transfer',
          parsed: { source: from, destination: to, lamports: String(amt), note },
          accounts: [from, to],
        }];
        keys = [from, to, PROGRAMS.system];
      }
      const curSlot = Number(metaGet(db, 'slot', '0'));
      const tx = makeTx({
        slot: curSlot, index: Date.now() % 9999, payer: from, instructions: ixs, account_keys: keys,
        status: res.ok ? 'success' : 'fail', err: res.err, amount: amt, currency, block_time: now,
      });
      insertTx(db, tx);
      db.query('UPDATE blocks SET tx_count = tx_count + 1 WHERE slot = ?').run(curSlot);
      recordEvent(db, 'platform_submit', curSlot, tx.signature, { from, to, amount: String(amt), currency, note, status: tx.status });
      if (res.ok) {
        const id = pubkeyFromSeed(`ledger:${tx.signature}`).slice(0, 36);
        const leader = db.query('SELECT leader FROM blocks WHERE slot = ?').get(curSlot)?.leader;
        db.query(
          `INSERT OR IGNORE INTO banking_ledger
            (id, account_pubkey, amount, currency, status, blockchain_hash, oracle_signature, validator_node_id, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, from, String(amt), currency, 'COMPLETED', tx.signature, sha256('oracle', tx.signature).toString('hex').slice(0, 64), leader || '', note || 'platform', now);
      }
      return { ok: res.ok, err: res.err, signature: tx.signature, slot: curSlot };
    },
  };

  return api;
}
