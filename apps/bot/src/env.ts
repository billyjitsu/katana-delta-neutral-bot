import "dotenv/config";
import { DEFAULT_THRESHOLDS, type StrategySettings, type Thresholds } from "@kdn/core";
import type { Address } from "viem";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.example)`);
  return value;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

export const env = {
  /** Primary RPC first; the fallbacks take a call when the one before it fails or rate-limits. */
  rpcUrls: [
    process.env.KATANA_RPC_URL || "https://rpc.katana.network",
    ...(process.env.KATANA_RPC_FALLBACK_URLS ?? "https://katana.drpc.org").split(",").map((u) => u.trim()).filter(Boolean),
  ],
  wallet: () => required("WALLET_ADDRESS") as Address,
  apiKey: () => required("KP_API_KEY"),
  apiSecret: () => required("KP_API_SECRET"),
  dbPath: process.env.DB_PATH || "data/bot.db",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  watchIntervalMs: num("WATCH_INTERVAL_MIN", 5) * 60_000,
  /** "direct" = 0.05% vbUSDC/vbETH pool only; "search" = all fee tiers + two-hop routes (needs a keyed RPC). */
  swapRouting: (process.env.SWAP_ROUTING === "search" ? "search" : "direct") as "direct" | "search",
  walletPrivateKey: () => required("WALLET_PRIVATE_KEY") as `0x${string}`,
};

export const strategy: StrategySettings = {
  targetLeverage: num("TARGET_LEVERAGE", 2),
  minLeverage: num("MIN_LEVERAGE", 1.5),
  maxLeverage: num("MAX_LEVERAGE", 2.5),
  reservePct: num("RESERVE_PCT", 5),
  rebalanceBandPct: num("REBALANCE_BAND_PCT", 10),
  deltaBandPct: num("ALERT_DELTA_PCT", DEFAULT_THRESHOLDS.alertDeltaPct),
  minTradeUsd: num("MIN_TRADE_USD", 5),
  maxNegativeFundingPeriods: DEFAULT_THRESHOLDS.killNegativeFundingPeriods,
  avgFundingPeriods: num("AVG_FUNDING_PERIODS", DEFAULT_THRESHOLDS.avgFundingPeriods),
  /** Half the usual 0.01%/8h: growing on a rate flickering near zero costs more than it earns. */
  minGrowFundingRate: num("MIN_GROW_FUNDING_RATE", 0.00005),
  allowWithdraw: process.env.ALLOW_WITHDRAW === "true",
};

/** When true, `watch` executes rebalances itself instead of only alerting. */
export const autoRebalance = process.env.AUTO_REBALANCE === "true";

/** Fast risk check (perp data only) between full checks. */
export const riskCheckIntervalMs = num("RISK_CHECK_INTERVAL_SEC", 15) * 1000;

/**
 * Exchange-side reduce-only stop on the short, STOP_BELOW_LIQ_PCT under the liquidation price.
 * Maintained by watch whenever auto-rebalance is enabled (paused or not).
 */
export const protectiveStop = {
  enabled: process.env.PROTECTIVE_STOP !== "false",
  belowLiqPct: num("STOP_BELOW_LIQ_PCT", 15),
};

/** Auto mode pauses itself after this many executed rebalances in 24h, in case something churns. */
export const maxAutoRebalancesPerDay = num("MAX_AUTO_REBALANCES_PER_DAY", 6);

export const execution = {
  maxChunkUsd: num("MAX_CHUNK_USD", 250),
  /** Swap reverts if output is this far below the pre-trade quote. */
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 30),
  /** Entry stops if a chunk's quoted price is this far above index. */
  maxSpotImpactPct: num("MAX_SPOT_IMPACT_PCT", 0.5),
};

export const thresholds: Thresholds = {
  ...DEFAULT_THRESHOLDS,
  alertLeverage: num("ALERT_LEVERAGE", DEFAULT_THRESHOLDS.alertLeverage),
  alertDeltaPct: num("ALERT_DELTA_PCT", DEFAULT_THRESHOLDS.alertDeltaPct),
  urgentDeltaPct: num("URGENT_DELTA_PCT", DEFAULT_THRESHOLDS.urgentDeltaPct),
  avgFundingPeriods: num("AVG_FUNDING_PERIODS", DEFAULT_THRESHOLDS.avgFundingPeriods),
  alertBasisPct: num("ALERT_BASIS_PCT", DEFAULT_THRESHOLDS.alertBasisPct),
};
