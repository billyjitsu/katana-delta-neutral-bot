import {
  PERP_MIN_ORDER_ETH,
  averageFunding,
  consecutiveNegative,
  holdingsMoved,
  planRebalance,
  roundDownToStep,
  shortAdjustment,
  type Holdings,
  type RebalancePlan,
  type Step,
} from "@kdn/core";
import { ADDRESSES, DECIMALS, MARKET, type OpenOrder } from "@kdn/katana";
import { parseUnits } from "viem";
import type { Context } from "../context";
import { execution, strategy, thresholds } from "../env";
import type { TradingContext } from "../wallet";
import { logEvent } from "../log";
import { recordOwnSwap, syncFunding } from "./sync";

const DUST_ETH = 0.000001;
const usd = (n: number) => `$${n.toFixed(2)}`;
const eth = (n: number) => `${n.toFixed(4)} ETH`;

async function readHoldings(
  ctx: Context,
): Promise<Holdings & { sushiPrice: number; gasEth: number; otherPositions: { market: string; qty: number }[] }> {
  const [account, balances, market, sushiPrice] = await Promise.all([
    ctx.perps.account(),
    ctx.chain.balances(ctx.wallet),
    ctx.perps.market(),
    ctx.chain.sushiMidPrice(),
  ]);
  return {
    walletUsdc: balances.walletUsdc,
    spotEth: balances.spotEth,
    gasEth: balances.gasEth,
    perpEquity: account.equity,
    perpQty: account.position?.qty ?? 0,
    markPrice: market.markPrice,
    indexPrice: market.indexPrice,
    fundingRate: market.currentFundingRate,
    sushiPrice,
    otherPositions: account.otherPositions,
  };
}

/** Our own protective stop is expected on the book; anything else could fill mid-rebalance. */
function isOurStop(o: OpenOrder): boolean {
  return o.market === MARKET && o.type === "stopLossMarket" && o.side === "buy";
}

/**
 * Before trading, the perps account must hold nothing the plan doesn't know about: no positions in
 * other markets (they share the cross margin) and no open orders other than our protective stop.
 */
async function startStateProblems(ctx: Context, otherPositions: { market: string; qty: number }[]): Promise<string[]> {
  const problems = otherPositions.map((p) => `open ${p.market} position (${p.qty}) shares the cross margin: close it first`);
  const stray = (await ctx.perps.openOrders()).filter((o) => !isOurStop(o));
  if (stray.length) {
    const list = stray.map((o) => `${o.market} ${o.type} ${o.side} ${o.qty}`).join(", ");
    problems.push(`${stray.length} open order(s) could fill mid-rebalance (${list}): run "cancel-orders --go"`);
  }
  return problems;
}

/** Quoted price for buying with `usdc`, as % above index. */
async function buyImpactPct(ctx: Context, usdc: number, indexPrice: number): Promise<number> {
  const out = await ctx.chain.quoteExactIn(ADDRESSES.vbUSDC, ADDRESSES.vbETH, parseUnits(usdc.toFixed(6), DECIMALS.vbUSDC));
  if (out === 0n) return Infinity;
  return (usdc / (Number(out) / 10 ** DECIMALS.vbETH) / indexPrice - 1) * 100;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case "marginTo":
      return `Top up perp margin to ${usd(step.usd)} from wallet vbUSDC`;
    case "shrinkTo":
      return `Cover short + sell vbETH down to ${eth(step.eth)}`;
    case "withdrawTo":
      return `Withdraw perp margin down to ${usd(step.usd)}`;
    case "growTo":
      return `Buy vbETH up to ${eth(step.eth)} and short to match (keep ${usd(step.keepUsd)} in wallet)`;
    case "alignSpot":
      return `Buy vbETH up to ${eth(step.eth)} so the short can match it (keep ${usd(step.keepUsd)} in wallet)`;
    case "hedge":
      return "Match the short to the vbETH held";
    case "unwind":
      return "Close the short and sell all vbETH";
  }
}

function printPlan(h: Holdings, plan: RebalancePlan) {
  const t = plan.target;
  const short = Math.max(-h.perpQty, 0);
  const row = (label: string, now: string, target: string) => console.log(`  ${label.padEnd(9)} ${now.padStart(14)}  →  ${target}`);
  console.log(`Capital ${usd(t.capitalUsd)} at ${strategy.targetLeverage}x (ETH $${h.indexPrice.toFixed(2)})`);
  row("Wallet", usd(h.walletUsdc), `${usd(t.reserveUsd + t.feeBudgetUsd)}  (reserve ${usd(t.reserveUsd)} + fee budget ${usd(t.feeBudgetUsd)})`);
  row("Margin", usd(h.perpEquity), usd(t.marginUsd));
  row("Spot", eth(h.spotEth), `${eth(t.spotEth)}  (${usd(t.spotUsd)})`);
  row("Short", eth(short), eth(t.shortEth));
  console.log(`  Leverage ${plan.leverage === null ? "—" : `${plan.leverage.toFixed(2)}x`}   funding ${(h.fundingRate * 100).toFixed(4)}%/8h` +
    (t.breakevenDays === null ? "" : `   fees earned back in ~${t.breakevenDays.toFixed(1)} days`));
  if (plan.reasons.length) console.log(`  Why: ${plan.reasons.join("; ")}`);
  for (const n of plan.notes) console.log(`  Note: ${n}`);
  console.log(plan.steps.length ? "Steps" : "Nothing to do: position is within its bands.");
  plan.steps.forEach((s, i) => console.log(`  ${i + 1}. ${describeStep(s)}`));
}

