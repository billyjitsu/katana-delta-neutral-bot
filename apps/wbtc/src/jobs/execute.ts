import {
  BTC_MIN_ORDER,
  DUST_BTC,
  carryBasis,
  carryMetrics,
  planCarry,
  roundBtc,
  type CarryPlan,
  type CarryStep,
} from "@kdn/core";
import { ADDRESSES, BTC_MARKET, DECIMALS, type OpenOrder, type SwapResult } from "@kdn/katana";
import { logEvent } from "@kdn/bot/log";
import { formatUnits, parseEventLogs, erc20Abi, type Hash } from "viem";
import type { AccountContext } from "../context";
import { carry, execution, thresholds } from "../env";
import type { TradingContext } from "../wallet";
import { buyCostPct } from "./track";
import { LAST_COMPOUND_KEY, SLICE_HALVED_KEY, planContext, readState, syncFunding, type LiveState } from "./state";

const usd = (n: number) => `$${n.toFixed(2)}`;
const btc = (n: number) => `${n.toFixed(5)} BTC`;
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const lev = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}x`);
/** Shrinking at high LTV goes in small safe chunks; this bounds the loop if something stops progressing. */
const MAX_LOOP = 40;
const WITHDRAWAL_POLL_MS = 5_000;

export function describeStep(step: CarryStep): string {
  switch (step.kind) {
    case "supply":
      return "Supply the wallet's vbWBTC to Morpho as collateral";
    case "topUp":
      return `Add ${usd(step.usd)} perp margin (wallet vbUSDC first, then borrow on Morpho)`;
    case "release":
      return `Withdraw ${usd(step.usd)} perp margin and repay Morpho with it`;
    case "repay":
      return `Repay ${usd(step.usd)} to Morpho from wallet vbUSDC`;
    case "grow":
      return `Grow the slice to ${btc(step.sliceBtc)}: margin to ${usd(step.marginUsd)}, then borrow, buy vbWBTC, supply and short in chunks`;
    case "shrink":
      return `Shrink the slice to ${btc(step.sliceBtc)}: close short and sell the same vbWBTC, repaying as it goes`;
    case "hedge":
      return "Match the BTC-USD short to the slice";
    case "compound":
      return `Compound ${usd(step.usd)} of profit into WBTC added to the deposit`;
    case "unwind":
      return "Unwind: close the short, sell the whole slice, repay; the deposit stays as collateral";
  }
}

export function printState(s: LiveState, plan: CarryPlan) {
  const h = s.holdings;
  const m = plan.metrics;
  const t = plan.target;
  const row = (label: string, now: string, target = "") => console.log(`  ${label.padEnd(10)} ${now.padStart(16)}${target ? `  →  ${target}` : ""}`);
  console.log(`Deposit ${btc(h.depositBtc)} at BTC $${h.indexPrice.toFixed(0)} (oracle $${h.oraclePrice.toFixed(0)})${plan.halved ? "  [slice halved by the rate guard]" : ""}`);
  row("Collateral", btc(h.collateralBtc), btc(h.depositBtc + t.sliceBtc));
  if (h.walletBtc > DUST_BTC) row("Wallet BTC", btc(h.walletBtc), "supply");
  row("Slice", btc(m.sliceBtc), btc(t.sliceBtc));
  row("Short", `${m.shortBtc.toFixed(4)} BTC`, `${t.shortBtc.toFixed(4)} BTC`);
  row("Net BTC", btc(m.netBtc), `${btc(h.depositBtc)} (${m.netBtcDriftPct >= 0 ? "+" : ""}${m.netBtcDriftPct.toFixed(2)}%)`);
  row("Debt", usd(h.debtUsd), usd(t.debtUsd));
  row("Margin", usd(h.perpEquity), usd(t.marginUsd));
  row("Wallet", usd(h.walletUsdc));
  console.log(
    `  LTV ${pct(m.ltv)} (band ${pct(carry.minLtv)}–${pct(carry.maxLtv)}, Morpho liquidates at ${pct(h.lltv)}${m.dropToMorphoLiquidationPct === null ? "" : `, ${m.dropToMorphoLiquidationPct.toFixed(1)}% drop away`})`,
  );
  console.log(
    `  Perp ${lev(m.perpLeverage)} (band ${carry.minPerpLeverage}–${carry.maxPerpLeverage}x${m.rallyToPerpLiquidationPct === null ? "" : `, liquidation +${m.rallyToPerpLiquidationPct.toFixed(1)}% away`})`,
  );
  console.log(
    `  Rates: funding ${(h.fundingRate * 100).toFixed(4)}%/8h, borrow ${pct(h.borrowApy)}, utilization ${pct(s.morpho.utilization)}` +
      (m.liveYieldPct === null ? "" : `  →  ${m.liveYieldPct.toFixed(2)}% a year in BTC`),
  );
  console.log(`  Equity ${btc(m.equityBtc)} (${usd(m.equityUsd)}), profit ${m.profitBtc >= 0 ? "+" : ""}${m.profitBtc.toFixed(6)} BTC (${usd(m.profitUsd)})`);
  if (plan.reasons.length) console.log(`  Why: ${plan.reasons.join("; ")}`);
  for (const n of plan.notes) console.log(`  Note: ${n}`);
  console.log(plan.steps.length ? `Steps (${plan.urgency})` : "Nothing to do: position is within its bands.");
  plan.steps.forEach((x, i) => console.log(`  ${i + 1}. ${describeStep(x)}`));
}

/** Our protective stop is expected on the book; anything else could fill mid-rebalance. */
function isOurStop(o: OpenOrder): boolean {
  return o.market === BTC_MARKET && o.type === "stopLossMarket" && o.side === "buy";
}

async function startStateProblems(ctx: AccountContext, s: LiveState): Promise<string[]> {
  const problems = s.account.otherPositions.map((p) => `open ${p.market} position (${p.qty}) shares the cross margin: close it first`);
  const stray = (await ctx.perps.openOrders()).filter((o) => !isOurStop(o));
  if (stray.length) problems.push(`${stray.length} open order(s) could fill mid-rebalance: run "cancel-orders --go"`);
  return problems;
}

/** Records a swap the bot just made from its receipt: the wallet's net vbWBTC and vbUSDC change. */
async function recordSwap(t: TradingContext, swap: SwapResult, refPrice: number) {
  const receipt = await t.chain.client.getTransactionReceipt({ hash: swap.hash as Hash });
  const me = t.wallet.toLowerCase();
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
  const net = (token: string) =>
    transfers
      .filter((x) => x.address.toLowerCase() === token.toLowerCase())
      .reduce((sum, x) => sum + (x.args.to.toLowerCase() === me ? x.args.value : 0n) - (x.args.from.toLowerCase() === me ? x.args.value : 0n), 0n);
  const abs = (x: bigint) => Number(formatUnits(x < 0n ? -x : x, 0));
  const record = {
    txHash: swap.hash,
    time: Date.now(),
    direction: swap.direction,
    btc: abs(net(ADDRESSES.vbWBTC)) / 10 ** DECIMALS.vbWBTC,
    usdc: abs(net(ADDRESSES.vbUSDC)) / 10 ** DECIMALS.vbUSDC,
    refPrice,
    route: swap.route,
  };
  t.store.saveSwap(record);
  logEvent("swap", { ...record, quotedOut: swap.quotedOut, minOut: swap.minOut });
  return record;
}

async function borrow(t: TradingContext, amount: number, note: string, log: string[]) {
  await t.lender.borrow(amount);
  t.store.addDebtFlow(amount, note);
  logEvent("morpho", { action: "borrow", usd: amount, note });
  log.push(`borrowed ${usd(amount)}`);
}

async function repay(t: TradingContext, amount: number, log: string[]) {
  const repaid = await t.lender.repay(amount);
  if (repaid <= 0) return;
  t.store.addDebtFlow(-repaid, "repay");
  logEvent("morpho", { action: "repay", usd: repaid });
  log.push(`repaid ${usd(repaid)}`);
}

/** Repays from whatever vbUSDC the wallet holds above the reserve. */
async function repayFromWallet(t: TradingContext, log: string[]) {
  const s = await readState(t);
  const spare = Math.min(s.holdings.walletUsdc - carry.walletReserveUsd, s.holdings.debtUsd * 1.001 + 0.01);
  if (spare >= 0.01 && s.holdings.debtUsd > 0) await repay(t, spare, log);
}

async function supplyWalletBtc(t: TradingContext, log: string[]) {
  const s = await readState(t);
  if (s.holdings.walletBtc <= DUST_BTC) return;
  const supplied = await t.lender.supplyCollateral(s.holdings.walletBtc);
  logEvent("morpho", { action: "supplyCollateral", btc: supplied });
  log.push(`supplied ${btc(supplied)}`);
}

/** Highest borrow that keeps LTV at or below `cap` and fits Morpho's free liquidity. */
function borrowRoom(s: LiveState, cap: number): number {
  const h = s.holdings;
  return Math.max(Math.min(cap * h.collateralBtc * h.oraclePrice - h.debtUsd, s.morpho.available * 0.95), 0);
}

/** Adds perp margin: wallet vbUSDC first, borrowing the rest (LTV stays within the band). */
async function topUp(t: TradingContext, amount: number, log: string[]) {
  const s = await readState(t);
  const cash = Math.max(s.holdings.walletUsdc - carry.walletReserveUsd, 0);
  let toBorrow = Math.max(amount - cash, 0);
  const room = borrowRoom(s, carry.maxLtv);
  if (toBorrow > room) {
    log.push(`could only borrow ${usd(room)} of ${usd(toBorrow)} (LTV cap or Morpho liquidity)`);
    toBorrow = room;
  }
  if (toBorrow >= 0.01) await borrow(t, toBorrow, "perp margin", log);
  const deposit = Math.min(amount, cash + toBorrow);
  if (deposit < carry.minTradeUsd) return;
  await t.trader.deposit(deposit);
  logEvent("deposit", { usd: deposit });
  log.push(`deposited ${usd(deposit)} margin`);
}

/**
 * Withdraws margin and waits (up to WITHDRAWAL_WAIT_SEC) for it to land in the wallet. Times every
 * withdrawal for H7. Returns whether it arrived; if not, the next check repays when it does.
 */
async function withdrawMargin(t: TradingContext, amount: number, log: string[]): Promise<boolean> {
  const before = (await readState(t)).holdings.walletUsdc;
  const { gasFeeUsd, txHash } = await t.trader.withdraw(amount);
  t.actions.count++;
  const id = t.store.addWithdrawal(amount, gasFeeUsd);
  t.store.saveCost({ time: Date.now(), kind: "withdrawal", label: `withdraw ${usd(amount)} margin`, usd: gasFeeUsd, txHash: txHash ?? undefined });
  logEvent("withdrawal", { usd: amount, gasFeeUsd, txHash });
  log.push(`withdrew ${usd(amount)} margin (fee ${usd(gasFeeUsd)})`);

  const deadline = Date.now() + execution.withdrawalWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, WITHDRAWAL_POLL_MS));
    const now = await t.chain.tokenBalance(ADDRESSES.vbUSDC, t.wallet);
    if (Number(formatUnits(now, DECIMALS.vbUSDC)) >= before + (amount - gasFeeUsd) * 0.98) {
      t.store.markWithdrawalArrived(id);
      return true;
    }
  }
  log.push("withdrawal still on its way: the next check repays when it lands");
  return false;
}

async function release(t: TradingContext, amount: number, log: string[]) {
  if (await withdrawMargin(t, amount, log)) await repayFromWallet(t, log);
}

/** Resizes the short to the slice. Returns the BTC traded (0 if already matched). */
export async function hedge(t: TradingContext, log: string[] = []): Promise<number> {
  const s = await readState(t);
  const m = carryMetrics(s.holdings, s.maintenanceMarginFraction);
  const diff = roundBtc(Math.max(m.sliceBtc, 0)) - m.shortBtc;
  if (Math.abs(diff) < BTC_MIN_ORDER) return 0;
  const side = diff > 0 ? "sell" : "buy";
  const qty = roundBtc(Math.abs(diff));
  const order = await t.trader.marketOrder(side, qty, side === "buy");
  t.actions.count++;
  console.log(`  → perp ${side} ${qty.toFixed(4)} BTC: ${order.status}, filled ${order.executedQty} @ ${order.avgPrice}`);
  logEvent("order", { purpose: "hedge", side, qty, reduceOnly: side === "buy", ...order });
  log.push(`${side === "sell" ? "shorted" : "covered"} ${qty.toFixed(4)} BTC`);
  return qty;
}

async function grow(t: TradingContext, targetSlice: number, marginUsd: number, log: string[]) {
  const first = await readState(t);
  if (marginUsd - first.holdings.perpEquity >= carry.minTradeUsd) await topUp(t, marginUsd - first.holdings.perpEquity, log);

  for (let i = 0; i < MAX_LOOP; i++) {
    const s = await readState(t);
    const h = s.holdings;
    const slice = h.collateralBtc + h.walletBtc - h.depositBtc;
    const chunk = Math.min((targetSlice - slice) * h.indexPrice, execution.maxChunkUsd);
    if (chunk < carry.minTradeUsd) break;
    const impact = await buyCostPct(t, chunk, h.indexPrice);
    if (impact > execution.maxSpotImpactPct) {
      log.push(`stopped growing: ${usd(chunk)} buy quoted ${impact.toFixed(2)}% above index`);
      break;
    }
    const cash = Math.max(h.walletUsdc - carry.walletReserveUsd, 0);
    const toBorrow = Math.max(chunk - cash, 0);
    if (toBorrow > borrowRoom(s, execution.withdrawLtvCap)) {
      log.push("stopped growing: borrowing the next chunk would pass the LTV cap or Morpho's free liquidity");
      break;
    }
    if (toBorrow >= 0.01) await borrow(t, toBorrow, "slice", log);
    await recordSwap(t, await t.spot.buy(chunk, execution.maxSlippageBps), h.indexPrice);
    log.push(`bought ${usd(chunk)} of vbWBTC`);
    await supplyWalletBtc(t, log);
    await hedge(t, log);
  }
}

/**
 * Takes the slice down to `targetSlice`: per chunk, close that much short (reduce-only), sell the
 * same vbWBTC (wallet first, then collateral within the LTV cap) and repay with the proceeds.
 * Never waits on a perp withdrawal, so it works when margin can't move in time.
 */
async function shrink(t: TradingContext, targetSlice: number, log: string[]) {
  for (let i = 0; i < MAX_LOOP; i++) {
    const s = await readState(t);
    const h = s.holdings;
    const m = carryMetrics(h, s.maintenanceMarginFraction);
    const excess = m.sliceBtc - targetSlice;
    const targetShort = roundBtc(Math.max(targetSlice, 0));
    const extraShort = m.shortBtc - targetShort;
    if (excess * h.indexPrice < carry.minTradeUsd && extraShort < BTC_MIN_ORDER) break;

    const chunk = Math.min(Math.max(excess, 0), execution.maxChunkUsd / h.indexPrice);
    if (extraShort >= BTC_MIN_ORDER) {
      // The last bit of short goes in one order, since the exchange won't take less than the minimum.
      const qty = extraShort - chunk < BTC_MIN_ORDER ? roundBtc(extraShort) : Math.max(roundBtc(chunk), BTC_MIN_ORDER);
      const order = await t.trader.marketOrder("buy", qty, true);
      t.actions.count++;
      console.log(`  → perp buy ${qty.toFixed(4)} BTC (reduce-only): ${order.status}, filled ${order.executedQty} @ ${order.avgPrice}`);
      logEvent("order", { purpose: "shrink", side: "buy", qty, reduceOnly: true, ...order });
      log.push(`covered ${qty.toFixed(4)} BTC`);
    }

    if (chunk * h.indexPrice < carry.minTradeUsd) continue;
    const fromWallet = Math.min(h.walletBtc, chunk);
    const maxWithdraw = Math.max(h.collateralBtc - h.debtUsd / (execution.withdrawLtvCap * h.oraclePrice), 0);
    const fromCollateral = Math.min(chunk - fromWallet, maxWithdraw);
    if (fromWallet + fromCollateral <= DUST_BTC) {
      throw new Error(`Can't take collateral out without passing ${pct(execution.withdrawLtvCap)} LTV; repay from margin first`);
    }
    if (fromCollateral > DUST_BTC) {
      await t.lender.withdrawCollateral(fromCollateral);
      logEvent("morpho", { action: "withdrawCollateral", btc: fromCollateral });
    }
    const swap = await recordSwap(t, await t.spot.sell(fromWallet + fromCollateral, execution.maxSlippageBps), h.indexPrice);
    log.push(`sold ${btc(swap.btc)} for ${usd(swap.usdc)}`);
    await repayFromWallet(t, log);
  }
  await hedge(t, log);
}

