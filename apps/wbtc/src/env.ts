import { config } from "dotenv";
import { DEFAULT_CARRY_SETTINGS, DEFAULT_CARRY_THRESHOLDS, type CarrySettings, type CarryThresholds } from "@kdn/core";
import type { Address } from "viem";

// Its own env file, never the ETH bot's .env: a different wallet and Katana Perps account.
config({ path: process.env.WBTC_ENV_FILE || ".env.wbtc", quiet: true });
process.env.LOG_DIR ||= "data/wbtc/logs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env.wbtc.example)`);
  return value;
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

/** Percent in the env file, fraction in code. */
const pct = (name: string, fallback: number) => num(name, fallback * 100) / 100;

export const env = {
  rpcUrls: [
    process.env.KATANA_RPC_URL || "https://rpc.katana.network",
    ...(process.env.KATANA_RPC_FALLBACK_URLS ?? "https://katana.drpc.org").split(",").map((u) => u.trim()).filter(Boolean),
  ],
  /** Without a wallet the bot only runs the read-only market tracker. */
  wallet: process.env.WALLET_ADDRESS as Address | undefined,
  apiKey: () => required("KP_API_KEY"),
  apiSecret: () => required("KP_API_SECRET"),
  walletPrivateKey: () => required("WALLET_PRIVATE_KEY") as `0x${string}`,
  dbPath: process.env.DB_PATH || "data/wbtc/wbtc.db",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramPrefix: process.env.TELEGRAM_PREFIX ?? "[WBTC]",
  watchIntervalMs: num("WATCH_INTERVAL_MIN", 5) * 60_000,
  trackIntervalMs: num("TRACK_INTERVAL_MIN", 15) * 60_000,
  riskCheckIntervalMs: num("RISK_CHECK_INTERVAL_SEC", 15) * 1000,
  /** Deposit size the tracker models (Sushi cost of its slice, yield in BTC), in USD. */
  trackDepositUsd: num("TRACK_DEPOSIT_USD", 1000),
};

export const carry: CarrySettings = {
  targetLtv: pct("TARGET_LTV_PCT", DEFAULT_CARRY_SETTINGS.targetLtv),
  targetPerpLeverage: num("TARGET_PERP_LEVERAGE", DEFAULT_CARRY_SETTINGS.targetPerpLeverage),
  minPerpLeverage: num("MIN_PERP_LEVERAGE", DEFAULT_CARRY_SETTINGS.minPerpLeverage),
  maxPerpLeverage: num("MAX_PERP_LEVERAGE", DEFAULT_CARRY_SETTINGS.maxPerpLeverage),
  minLtv: pct("MIN_LTV_PCT", DEFAULT_CARRY_SETTINGS.minLtv),
  maxLtv: pct("MAX_LTV_PCT", DEFAULT_CARRY_SETTINGS.maxLtv),
  sliceBandPct: num("SLICE_BAND_PCT", DEFAULT_CARRY_SETTINGS.sliceBandPct),
  deltaBandPct: num("DELTA_BAND_PCT", DEFAULT_CARRY_SETTINGS.deltaBandPct),
  shrinkBorrowApy: pct("SHRINK_BORROW_APY_PCT", DEFAULT_CARRY_SETTINGS.shrinkBorrowApy),
  shrinkAfterHours: num("SHRINK_AFTER_HOURS", DEFAULT_CARRY_SETTINGS.shrinkAfterHours),
  resumeBorrowApy: pct("RESUME_BORROW_APY_PCT", DEFAULT_CARRY_SETTINGS.resumeBorrowApy),
  unwindBorrowApy: pct("UNWIND_BORROW_APY_PCT", DEFAULT_CARRY_SETTINGS.unwindBorrowApy),
  maxNegativeFundingPeriods: num("MAX_NEGATIVE_FUNDING_PERIODS", DEFAULT_CARRY_SETTINGS.maxNegativeFundingPeriods),
  retryPerpLeverage: num("RETRY_PERP_LEVERAGE", DEFAULT_CARRY_SETTINGS.retryPerpLeverage),
  shrinkPerpLeverage: num("SHRINK_PERP_LEVERAGE", DEFAULT_CARRY_SETTINGS.shrinkPerpLeverage),
  shrinkLtv: pct("SHRINK_LTV_PCT", DEFAULT_CARRY_SETTINGS.shrinkLtv),
  unwindLtv: pct("UNWIND_LTV_PCT", DEFAULT_CARRY_SETTINGS.unwindLtv),
  minTradeUsd: num("MIN_TRADE_USD", DEFAULT_CARRY_SETTINGS.minTradeUsd),
  walletReserveUsd: num("WALLET_RESERVE_USD", DEFAULT_CARRY_SETTINGS.walletReserveUsd),
  compoundMinUsd: num("COMPOUND_MIN_USD", DEFAULT_CARRY_SETTINGS.compoundMinUsd),
  compoundEveryDays: num("COMPOUND_EVERY_DAYS", DEFAULT_CARRY_SETTINGS.compoundEveryDays),
};

export const thresholds: CarryThresholds = {
  ...DEFAULT_CARRY_THRESHOLDS,
  alertNetBtcDriftPct: num("ALERT_NET_BTC_DRIFT_PCT", DEFAULT_CARRY_THRESHOLDS.alertNetBtcDriftPct),
  alertBasisPct: num("ALERT_BASIS_PCT", DEFAULT_CARRY_THRESHOLDS.alertBasisPct),
  killBasisPct: num("KILL_BASIS_PCT", DEFAULT_CARRY_THRESHOLDS.killBasisPct),
  alertBorrowApy: pct("ALERT_BORROW_APY_PCT", DEFAULT_CARRY_THRESHOLDS.alertBorrowApy),
};

/** Your planning ceiling for the borrow rate (H2). */
export const borrowCeiling = pct("BORROW_CEILING_PCT", 0.04);

export const autoRebalance = process.env.AUTO_REBALANCE === "true";
export const maxAutoRebalancesPerDay = num("MAX_AUTO_REBALANCES_PER_DAY", 6);

export const protectiveStop = {
  enabled: process.env.PROTECTIVE_STOP !== "false",
  /** Tighter than the ETH bot's 15%: at 3.3x a 15% gap would fire after a ~9% rally. */
  belowLiqPct: num("STOP_BELOW_LIQ_PCT", 5),
};

export const execution = {
  maxChunkUsd: num("MAX_CHUNK_USD", 250),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 50),
  /** Growth stops if a chunk's quoted price is this far above index. */
  maxSpotImpactPct: num("MAX_SPOT_IMPACT_PCT", 0.8),
  /** Collateral withdrawals never take LTV above this, so shrinking is done in safe chunks. */
  withdrawLtvCap: pct("WITHDRAW_LTV_CAP_PCT", 0.78),
  /** How long a margin withdrawal is waited for before the repay is left to the next check. */
  withdrawalWaitMs: num("WITHDRAWAL_WAIT_SEC", 180) * 1000,
};