/** Brings the short in line with the vbETH held. Returns the order size placed (0 if none). */
export async function hedge(ctx: TradingContext): Promise<number> {
  const [account, balances] = await Promise.all([ctx.perps.account(), ctx.chain.balances(ctx.wallet)]);
  const adj = shortAdjustment(balances.spotEth, account.position?.qty ?? 0);
  if (adj.qty === 0) return 0;
  const order = await ctx.trader.marketOrder(adj.side, adj.qty, adj.side === "buy");
  console.log(`  → perp ${adj.side} ${adj.qty.toFixed(3)} ETH: ${order.status}, filled ${order.executedQty} @ ${order.avgPrice}`);
  logEvent("order", { purpose: "hedge", side: adj.side, qty: adj.qty, reduceOnly: adj.side === "buy", ...order });
  return adj.qty;
}

async function marginTo(t: TradingContext, targetUsd: number, log: string[]) {
  const [{ equity }, { walletUsdc }] = await Promise.all([t.perps.account(), t.chain.balances(t.wallet)]);
  const amount = Math.min(targetUsd - equity, walletUsdc);
  if (amount < strategy.minTradeUsd) return;
  await t.trader.deposit(amount);
  logEvent("deposit", { usd: amount, targetMarginUsd: targetUsd });
  log.push(`deposited ${usd(amount)} margin`);
}

/** Withdraws margin and records the exchange's gas fee in the cost ledger. */
export async function withdrawAndRecord(t: TradingContext, amount: number) {
  const { gasFeeUsd, txHash } = await t.trader.withdraw(amount);
  await t.store.saveCost({
    time: Date.now(),
    kind: "withdrawal",
    label: `withdraw ${usd(amount)} margin`,
    usd: gasFeeUsd,
    txHash: txHash ?? undefined,
  });
  logEvent("withdrawal", { usd: amount, gasFeeUsd, txHash });
}

async function withdrawTo(t: TradingContext, targetUsd: number, log: string[]) {
  const { equity } = await t.perps.account();
  const amount = equity - targetUsd;
  if (amount < strategy.minTradeUsd) return;
  await withdrawAndRecord(t, amount);
  log.push(`withdrew ${usd(amount)} margin`);
}

/** Covers the short and sells matching vbETH in chunks until spot is at `targetEth`. */
async function shrinkTo(t: TradingContext, targetEth: number, log: string[]) {
  const { indexPrice } = await t.perps.market();
  const maxChunkEth = roundDownToStep(execution.maxChunkUsd / indexPrice);
  const minTradeEth = strategy.minTradeUsd / indexPrice;
  const targetShort = roundDownToStep(targetEth);

  for (;;) {
    const [position, { spotEth }] = await Promise.all([t.perps.account().then((a) => a.position), t.chain.balances(t.wallet)]);
    const short = Math.max(-(position?.qty ?? 0), 0);
    const excessSpot = spotEth - targetEth;
    const excessShort = short - targetShort;
    if (excessSpot < minTradeEth && excessShort < PERP_MIN_ORDER_ETH) break;

    let covered = 0;
    if (excessShort >= PERP_MIN_ORDER_ETH) {
      const qty = excessShort - maxChunkEth < PERP_MIN_ORDER_ETH ? roundDownToStep(excessShort) : maxChunkEth;
      const order = await t.trader.marketOrder("buy", qty, true);
      console.log(`  → perp buy ${qty.toFixed(3)} ETH (reduce-only): ${order.status}, filled ${order.executedQty} @ ${order.avgPrice}`);
      logEvent("order", { purpose: "shrink", side: "buy", qty, reduceOnly: true, ...order });
      // Measure the fill from the position itself rather than trusting the order response.
      const after = Math.max(-((await t.perps.account()).position?.qty ?? 0), 0);
      covered = short - after;
      if (covered <= 0) throw new Error("Reduce-only buy did not fill; stopping so legs stay close");
      log.push(`covered ${eth(covered)}`);
    }

    // Without a cover this round, only sell spot the short no longer hedges, so the legs stay matched.
    const unhedged = spotEth - (short - covered);
    const sell = covered > 0 ? Math.min(excessSpot, covered) : Math.min(excessSpot, unhedged, maxChunkEth);
    if (sell > DUST_ETH && sell >= minTradeEth) {
      const swap = await t.spot.sellEth(sell, execution.maxSlippageBps);
      await recordOwnSwap(t, swap);
      log.push(`sold ${eth(sell)}`);
    } else if (covered === 0) {
      break;
    }
  }
}