async function unwind(t: TradingContext, log: string[]) {
  await shrink(t, 0, log);
  const s = await readState(t);
  const short = Math.max(-s.holdings.perpQty, 0);
  if (short > 0) {
    const order = await t.trader.marketOrder("buy", roundBtc(short), true);
    t.actions.count++;
    logEvent("order", { purpose: "unwind", side: "buy", qty: short, reduceOnly: true, ...order });
    log.push(`closed the last ${short.toFixed(4)} BTC of short`);
  }
  const equity = (await t.perps.account()).equity;
  // Leave a cent so rounding never asks for more than the account holds.
  if (equity - 0.01 >= carry.minTradeUsd) await release(t, Math.floor((equity - 0.01) * 100) / 100, log);
  const after = await readState(t);
  if (after.holdings.debtUsd > 0.01) log.push(`${usd(after.holdings.debtUsd)} debt left: repaid when the margin lands`);
}

async function compound(t: TradingContext, amount: number, log: string[]) {
  const s = await readState(t);
  const m = carryMetrics(s.holdings, s.maintenanceMarginFraction);
  const marginSurplus = s.holdings.perpEquity - (m.shortBtc * s.holdings.markPrice) / carry.targetPerpLeverage;
  const fromMargin = Math.min(amount, Math.max(marginSurplus, 0));
  if (fromMargin >= carry.minTradeUsd && !(await withdrawMargin(t, fromMargin, log))) {
    log.push("compound postponed until the withdrawal lands");
    return;
  }
  const now = await readState(t);
  const cash = Math.max(now.holdings.walletUsdc - carry.walletReserveUsd, 0);
  // Profit that already went into a lower debt is borrowed back out, which leaves LTV unchanged.
  const toBorrow = Math.min(Math.max(amount - cash, 0), borrowRoom(now, carry.maxLtv));
  if (toBorrow >= 0.01) await borrow(t, toBorrow, "compound", log);
  const spend = Math.min(amount, cash + toBorrow);
  if (spend < carry.minTradeUsd) return;
  const btcBefore = now.holdings.walletBtc;
  const swap = await recordSwap(t, await t.spot.buy(spend, execution.maxSlippageBps), now.holdings.indexPrice);
  const gained = Math.max(swap.btc, 0);
  t.store.addBtcFlow({ time: Date.now(), btc: gained, note: `compound ${usd(spend)}` });
  t.store.setMeta(LAST_COMPOUND_KEY, String(Date.now()));
  log.push(`compounded ${usd(spend)} into ${btc(gained)}`);
  if (btcBefore + gained > DUST_BTC) await supplyWalletBtc(t, log);
}

