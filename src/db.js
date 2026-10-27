// SQLite-backed repository layer, via better-sqlite3. Its API is synchronous,
// which is what we want: each webhook is handled start to finish inside one
// transaction, with no awaits in between for another delivery to slip into.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// BILLING_DB_PATH lets tests point at a throwaway file (or ":memory:").
const dbPath = process.env.BILLING_DB_PATH || "./data/billing.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL"); // readers don't block the webhook writer
sqlite.pragma("busy_timeout = 5000"); // a second process waits for the lock instead of failing

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    stripe_customer_id  TEXT PRIMARY KEY,
    email               TEXT,
    subscription_status TEXT,
    plan                TEXT,
    current_period_end  TEXT
  );

  CREATE TABLE IF NOT EXISTS processed_events (
    event_id     TEXT NOT NULL UNIQUE,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const COLUMNS = {
  email: "email",
  subscriptionStatus: "subscription_status",
  plan: "plan",
  currentPeriodEnd: "current_period_end",
};

// Fields left out of an update keep their stored value (COALESCE), matching
// the old merge-on-write behaviour of the in-memory store.
const upsertStmt = sqlite.prepare(`
  INSERT INTO customers (stripe_customer_id, email, subscription_status, plan, current_period_end)
  VALUES (@id, @email, @subscriptionStatus, @plan, @currentPeriodEnd)
  ON CONFLICT (stripe_customer_id) DO UPDATE SET
    email               = COALESCE(excluded.email, email),
    subscription_status = COALESCE(excluded.subscription_status, subscription_status),
    plan                = COALESCE(excluded.plan, plan),
    current_period_end  = COALESCE(excluded.current_period_end, current_period_end)
`);
const getStmt = sqlite.prepare("SELECT * FROM customers WHERE stripe_customer_id = ?");
const allStmt = sqlite.prepare("SELECT * FROM customers ORDER BY rowid");
const seenStmt = sqlite.prepare("SELECT 1 FROM processed_events WHERE event_id = ?");
const claimStmt = sqlite.prepare(
  "INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT (event_id) DO NOTHING"
);

// Row -> the camelCase shape the rest of the app already uses; unset fields are omitted.
function toCustomer(row) {
  const customer = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (row[column] != null) customer[key] = row[column];
  }
  return customer;
}

export const db = {
  upsertCustomer(stripeCustomerId, data) {
    const params = { id: stripeCustomerId };
    for (const key of Object.keys(COLUMNS)) params[key] = data[key] ?? null;
    upsertStmt.run(params);
    return this.getCustomer(stripeCustomerId);
  },

  getCustomer(stripeCustomerId) {
    const row = getStmt.get(stripeCustomerId);
    return row ? toCustomer(row) : null;
  },

  allCustomers() {
    return allStmt.all().map((row) => ({ stripeCustomerId: row.stripe_customer_id, ...toCustomer(row) }));
  },

  // Idempotency lives in the UNIQUE constraint on processed_events.event_id,
  // not in application code. markProcessed is one atomic INSERT ... ON CONFLICT
  // DO NOTHING; it returns true only if this call inserted the row, so two
  // deliveries of the same event can never both get `true`.
  hasProcessed(eventId) {
    return seenStmt.get(eventId) !== undefined;
  },

  markProcessed(eventId) {
    return claimStmt.run(eventId).changes === 1;
  },

  // Claims the event and runs `handle` in a single transaction. If the claim
  // loses (duplicate), `handle` never runs. If `handle` throws, the claim is
  // rolled back too, so Stripe's retry of that event is processed normally.
  processEventOnce(eventId, handle) {
    return sqlite.transaction(() => {
      if (!this.markProcessed(eventId)) return false;
      handle();
      return true;
    }).immediate();
  },
};
