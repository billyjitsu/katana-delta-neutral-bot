import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CarryHoldings, CarryMetrics, CostEntry, FundingPayment, FundingRate, PerpFill } from "@kdn/core";

/** One tracker reading of the markets the strategy depends on. Needs no wallet. */
export interface Observation {
  time: number;
  indexPrice: number;
  markPrice: number;
  fundingRate: number;
  oraclePrice: number;
  sushiPrice: number;
  borrowApy: number;
  utilization: number;
  availableUsd: number;
  /** Sushi cost of buying the modeled slice, vs index, in %. */
  sliceBuyCostPct: number;
  sliceUsd: number;
  /** Yearly BTC yield at this moment's funding and borrow rate, as a share of the deposit. */
  modelYield: number;
}

export interface Snapshot {
  time: number;
  holdings: CarryHoldings;
  metrics: CarryMetrics;
  utilization: number;
  sushiPrice: number;
  gasEth: number;
}

export interface SwapRecord {
  txHash: string;
  time: number;
  direction: "buy" | "sell";
  btc: number;
  usdc: number;
  refPrice: number;
  route?: string;
}

/** WBTC added to (+) or taken out of (−) the deposit; compounding counts as added. */
export interface BtcFlow {
  time: number;
  btc: number;
  note: string;
}