async function runStep(t: TradingContext, step: CarryStep, log: string[]) {
  switch (step.kind) {
    case "supply":
      return supplyWalletBtc(t, log);
    case "topUp":
      return topUp(t, step.usd, log);
    case "release":
      return release(t, step.usd, log);
    case "repay":
      return repay(t, step.usd, log);
    case "grow":
      return grow(t, step.sliceBtc, step.marginUsd, log);
    case "shrink":
      return shrink(t, step.sliceBtc, log);
    case "hedge":
      await hedge(t, log);
      return;
    case "compound":
      return compound(t, step.usd, log);
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
  plan: CarryPlan;
  executed: boolean;
  log: string[];
}

export async function currentPlan(ctx: AccountContext): Promise<{ state: LiveState; plan: CarryPlan }> {
  const state = await readState(ctx);
  const plan = planCarry(state.holdings, carry, planContext(ctx, state));
  if ((ctx.store.getMeta(SLICE_HALVED_KEY) === "true") !== plan.halved) ctx.store.setMeta(SLICE_HALVED_KEY, String(plan.halved));
  return { state, plan };
}

/** Plans from live holdings and, with a trading context, executes the plan. */
export async function rebalance(ctx: AccountContext, trading: TradingContext | undefined, opts: { quiet?: boolean } = {}): Promise<RebalanceResult> {
  await syncFunding(ctx);
  const { state, plan } = await currentPlan(ctx);
  if (!opts.quiet || plan.steps.length) printState(state, plan);
  if (!plan.steps.length) return { plan, executed: false, log: [] };

  const problems = await startStateProblems(ctx, state);
  if (state.gasEth < thresholds.minGasEth) problems.push(`only ${state.gasEth} ETH for gas`);
  const basis = carryBasis(state.holdings, state.sushiPrice);
  const worst = Math.max(Math.abs(basis.sushiPct), Math.abs(basis.oraclePct));
  // In an emergency, getting out beats waiting for the peg; otherwise a depeg stops everything.
  if (worst >= thresholds.killBasisPct && plan.urgency !== "emergency") {
    problems.push(`vbWBTC is ${worst.toFixed(2)}% off index (Sushi ${basis.sushiPct.toFixed(2)}%, oracle ${basis.oraclePct.toFixed(2)}%): act manually`);
  }
  const adding = plan.steps.some((x) => x.kind === "grow" || x.kind === "compound");
  if (adding && worst >= thresholds.alertBasisPct) problems.push(`vbWBTC is ${worst.toFixed(2)}% off index: not adding to the slice`);
  if (problems.length) throw new RebalanceBlocked(problems);

  if (!trading) {
    console.log("\nDry run. Add --go to execute.");
    return { plan, executed: false, log: [] };
  }

  console.log("\nExecuting");
  const log: string[] = [];
  logEvent("rebalance", { phase: "start", urgency: plan.urgency, reasons: plan.reasons, steps: plan.steps, holdings: state.holdings });
  try {
    for (const step of plan.steps) await runStep(trading, step, log);
  } catch (err) {
    logEvent("rebalance", { phase: "failed", done: log, error: err instanceof Error ? err.message : String(err) });
    trading.store.addRebalance({ urgency: plan.urgency, reasons: plan.reasons, steps: plan.steps, log, failed: true });
    throw err;
  }
  logEvent("rebalance", { phase: "done", done: log });
  trading.store.addRebalance({ urgency: plan.urgency, reasons: plan.reasons, steps: plan.steps, log });
  console.log(`Done: ${log.length ? log.join(", ") : "no trades were needed"}`);
  return { plan, executed: true, log };
}

/** Unwinds the slice. The deposit stays on Morpho; take it out with `withdraw-btc`. */
export async function exit(ctx: AccountContext, trading: TradingContext | undefined) {
  const { state, plan } = await currentPlan(ctx);
  printState(state, { ...plan, steps: [{ kind: "unwind" }], reasons: ["exit requested"] });
  if (!trading) return console.log("\nDry run. Add --go to execute.");
  const log: string[] = [];
  await unwind(trading, log);
  trading.store.addRebalance({ urgency: "exit", steps: [{ kind: "unwind" }], log });
  console.log(`Exit: ${log.join(", ") || "nothing to close"}`);
}

/** Records WBTC put into the strategy and supplies it as collateral. */
export async function deposit(ctx: AccountContext, trading: TradingContext | undefined, amount: number) {
  const s = await readState(ctx);
  if (s.holdings.walletBtc + 1e-9 < amount) throw new Error(`Wallet holds ${btc(s.holdings.walletBtc)}, less than ${btc(amount)}`);
  console.log(`Deposit ${btc(amount)} (≈ ${usd(amount * s.holdings.indexPrice)}): supply to Morpho and raise the target net BTC to ${btc(s.holdings.depositBtc + amount)}.`);
  console.log("The slice is bought on the next rebalance.");
  if (!trading) return console.log("\nDry run. Add --go to execute.");
  const supplied = await trading.lender.supplyCollateral(amount);
  trading.store.addBtcFlow({ time: Date.now(), btc: supplied, note: "deposit" });
  logEvent("morpho", { action: "deposit", btc: supplied });
  console.log(`Supplied ${btc(supplied)}. Target net BTC is now ${btc(trading.store.depositBtc())}.`);
}

/**
 * Takes WBTC out of the deposit: withdraws collateral to the wallet. Only with no slice left
 * (run `exit` first) and only as far as the remaining debt allows.
 */
export async function withdrawBtc(ctx: AccountContext, trading: TradingContext | undefined, amountArg: string) {
  const s = await readState(ctx);
  const m = carryMetrics(s.holdings, s.maintenanceMarginFraction);
  if (m.shortBtc > 0 || m.sliceBtc > 0.0001) throw new Error("The slice is still open: run `exit --go` first");
  const h = s.holdings;
  const amount = amountArg === "all" ? h.collateralBtc : Number(amountArg);
  if (!(amount > 0) || amount > h.collateralBtc + 1e-9) throw new Error(`withdraw-btc needs an amount up to ${btc(h.collateralBtc)} or "all"`);
  const ltvAfter = h.debtUsd / ((h.collateralBtc - amount) * h.oraclePrice);
  if (h.debtUsd > 0.01 && !(ltvAfter <= carry.targetLtv)) throw new Error(`${usd(h.debtUsd)} debt left; repay it first (LTV after would be ${pct(ltvAfter)})`);
  console.log(`Withdraw ${btc(amount)} collateral to the wallet; target net BTC ${btc(h.depositBtc)} → ${btc(Math.max(h.depositBtc - amount, 0))}`);
  if (!trading) return console.log("\nDry run. Add --go to execute.");
  await trading.lender.withdrawCollateral(amount);
  trading.store.addBtcFlow({ time: Date.now(), btc: -Math.min(amount, h.depositBtc), note: "withdraw" });
  logEvent("morpho", { action: "withdrawCollateral", btc: amount, note: "withdraw-btc" });
  console.log(`Withdrew ${btc(amount)} vbWBTC to ${trading.wallet}.`);
}
