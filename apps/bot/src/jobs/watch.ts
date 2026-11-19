import { PERP_MIN_ORDER_ETH, evaluateFastRisk } from "@kdn/core";
import { autoRebalanceTick, pause, pauseState } from "../auto";
import type { Context } from "../context";
import { autoRebalance, env, protectiveStop, riskCheckIntervalMs, strategy, thresholds } from "../env";
import { logEvent } from "../log";
import { dispatchAlerts, send } from "../notify";
import { runTelegramCommands, watchStatus } from "../telegram";
import { createTradingContext, type TradingContext } from "../wallet";
import { maintainStop } from "./protect";
import { checkPosition } from "./snapshot";
import { syncFunding, syncSwaps } from "./sync";

/** After a fast check triggers a rebalance, don't trigger again this soon (the full check still runs). */
const URGENT_COOLDOWN_MS = 2 * 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Short size as of our last own action or check. A drop between checks that we didn't cause is a stop fill, liquidation or ADL. */
let knownShort: number | null = null;

async function checkShortGone(ctx: Context, short: number, indexPrice: number) {
  const before = knownShort;
  knownShort = short;
  if (before === null || before - short < PERP_MIN_ORDER_ETH) return;
  const stop = watchStatus.stop;
  const stopFired = stop !== null && indexPrice >= stop.triggerPrice * 0.995;
  const what = stopFired
    ? `Protective stop filled (index $${indexPrice.toFixed(2)} ≥ trigger $${stop.triggerPrice})`
    : `Short shrank without our order (liquidation or ADL?)`;
  const reason = `${what}: short ${before.toFixed(3)} → ${short.toFixed(3)} ETH`;
  logEvent("alert", { code: "SHORT_GONE", level: "urgent", message: reason });
  // Spot is now unhedged long and the reserve may be spent: a person decides how to re-enter.
  if (!pauseState(ctx.store)) pause(ctx.store, reason);
  await send(`🚨 ${reason}. Spot is now unhedged. Auto-rebalance paused: re-hedge (\`hedge --go\`) or sell spot, then /resume.`);
}

/**
 * Every 15 s: perp-only risk check (1 account call + market data, no chain reads). If leverage
 * leaves its band or liquidation gets close, rebalance right away instead of waiting.
 */
async function fastCheck(ctx: Context, trading: TradingContext | undefined, lastUrgentAt: number): Promise<number> {
  const [account, market] = await Promise.all([ctx.perps.account(), ctx.perps.market()]);
  const risk = evaluateFastRisk(
    {
      shortEth: Math.max(-(account.position?.qty ?? 0), 0),
      perpEquity: account.equity,
      markPrice: market.markPrice,
      liquidationPrice: account.position?.liquidationPrice ?? 0,
    },
    strategy.maxLeverage,
    thresholds,
  );
  watchStatus.lastRiskCheckAt = Date.now();
  watchStatus.leverage = risk.leverage;
  await checkShortGone(ctx, Math.max(-(account.position?.qty ?? 0), 0), market.indexPrice);
  await dispatchAlerts(ctx.store, risk.alerts);

  if (!risk.urgent || !trading || Date.now() - lastUrgentAt < URGENT_COOLDOWN_MS) return lastUrgentAt;
  console.log(`${new Date().toISOString()}  risk check: leverage ${risk.leverage?.toFixed(2)}x, liquidation +${risk.rallyToLiquidationPct?.toFixed(1)}% → rebalancing now`);
  logEvent("rebalance", { phase: "urgent", leverage: risk.leverage, rallyToLiquidationPct: risk.rallyToLiquidationPct });
  await autoRebalanceTick(ctx, trading);
  watchStatus.stop = await maintainStop(trading);
  knownShort = Math.max(-((await ctx.perps.account()).position?.qty ?? 0), 0);
  return Date.now();
}

/** Every 5 min: sync funding and swaps, rebalance by the full rules, refresh the stop, snapshot, alerts. */
async function fullCheck(ctx: Context, trading: TradingContext | undefined) {
  await syncFunding(ctx);
  await syncSwaps(ctx);
  if (trading) {
    // A stop fill since the last check must be caught before our own rebalance moves the baseline.
    const [account, market] = await Promise.all([ctx.perps.account(), ctx.perps.market()]);
    await checkShortGone(ctx, Math.max(-(account.position?.qty ?? 0), 0), market.indexPrice);
    await autoRebalanceTick(ctx, trading);
    watchStatus.stop = await maintainStop(trading);
  }
  const { snapshot, alerts } = await checkPosition(ctx);
  knownShort = Math.max(-snapshot.perpQty, 0);
  await dispatchAlerts(ctx.store, alerts);
  Object.assign(watchStatus, { lastTickAt: Date.now(), lastTickOk: true, lastError: "", lastAlerts: alerts });
  console.log(
    `${new Date(snapshot.time).toISOString()}  short ${snapshot.perpQty.toFixed(4)}  spot ${snapshot.spotEth.toFixed(4)}  ` +
      `lev ${snapshot.perpLeverage.toFixed(2)}x  stop ${watchStatus.stop ? `$${watchStatus.stop.triggerPrice}` : "none"}  alerts ${alerts.length}`,
  );
}

export async function watch(ctx: Context) {
  const trading = autoRebalance ? createTradingContext(ctx) : undefined;
  watchStatus.autoRebalance = Boolean(trading);
  const paused = pauseState(ctx.store);
  await send(
    `Tracker started for ${ctx.wallet}: risk check every ${riskCheckIntervalMs / 1000}s, full check every ${env.watchIntervalMs / 60_000} min, ` +
      `auto-rebalance ${trading ? (paused ? "PAUSED" : "ON") : "off"}, protective stop ${trading && protectiveStop.enabled ? "on" : "off"}. Send /help for commands.`,
  ).catch((err) => console.error(`Startup message failed: ${err instanceof Error ? err.message : String(err)}`));
  void runTelegramCommands(ctx);

  let lastFull = 0;
  let lastUrgent = 0;
  for (;;) {
    const full = Date.now() - lastFull >= env.watchIntervalMs;
    try {
      if (full) {
        lastFull = Date.now();
        await fullCheck(ctx, trading);
      } else {
        lastUrgent = await fastCheck(ctx, trading, lastUrgent);
      }
    } catch (err) {
      // Message only: SDK errors carry request headers, including the API key.
      console.error(`${new Date().toISOString()} ${full ? "full" : "risk"} check failed: ${message(err)}`);
      logEvent("error", { where: full ? "watch:full" : "watch:risk", message: message(err) });
      if (full) {
        Object.assign(watchStatus, { lastTickAt: Date.now(), lastTickOk: false, lastError: message(err) });
        await send(`⚠️ Full check failed: ${message(err)}`).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, riskCheckIntervalMs));
  }
}
