import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Node's built-in SQLite: no native module to compile, so it installs anywhere Node 24 runs.
import { DatabaseSync } from "node:sqlite";
import type { CapitalFlow, CostEntry, FundingPayment, FundingRate, PerpFill, Snapshot, StateStore, SwapRecord } from "@kdn/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (time INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funding_payments (
  time INTEGER NOT NULL, market TEXT NOT NULL, payment_usd REAL NOT NULL,
  position_qty REAL NOT NULL, rate REAL NOT NULL, index_price REAL NOT NULL,
  PRIMARY KEY (time, market)
);
CREATE TABLE IF NOT EXISTS funding_rates (time INTEGER PRIMARY KEY, rate REAL NOT NULL, index_price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS fills (
  fill_id TEXT PRIMARY KEY, time INTEGER NOT NULL, side TEXT NOT NULL, price REAL NOT NULL,
  qty REAL NOT NULL, quote_qty REAL NOT NULL, fee_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS swaps (
  tx_hash TEXT PRIMARY KEY, time INTEGER NOT NULL, direction TEXT NOT NULL, eth_amount REAL NOT NULL,
  usdc_amount REAL NOT NULL, ref_price REAL NOT NULL, gas_eth REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS capital (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, usd REAL NOT NULL, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts_sent (code TEXT PRIMARY KEY, time INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  usd REAL NOT NULL, tx_hash TEXT UNIQUE
);
`;

/** Columns added after the first release; ALTER fails harmlessly when they already exist. */
const MIGRATIONS = [
  "ALTER TABLE swaps ADD COLUMN route TEXT",
  "ALTER TABLE swaps ADD COLUMN pool_fee_pct REAL",
  "ALTER TABLE fills ADD COLUMN index_price REAL",
];

export class SqliteStore implements StateStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    // watch and CLI commands share the file; wait for a lock instead of failing with "database is
    // locked". Set before anything else, since even the journal_mode pragma may need the lock.
    this.db = new DatabaseSync(path, { timeout: 10_000 });
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch {
        // column already exists
      }
    }
  }

  async saveSnapshot(s: Snapshot) {
    this.db.prepare("INSERT OR REPLACE INTO snapshots (time, data) VALUES (?, ?)").run(s.time, JSON.stringify(s));
  }

  async latestSnapshot() {
    const row = this.db.prepare("SELECT data FROM snapshots ORDER BY time DESC LIMIT 1").get() as unknown as { data: string } | undefined;
    return row && (JSON.parse(row.data) as Snapshot);
  }

  async snapshots(since = 0) {
    const rows = this.db.prepare("SELECT data FROM snapshots WHERE time >= ? ORDER BY time").all(since) as unknown as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Snapshot);
  }

  async saveFundingPayments(payments: FundingPayment[]) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO funding_payments (time, market, payment_usd, position_qty, rate, index_price) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.tx(() =>
      payments.forEach((p) => stmt.run(p.time, p.market, p.paymentUsd, p.positionQty, p.rate, p.indexPrice)));
  }

  async fundingPayments() {
    return this.db
      .prepare(
        "SELECT time, market, payment_usd AS paymentUsd, position_qty AS positionQty, rate, index_price AS indexPrice FROM funding_payments ORDER BY time",
      )
      .all() as unknown as FundingPayment[];
  }

  async saveFundingRates(rates: FundingRate[]) {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO funding_rates (time, rate, index_price) VALUES (?, ?, ?)");
    this.tx(() =>
      rates.forEach((r) => stmt.run(r.time, r.rate, r.indexPrice)));
  }

  async fundingRates(since = 0) {
    return this.db
      .prepare("SELECT time, rate, index_price AS indexPrice FROM funding_rates WHERE time >= ? ORDER BY time")
      .all(since) as unknown as FundingRate[];
  }

  async saveFills(fills: PerpFill[]) {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO fills (fill_id, time, side, price, qty, quote_qty, fee_usd, index_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.tx(() =>
      fills.forEach((f) => stmt.run(f.fillId, f.time, f.side, f.price, f.qty, f.quoteQty, f.feeUsd, f.indexPrice ?? null)),
    );
  }

  async fills(since = 0) {
    return this.db
      .prepare(
        "SELECT fill_id AS fillId, time, side, price, qty, quote_qty AS quoteQty, fee_usd AS feeUsd, index_price AS indexPrice FROM fills WHERE time >= ? ORDER BY time",
      )
      .all(since) as unknown as PerpFill[];
  }

  /** Upsert that keeps route details when a later on-chain scan re-records the same swap without them. */
  async saveSwap(s: SwapRecord) {
    this.db
      .prepare(
        `INSERT INTO swaps (tx_hash, time, direction, eth_amount, usdc_amount, ref_price, gas_eth, route, pool_fee_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tx_hash) DO UPDATE SET
           time = excluded.time, direction = excluded.direction, eth_amount = excluded.eth_amount,
           usdc_amount = excluded.usdc_amount, ref_price = excluded.ref_price, gas_eth = excluded.gas_eth,
           route = COALESCE(excluded.route, swaps.route), pool_fee_pct = COALESCE(excluded.pool_fee_pct, swaps.pool_fee_pct)`,
      )
      .run(s.txHash, s.time, s.direction, s.ethAmount, s.usdcAmount, s.refPrice, s.gasEth, s.route ?? null, s.poolFeePct ?? null);
  }

  async swaps() {
    return this.db
      .prepare(
        "SELECT tx_hash AS txHash, time, direction, eth_amount AS ethAmount, usdc_amount AS usdcAmount, ref_price AS refPrice, gas_eth AS gasEth, route, pool_fee_pct AS poolFeePct FROM swaps ORDER BY time",
      )
      .all() as unknown as SwapRecord[];
  }

  async saveCost(c: CostEntry) {
    this.db
      .prepare("INSERT OR IGNORE INTO costs (time, kind, label, usd, tx_hash) VALUES (?, ?, ?, ?, ?)")
      .run(c.time, c.kind, c.label, c.usd, c.txHash ?? null);
  }

  async costs() {
    return this.db.prepare("SELECT time, kind, label, usd, tx_hash AS txHash FROM costs ORDER BY time").all() as unknown as CostEntry[];
  }

  async addCapital(c: CapitalFlow) {
    this.db.prepare("INSERT INTO capital (time, usd, note) VALUES (?, ?, ?)").run(c.time, c.usd, c.note);
  }

  async capitalFlows() {
    return this.db.prepare("SELECT time, usd, note FROM capital ORDER BY time").all() as unknown as CapitalFlow[];
  }

  private tx(fn: () => void) {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Bot-only helpers, not part of StateStore.

  lastAlertTime(code: string): number | undefined {
    const row = this.db.prepare("SELECT time FROM alerts_sent WHERE code = ?").get(code) as unknown as { time: number } | undefined;
    return row?.time;
  }

  markAlertSent(code: string, time: number) {
    this.db.prepare("INSERT OR REPLACE INTO alerts_sent (code, time) VALUES (?, ?)").run(code, time);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }
}
