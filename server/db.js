/**
 * Database layer — libsql/SQLite.
 * Local dev: file ./data/promptora.db
 * Production (Vercel): set DATABASE_URL=libsql://… (Turso) + DATABASE_AUTH_TOKEN
 *
 * Tables: users, sessions, subscriptions, payments,
 *         payme_transactions, webhook_events, usage_counters
 */
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (config.db.url.startsWith("file:")) {
  const file = config.db.url.slice("file:".length);
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
}

export const db = createClient(
  config.db.authToken
    ? { url: config.db.url, authToken: config.db.authToken }
    : { url: config.db.url },
);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    google_sub TEXT,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','premium')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('free','pro','premium')),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','expired','canceled','superseded')),
    provider TEXT,
    billing TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly','yearly')),
    current_period_start INTEGER NOT NULL,
    current_period_end INTEGER NOT NULL,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    last_payment_id INTEGER REFERENCES payments(id),
    mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','sandbox')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL CHECK (plan IN ('free','pro','premium')),
    billing TEXT NOT NULL DEFAULT 'monthly' CHECK (billing IN ('monthly','yearly')),
    amount_uzs INTEGER NOT NULL CHECK (amount_uzs >= 0),
    currency TEXT NOT NULL DEFAULT 'UZS',
    provider TEXT NOT NULL CHECK (provider IN ('click','payme')),
    status TEXT NOT NULL DEFAULT 'created'
      CHECK (status IN ('created','prepared','paid','cancelled','failed','refunded')),
    mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live','sandbox')),
    merchant_trans_id TEXT NOT NULL UNIQUE,
    provider_payment_id TEXT,
    error_note TEXT,
    created_at INTEGER NOT NULL,
    prepared_at INTEGER,
    paid_at INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_tx
     ON payments(provider, provider_payment_id)
     WHERE provider_payment_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS payme_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payme_id TEXT NOT NULL UNIQUE,
    payment_id INTEGER NOT NULL REFERENCES payments(id),
    time INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    account TEXT NOT NULL,
    state INTEGER NOT NULL,
    create_time INTEGER NOT NULL,
    perform_time INTEGER NOT NULL DEFAULT 0,
    cancel_time INTEGER NOT NULL DEFAULT 0,
    reason INTEGER,
    raw TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payme_payment ON payme_transactions(payment_id)`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_type TEXT,
    payload TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_events(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS usage_lifetime (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    count INTEGER NOT NULL DEFAULT 0
  )`,
  // NOTE: the users.google_sub unique index is created in migrateLegacy()
  // because legacy databases need the column added before it can be indexed.
  `CREATE TABLE IF NOT EXISTS usage_counters (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  )`,
];

/**
 * Migrations for databases created before the paid Free tier ($2 plan)
 * and Google sign-in existed:
 *   - users.google_sub column + unique index
 *   - payments/subscriptions must accept plan='free' — CHECK constraints
 *     cannot be ALTERed in SQLite, so the tables are rebuilt.
 */
async function migrateLegacy() {
  const colInfo = await db.execute("PRAGMA table_info(users)");
  const hasGoogleSub = colInfo.rows.some((r) => String(r.name) === "google_sub");

  // Rebuild tables with FK enforcement off: dropping/creating referenced
  // tables inside the swap would otherwise trip FOREIGN KEY constraints.
  await db.execute("PRAGMA foreign_keys=OFF");
  try {
    if (!hasGoogleSub) {
      await db.execute("ALTER TABLE users ADD COLUMN google_sub TEXT");
    }
    for (const table of ["payments", "subscriptions"]) {
      const row = await db.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        args: [table],
      });
      const tableSql = String(row.rows[0]?.sql ?? "");
      if (!tableSql || tableSql.includes("'free'")) continue; // already current

      const rebuilt = tableSql
        .replace(
          /CHECK\s*\(\s*plan\s+IN\s*\('pro','premium'\)\s*\)/i,
          "CHECK (plan IN ('free','pro','premium'))",
        )
        .replace(
          new RegExp("CREATE TABLE (IF NOT EXISTS )?" + table + "(?=[^A-Za-z0-9_])", "i"),
          `CREATE TABLE ${table}__new`,
        );
      if (rebuilt === tableSql) {
        throw new Error(`[db] could not rewrite CHECK constraint for ${table}`);
      }
      await db.execute({ sql: rebuilt, args: [] });
      await db.execute({ sql: `INSERT INTO ${table}__new SELECT * FROM ${table}`, args: [] });
      await db.execute({ sql: `DROP TABLE ${table}`, args: [] });
      await db.execute({ sql: `ALTER TABLE ${table}__new RENAME TO ${table}`, args: [] });
    }
  } finally {
    await db.execute("PRAGMA foreign_keys=ON");
  }

  // Safe now — the column exists in both fresh and migrated schemas.
  await db.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL",
  );

  // Rebuilding drops old indexes — recreate them.
  await db.execute("CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC)");
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_tx ON payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status)");

  const violations = await db.execute("PRAGMA foreign_key_check");
  if (violations.rows.length) {
    console.error(`[db] foreign_key_check reported ${violations.rows.length} violation(s) after migration`);
  }
}

let ready = null;
/** Idempotent schema migration. */
export function initDb() {
  if (!ready) {
    ready = (async () => {
      for (const stmt of SCHEMA) await db.execute(stmt);
      await migrateLegacy();
    })();
  }
  return ready;
}

/** Run fn inside an IMMEDIATE write transaction (serialises concurrent webhooks). */
export async function withTransaction(fn) {
  const tx = await db.transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch { /* already closed */ }
    throw err;
  }
}

export const now = () => Date.now();