/** Buys vbETH in chunks up to `targetEth`, hedging after each, keeping `keepUsd` in the wallet. */
async function growTo(t: TradingContext, targetEth: number, keepUsd: number, log: string[]) {
  for (;;) {
    const [{ spotEth, walletUsdc }, { indexPrice }] = await Promise.all([t.chain.balances(t.wallet), t.perps.market()]);
    const neededUsd = (targetEth - spotEth) * indexPrice;
    const budget = walletUsdc - keepUsd;
    const chunk = Math.min(neededUsd, budget, execution.maxChunkUsd);
    if (neededUsd < strategy.minTradeUsd) break;
    if (chunk < strategy.minTradeUsd) {
      log.push(`stopped growing: only ${usd(budget)} available above the reserve`);
      break;
    }
    const impact = await buyImpactPct(t, chunk, indexPrice);
    if (impact > execution.maxSpotImpactPct) {
      log.push(`stopped growing: ${usd(chunk)} buy quoted ${impact.toFixed(2)}% above index`);
      break;
    }
    const swap = await t.spot.buyEth(chunk, execution.maxSlippageBps);
    await recordOwnSwap(t, swap);
    log.push(`bought ${usd(chunk)} of vbETH`);
    if ((await hedge(t)) > 0) log.push("resized short");
  }
}

/**
 * Closes a leg gap smaller than one perp order by buying spot. Without the vbUSDC for that, sells the
 * spot over the short instead.
 */
async function alignSpot(t: TradingContext, targetEth: number, keepUsd: number, log: string[]) {
  const [{ spotEth, walletUsdc }, account, { indexPrice }] = await Promise.all([t.chain.balances(t.wallet), t.perps.account(), t.perps.market()]);
  const buyEth = targetEth - spotEth;
  if (buyEth <= DUST_ETH) return;
  // A little extra so slippage can't leave the buy short of the target.
  const usdc = Math.ceil(buyEth * indexPrice * 1.005 * 100) / 100;
  if (walletUsdc - keepUsd >= usdc) {
    await recordOwnSwap(t, await t.spot.buyEth(usdc, execution.maxSlippageBps));
    log.push(`bought ${usd(usdc)} of vbETH to line up with the short`);
    return;
  }
  const excess = spotEth - Math.max(-(account.position?.qty ?? 0), 0);
  if (excess <= DUST_ETH) {
    log.push(`legs not aligned: needed ${usd(usdc)} vbUSDC, only ${usd(walletUsdc - keepUsd)} available`);
    return;
  }
  await recordOwnSwap(t, await t.spot.sellEth(excess, execution.maxSlippageBps));
  log.push(`sold ${eth(excess)} of vbETH over the short`);
}

async function unwind(t: TradingContext, log: string[]) {
  await shrinkTo(t, 0, log);
  const leftover = (await t.chain.balances(t.wallet)).spotEth;
  if (leftover > DUST_ETH) {
    await recordOwnSwap(t, await t.spot.sellEth(leftover, execution.maxSlippageBps));
    log.push(`sold leftover ${eth(leftover)}`);
  }
}

async function runStep(t: TradingContext, step: Step, log: string[]) {
  switch (step.kind) {
    case "marginTo":
      return marginTo(t, step.usd, log);
    case "withdrawTo":
      return withdrawTo(t, step.usd, log);
    case "shrinkTo":
      return shrinkTo(t, step.eth, log);
    case "growTo":
      return growTo(t, step.eth, step.keepUsd, log);
    case "alignSpot":
      return alignSpot(t, step.eth, step.keepUsd, log);
    case "hedge":
      if ((await hedge(t)) > 0) log.push("resized short");
      return;
    case "unwind":
      return unwind(t, log);
  }
}

/** Pre-checks refused to act. Nothing was sent; safe to try again later. */
export class RebalanceBlocked extends Error {
  constructor(readonly problems: string[]) {
    super(`Not rebalancing:\n  - ${problems.join("\n  - ")}`);
  }
}

export interface RebalanceResult {
  plan: RebalancePlan;
  executed: boolean;
  /** Executed and something actually changed (spot, short or wallet vbUSDC). */
  traded?: boolean;
  log: string[];
  /** After executing: how far apart the legs ended up, in % of the short (spot over short is positive). */
  legsApartPct?: number;
}

