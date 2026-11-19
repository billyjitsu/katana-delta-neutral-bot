import { evaluateCarryAlerts, planCarry, type CarryHoldings } from "@kdn/core";
import { logEvent } from "@kdn/bot/log";
import { autoRebalanceTick, pauseState } from "../auto";
import { createAccountContext, type AccountContext, type Context } from "../context";
import { autoRebalance, carry, env, protectiveStop, thresholds } from "../env";
import { dispatchAlerts, send } from "../notify";
import { createTradingContext, type TradingContext } from "../wallet";
import { maintainStop, type StopState } from "./protect";
import { checkPosition, negativeFundingStreak, planContext, syncFunding, syncRates, type LiveState } from "./state";
import { formatObservation, observe } from "./track";

/** After a fast check triggers a rebalance, don't trigger again this soon (the full check still runs). */
const URGENT_COOLDOWN_MS = 2 * 60_000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface WatchState {
  last?: LiveState;
  stop: StopState | null;
  lastUrgentAt: number;
}

/**
 * Every 15 s: perp account + Morpho position and oracle (wallet balances from the last full check).
 * Acts right away on the ladder: an emergency step, or perp leverage out of its band.
 */
async function fastCheck(ctx: AccountContext, trading: TradingContext | undefined, w: WatchState) {
  if (!w.last) return;
  const [account, market, morpho] = await Promise.all([ctx.perps.account(), ctx.perps.market(), ctx.morpho.read(ctx.wallet)]);
  const holdings: CarryHoldings = {
    ...w.last.holdings,
    depositBtc: ctx.store.depositBtc(),
    collateralBtc: morpho.position.collateral,
    debtUsd: morpho.position.debt,
    perpEquity: account.equity,
    perpQty: account.position?.qty ?? 0,
    markPrice: market.markPrice,
    indexPrice: market.indexPrice,
    oraclePrice: morpho.state.oraclePrice,
    fundingRate: market.currentFundingRate,
    borrowApy: morpho.state.borrowApy,
    lltv: morpho.state.lltv,
  };
  const live = { ...w.last, holdings, morpho: morpho.state, account };
  const plan = planCarry(holdings, carry, planContext(ctx, live));
  const ladder = evaluateCarryAlerts(
    { holdings, metrics: plan.metrics, utilization: morpho.state.utilization, sushiPrice: w.last.sushiPrice, gasEth: w.last.gasEth, negativeFundingStreak: negativeFundingStreak(ctx) },
    carry,
    thresholds,
  ).filter((a) => a.code.startsWith("PERP_LEV") || a.code.startsWith("LTV_"));
  await dispatchAlerts(ctx.store, ladder);

  const marginMove = plan.steps.some((s) => s.kind === "topUp" || s.kind === "release");
  if (!(plan.urgency === "emergency" || marginMove) || !trading || Date.now() - w.lastUrgentAt < URGENT_COOLDOWN_MS) return;
  console.log(`${new Date().toISOString()}  risk check: ${plan.reasons.join("; ")} → rebalancing now`);
  logEvent("rebalance", { phase: "urgent", urgency: plan.urgency, reasons: plan.reasons });
  w.lastUrgentAt = Date.now();
  await autoRebalanceTick(ctx, trading);
  w.stop = await maintainStop(trading);
}

/** Every WATCH_INTERVAL_MIN: sync funding, rebalance by the full rules, refresh the stop, snapshot, alerts. */
async function fullCheck(ctx: AccountContext, trading: TradingContext | undefined, w: WatchState) {
  await syncFunding(ctx);
  if (trading) {
    await autoRebalanceTick(ctx, trading);
    w.stop = await maintainStop(trading);
  }
  const { state, snapshot, alerts } = await checkPosition(ctx);
  w.last = state;
  await dispatchAlerts(ctx.store, alerts);
  const m = snapshot.metrics;
  console.log(
    `${new Date(snapshot.time).toISOString()}  net ${m.netBtc.toFixed(5)} BTC (${m.netBtcDriftPct.toFixed(2)}%)  slice ${m.sliceBtc.toFixed(5)}  short ${m.shortBtc.toFixed(4)}  ` +
      `LTV ${m.ltv === null ? "—" : (m.ltv * 100).toFixed(1) + "%"}  perp ${m.perpLeverage?.toFixed(2) ?? "—"}x  stop ${w.stop ? `$${w.stop.triggerPrice}` : "none"}  alerts ${alerts.length}`,
  );
}

export async function watch(ctx: Context) {
  const account = env.wallet ? createAccountContext(ctx) : undefined;
  const trading = account && autoRebalance ? createTradingContext(account) : undefined;
  const paused = account && pauseState(ctx.store);
  const mode = !account
    ? "tracker only (no WALLET_ADDRESS)"
    : `position watch for ${account.wallet}, auto-rebalance ${trading ? (paused ? "PAUSED" : "ON") : "off"}, protective stop ${trading && protectiveStop.enabled ? "on" : "off"}`;
  await send(`WBTC carry bot started: ${mode}. Market tracker every ${env.trackIntervalMs / 60_000} min.`).catch((err) =>
    console.error(`Startup message failed: ${message(err)}`),
  );

  const w: WatchState = { stop: null, lastUrgentAt: 0 };
  let lastTrack = 0;
  let lastFull = 0;
  for (;;) {
    const now = Date.now();
    const track = now - lastTrack >= env.trackIntervalMs;
    const full = account && now - lastFull >= env.watchIntervalMs;
    const where = track ? "track" : full ? "full" : "risk";
    try {
      if (track) {
        lastTrack = now;
        if (!account) await syncRates(ctx);
        const o = await observe(ctx);
        console.log(`${new Date(o.time).toISOString()}  ${formatObservation(o).split("\n").join("  |  ")}`);
      }
      if (account) {
        if (full) {
          lastFull = now;
          await fullCheck(account, trading, w);
        } else {
          await fastCheck(account, trading, w);
        }
      }
    } catch (err) {
      // Message only: SDK errors carry request headers, including the API key.
      console.error(`${new Date().toISOString()} ${where} check failed: ${message(err)}`);
      logEvent("error", { where: `watch:${where}`, message: message(err) });
      if (full) await send(`⚠️ Full check failed: ${message(err)}`).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, env.riskCheckIntervalMs));
  }
}
