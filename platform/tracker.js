export function recordEvent(db, type, slot, signature, payload) {
  db.query(
    `INSERT INTO platform_events (type, slot, signature, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(type, slot ?? null, signature ?? null, JSON.stringify(payload ?? {}), Math.floor(Date.now() / 1000));
}

export function platformSummary(db) {
  const head = Number(db.query(`SELECT value FROM meta WHERE key = 'slot'`).get()?.value || 0);
  const genesis = db.query(`SELECT value FROM meta WHERE key = 'genesis_hash'`).get()?.value;
  const started = Number(db.query(`SELECT value FROM meta WHERE key = 'genesis_time'`).get()?.value || 0);
  const txCount = Number(db.query(`SELECT value FROM meta WHERE key = 'transaction_count'`).get()?.value || 0);
  const byType = db.query(
    `SELECT type, COUNT(*) AS n FROM platform_events GROUP BY type ORDER BY n DESC`,
  ).all();
  const last = db.query(
    `SELECT id, type, slot, signature, created_at FROM platform_events ORDER BY id DESC LIMIT 1`,
  ).get();
  const accounts = db.query(`SELECT COUNT(*) AS n FROM accounts`).get().n;
  const tokens = db.query(`SELECT COUNT(*) AS n FROM tokens`).get().n;
  const events = db.query(`SELECT COUNT(*) AS n FROM platform_events`).get().n;
  const blocks = db.query(`SELECT COUNT(*) AS n FROM blocks`).get().n;
  return {
    repository: 'block-of-the-future',
    chain: 'BKC',
    cluster: 'mainnet',
    genesisHash: genesis,
    genesisTime: started,
    indexedSlot: head,
    transactionCount: txCount,
    accounts,
    tokens,
    blocks,
    events,
    byType,
    lastEvent: last || null,
  };
}

export function listEvents(db, { type, limit = 50, before } = {}) {
  const cap = Math.min(Number(limit) || 50, 200);
  if (type && before) {
    return db.query(
      `SELECT id, type, slot, signature, payload, created_at
       FROM platform_events WHERE type = ? AND id < ? ORDER BY id DESC LIMIT ?`,
    ).all(type, Number(before), cap);
  }
  if (type) {
    return db.query(
      `SELECT id, type, slot, signature, payload, created_at
       FROM platform_events WHERE type = ? ORDER BY id DESC LIMIT ?`,
    ).all(type, cap);
  }
  if (before) {
    return db.query(
      `SELECT id, type, slot, signature, payload, created_at
       FROM platform_events WHERE id < ? ORDER BY id DESC LIMIT ?`,
    ).all(Number(before), cap);
  }
  return db.query(
    `SELECT id, type, slot, signature, payload, created_at
     FROM platform_events ORDER BY id DESC LIMIT ?`,
  ).all(cap);
}