/** Spot vs short gap in % of the short; Infinity for spot with no short. */
function legsApartPct(h: Holdings): number {
  const short = Math.max(-h.perpQty, 0);
  if (short > 0) return ((h.spotEth - short) / short) * 100;
  return h.spotEth > DUST_ETH ? Infinity : 0;
}

/**
 * Sizes the whole position from current holdings and moves toward the target. Without a trading
 * context it only prints the plan.
 */
export async function rebalance(ctx: Context, trading: TradingContext | undefined, opts: { quiet?: boolean } = {}): Promise<RebalanceResult> {
  await syncFunding(ctx);
  const rates = (await ctx.store.fundingRates(Date.now() - 3 * 86_400_000)).map((r) => r.rate).reverse();
  const average = averageFunding(rates, strategy.avgFundingPeriods);
  const h = await readHoldings(ctx);
  const plan = planRebalance(h, strategy, consecutiveNegative(rates), average);
  if (!opts.quiet || plan.steps.length) printPlan(h, plan);
  if (!plan.steps.length) return { plan, executed: false, log: [] };

  const basis = (h.sushiPrice / h.indexPrice - 1) * 100;
  const problems = await startStateProblems(ctx, h.otherPositions);
  if (!opts.quiet) {
    const short = Math.max(-h.perpQty, 0);
    const flat = short === 0 && h.perpEquity === 0 && h.spotEth === 0 && !problems.length;
    console.log(
      `Start state: perp margin ${usd(h.perpEquity)}, ETH-USD short ${eth(short)}, ` +
        `other markets ${h.otherPositions.length ? "OPEN" : "none"}, stray orders ${problems.length ? "see below" : "none"}${flat ? " (flat ✓)" : ""}`,
    );
  }
  if (h.gasEth < thresholds.minGasEth) problems.push(`only ${h.gasEth} ETH for gas`);
  if (Math.abs(basis) >= thresholds.killBasisPct) problems.push(`Sushi is ${basis.toFixed(2)}% off index: possible depeg, act manually`);
  const growing = plan.steps.some((s) => s.kind === "growTo");
  if (growing && h.fundingRate < strategy.minGrowFundingRate) {
    problems.push(`funding rate ${(h.fundingRate * 100).toFixed(4)}%/8h is under ${(strategy.minGrowFundingRate * 100).toFixed(4)}%: not adding size`);
  }
  if (growing && average !== null && average < 0) problems.push(`recent funding averages ${(average * 100).toFixed(4)}%/8h: not adding size`);
  if (growing && Math.abs(basis) >= thresholds.alertBasisPct) problems.push(`Sushi is ${basis.toFixed(2)}% off index`);
  if (problems.length) throw new RebalanceBlocked(problems);

  if (!trading) {
    console.log("\nDry run. Add --go to execute.");
    return { plan, executed: false, log: [] };
  }

  console.log("\nExecuting");
  const log: string[] = [];
  logEvent("rebalance", { phase: "start", reasons: plan.reasons, steps: plan.steps, target: plan.target, holdings: h });
  try {
    for (const step of plan.steps) await runStep(trading, step, log);
  } catch (err) {
    logEvent("rebalance", { phase: "failed", done: log, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  // Check the result instead of trusting the steps: a skipped order must not read as success.
  const afterHoldings = await readHoldings(ctx);
  const after = legsApartPct(afterHoldings);
  const traded = holdingsMoved(h, afterHoldings);
  logEvent("rebalance", { phase: "done", done: log, legsApartPct: after, traded });
  console.log(`Done: ${log.length ? log.join(", ") : "no trades were needed"}`);
  if (Math.abs(after) > strategy.deltaBandPct) console.log(`⚠️ Legs still ${Math.abs(after).toFixed(1)}% apart after the rebalance`);
  return { plan, executed: true, traded, log, legsApartPct: after };
}

/** Closes both legs. Margin stays on the exchange unless withdraw is enabled. */
export async function exit(ctx: Context, trading: TradingContext | undefined) {
  const h = await readHoldings(ctx);
  const exitQuote = await ctx.chain.quoteSellEth(h.spotEth);
  console.log("Exit plan");
  console.log(`  Close short ${eth(Math.max(-h.perpQty, 0))} (reduce-only market buys)`);
  console.log(`  Sell spot   ${eth(h.spotEth)} → ≈ ${usd(exitQuote)}`);
  console.log(`  Margin ${usd(h.perpEquity)} stays on Katana Perps; use \`withdraw\` to move it back.`);
  if (!trading) {
    console.log("\nDry run. Add --go to execute.");
    return;
  }
  console.log("\nExecuting");
  const log: string[] = [];
  await unwind(trading, log);
  console.log(`Exit complete: ${log.join(", ") || "nothing to close"}`);
}