/** A margin withdrawal, from request to arrival in the wallet (H7). */
export interface Withdrawal {
  id: number;
  requestedAt: number;
  usd: number;
  feeUsd: number;
  arrivedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (time INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (time INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funding_payments (time INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS funding_rates (time INTEGER PRIMARY KEY, rate REAL NOT NULL, index_price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS fills (fill_id TEXT PRIMARY KEY, time INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swaps (tx_hash TEXT PRIMARY KEY, time INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
  usd REAL NOT NULL, tx_hash TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS btc_flows (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, btc REAL NOT NULL, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS debt_flows (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, usd REAL NOT NULL, note TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, requested_at INTEGER NOT NULL, usd REAL NOT NULL, fee_usd REAL NOT NULL, arrived_at INTEGER
);
CREATE TABLE IF NOT EXISTS rebalances (id INTEGER PRIMARY KEY AUTOINCREMENT, time INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts_sent (code TEXT PRIMARY KEY, time INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

export class WbtcStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 10_000 });
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  private json<T>(sql: string, ...params: (number | string)[]): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => JSON.parse(r.data as string) as T);
  }

  saveObservation(o: Observation) {
    this.db.prepare("INSERT OR REPLACE INTO observations (time, data) VALUES (?, ?)").run(o.time, JSON.stringify(o));
  }

  observations(since = 0): Observation[] {
    return this.json("SELECT data FROM observations WHERE time >= ? ORDER BY time", since);
  }

  saveSnapshot(s: Snapshot) {
    this.db.prepare("INSERT OR REPLACE INTO snapshots (time, data) VALUES (?, ?)").run(s.time, JSON.stringify(s));
  }

  snapshots(since = 0): Snapshot[] {
    return this.json("SELECT data FROM snapshots WHERE time >= ? ORDER BY time", since);
  }

  saveFundingPayments(payments: FundingPayment[]) {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO funding_payments (time, data) VALUES (?, ?)");
    this.tx(() => payments.forEach((p) => stmt.run(p.time, JSON.stringify(p))));
  }

  fundingPayments(): FundingPayment[] {
    return this.json("SELECT data FROM funding_payments ORDER BY time");
  }

  saveFundingRates(rates: FundingRate[]) {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO funding_rates (time, rate, index_price) VALUES (?, ?, ?)");
    this.tx(() => rates.forEach((r) => stmt.run(r.time, r.rate, r.indexPrice)));
  }

  fundingRates(since = 0): FundingRate[] {
    return this.db
      .prepare("SELECT time, rate, index_price AS indexPrice FROM funding_rates WHERE time >= ? ORDER BY time")
      .all(since) as unknown as FundingRate[];
  }

  saveFills(fills: PerpFill[]) {
    const stmt = this.db.prepare("INSERT OR REPLACE INTO fills (fill_id, time, data) VALUES (?, ?, ?)");
    this.tx(() => fills.forEach((f) => stmt.run(f.fillId, f.time, JSON.stringify(f))));
  }

  fills(since = 0): PerpFill[] {
    return this.json("SELECT data FROM fills WHERE time >= ? ORDER BY time", since);
  }

  saveSwap(s: SwapRecord) {
    this.db.prepare("INSERT OR REPLACE INTO swaps (tx_hash, time, data) VALUES (?, ?, ?)").run(s.txHash, s.time, JSON.stringify(s));
  }

  swaps(): SwapRecord[] {
    return this.json("SELECT data FROM swaps ORDER BY time");
  }

  saveCost(c: CostEntry) {
    this.db
      .prepare("INSERT OR IGNORE INTO costs (time, kind, label, usd, tx_hash) VALUES (?, ?, ?, ?, ?)")
      .run(c.time, c.kind, c.label, c.usd, c.txHash ?? null);
  }

  costs(): CostEntry[] {
    return this.db.prepare("SELECT time, kind, label, usd, tx_hash AS txHash FROM costs ORDER BY time").all() as unknown as CostEntry[];
  }

  addBtcFlow(f: BtcFlow) {
    this.db.prepare("INSERT INTO btc_flows (time, btc, note) VALUES (?, ?, ?)").run(f.time, f.btc, f.note);
  }

  btcFlows(): BtcFlow[] {
    return this.db.prepare("SELECT time, btc, note FROM btc_flows ORDER BY time").all() as unknown as BtcFlow[];
  }

  /** Target net BTC: everything deposited and compounded, minus withdrawals. */
  depositBtc(): number {
    return this.btcFlows().reduce((sum, f) => sum + f.btc, 0);
  }

  /** Principal borrowed (+) or repaid (−), so interest = debt − principal. */
  addDebtFlow(usd: number, note: string) {
    this.db.prepare("INSERT INTO debt_flows (time, usd, note) VALUES (?, ?, ?)").run(Date.now(), usd, note);
  }

  principal(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM debt_flows").get() as { total: number };
    return row.total;
  }

  addWithdrawal(usd: number, feeUsd: number): number {
    const result = this.db.prepare("INSERT INTO withdrawals (requested_at, usd, fee_usd) VALUES (?, ?, ?)").run(Date.now(), usd, feeUsd);
    return Number(result.lastInsertRowid);
  }

  markWithdrawalArrived(id: number, time = Date.now()) {
    this.db.prepare("UPDATE withdrawals SET arrived_at = ? WHERE id = ? AND arrived_at IS NULL").run(time, id);
  }

  withdrawals(): Withdrawal[] {
    return this.db
      .prepare("SELECT id, requested_at AS requestedAt, usd, fee_usd AS feeUsd, arrived_at AS arrivedAt FROM withdrawals ORDER BY id")
      .all() as unknown as Withdrawal[];
  }

  addRebalance(data: Record<string, unknown>) {
    this.db.prepare("INSERT INTO rebalances (time, data) VALUES (?, ?)").run(Date.now(), JSON.stringify(data));
  }

  rebalances(since = 0): { time: number; data: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT time, data FROM rebalances WHERE time >= ? ORDER BY time").all(since) as Row[]).map((r) => ({
      time: r.time as number,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  lastAlertTime(code: string): number | undefined {
    const row = this.db.prepare("SELECT time FROM alerts_sent WHERE code = ?").get(code) as { time: number } | undefined;
    return row?.time;
  }

  markAlertSent(code: string, time: number) {
    this.db.prepare("INSERT OR REPLACE INTO alerts_sent (code, time) VALUES (?, ?)").run(code, time);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value || undefined;
  }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
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
}
