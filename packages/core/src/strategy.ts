import { PERP_TAKER_FEE, modeledSwapCostPct } from "./metrics";
import { PERP_MIN_ORDER_ETH, PERP_STEP_ETH, roundDownToStep } from "./plan";

/** Half a perp step over the target, so slippage on the buy can't round the short down a step. */
const ALIGN_BUFFER_ETH = PERP_STEP_ETH / 2;

export interface StrategySettings {
  targetLeverage: number;
  /** Re-target when leverage leaves [minLeverage, maxLeverage]. */
  minLeverage: number;
  maxLeverage: number;
  /** % of capital kept as vbUSDC in the wallet for fast margin top-ups. */
  reservePct: number;
  /** Re-size the position when spot is this % away from target (e.g. after adding money). */
  rebalanceBandPct: number;
  /** Resize the short when the legs are this % apart. */
  deltaBandPct: number;
  /** Ignore moves smaller than this, so fees don't eat the position. */
  minTradeUsd: number;
  /** Unwind everything after this many negative funding periods in a row. */
  maxNegativeFundingPeriods: number;
  /** Also unwind when the average of this many latest settlements is negative. */
  avgFundingPeriods: number;
  /** Don't add size unless the current 8h rate is at least this (flickers near zero churn fees). */
  minGrowFundingRate: number;
  allowWithdraw: boolean;
}

/** Everything the strategy holds right now. */
export interface Holdings {
  walletUsdc: number;
  spotEth: number;
  perpEquity: number;
  perpQty: number; // signed, negative = short
  markPrice: number;
  indexPrice: number;
  fundingRate: number; // current 8h rate
}

export interface Target {
  capitalUsd: number;
  reserveUsd: number;
  /** Estimated cost to enter and later exit the full position; left in the wallet. */
  feeBudgetUsd: number;
  marginUsd: number;
  spotUsd: number;
  spotEth: number;
  shortEth: number;
  /** Days of funding at the current rate to earn back the round-trip fees. */
  breakevenDays: number | null;
}

export type Step =
  /** Deposit wallet vbUSDC (reserve included) until perp equity reaches `usd`. */
  | { kind: "marginTo"; usd: number }
  /** Cover the short and sell vbETH, chunk by chunk, down to `eth`. */
  | { kind: "shrinkTo"; eth: number }
  /** Withdraw perp margin down to `usd`. */
  | { kind: "withdrawTo"; usd: number }
  /** Buy vbETH and short to match, chunk by chunk, up to `eth`, keeping `keepUsd` in the wallet. */
  | { kind: "growTo"; eth: number; keepUsd: number }
  /**
   * Buy vbETH up to `eth` regardless of the minimum trade, keeping `keepUsd` in the wallet: used when
   * the legs are apart by less than one perp order, which the short alone can't close.
   */
  | { kind: "alignSpot"; eth: number; keepUsd: number }
  /** Resize the short to the vbETH held. */
  | { kind: "hedge" }
  /** Close everything back to vbUSDC. */
  | { kind: "unwind" };

export interface RebalancePlan {
  target: Target;
  leverage: number | null;
  reasons: string[];
  notes: string[];
  steps: Step[];
}

export function capitalUsd(h: Holdings): number {
  return h.walletUsdc + h.spotEth * h.indexPrice + h.perpEquity;
}

/** Short notional / perp equity, computed from our own numbers. */
export function currentLeverage(h: Holdings): number | null {
  const short = Math.max(-h.perpQty, 0);
  if (short === 0 || h.perpEquity <= 0) return null;
  return (short * h.markPrice) / h.perpEquity;
}

/**
 * Splits capital into reserve, fee budget, margin and spot so that the short (= spot) runs at the
 * target leverage: spot = N, margin = N / L. The fee budget covers entering and exiting N.
 */
export function computeTarget(h: Holdings, s: StrategySettings): Target {
  const capital = capitalUsd(h);
  const reserveUsd = (capital * s.reservePct) / 100;
  const investable = Math.max(capital - reserveUsd, 0);
  const split = (budget: number) => budget / (1 + 1 / s.targetLeverage);
  const roundTripCost = (usd: number) => usd * ((2 * modeledSwapCostPct(usd)) / 100 + 2 * PERP_TAKER_FEE);

  const feeBudgetUsd = roundTripCost(split(investable));
  const spotUsd = split(investable - feeBudgetUsd);
  const marginUsd = investable - feeBudgetUsd - spotUsd;
  const spotEth = spotUsd / h.indexPrice;
  const dailyFunding = spotUsd * h.fundingRate * 3;

  return {
    capitalUsd: capital,
    reserveUsd,
    feeBudgetUsd,
    marginUsd,
    spotUsd,
    spotEth,
    shortEth: roundDownToStep(spotEth),
    breakevenDays: dailyFunding > 0 ? feeBudgetUsd / dailyFunding : null,
  };
}

/**
 * Whether a rebalance changed anything: spot, the short, or wallet vbUSDC (margin moves land there).
 * One that didn't (e.g. no vbUSDC to buy with) must not count as a run, or a stuck plan hits the cap.
 */
export function holdingsMoved(before: Holdings, after: Holdings): boolean {
  return (
    Math.abs(after.spotEth - before.spotEth) > 1e-6 ||
    Math.abs(after.perpQty - before.perpQty) > 1e-9 ||
    Math.abs(after.walletUsdc - before.walletUsdc) >= 0.01
  );
}

/**
 * `averageFunding` is the mean of the latest `s.avgFundingPeriods` settlements (null until there are
 * that many): a negative average unwinds even when the negatives alternate with positives.
 */
export function planRebalance(h: Holdings, s: StrategySettings, negativeFundingStreak: number, averageFunding: number | null = null): RebalancePlan {
  const target = computeTarget(h, s);
  const leverage = currentLeverage(h);
  const short = Math.max(-h.perpQty, 0);
  const reasons: string[] = [];
  const notes: string[] = [];
  const plan = (steps: Step[]): RebalancePlan => ({ target, leverage, reasons, notes, steps });

  if (h.perpQty > 0) {
    notes.push("Perp account holds a long position; close it manually first");
    return plan([]);
  }

  const holding = short > 0 || h.spotEth > 0;
  if (negativeFundingStreak >= s.maxNegativeFundingPeriods && holding) {
    reasons.push(`funding negative for ${negativeFundingStreak} periods in a row`);
    return plan([{ kind: "unwind" }]);
  }
  if (averageFunding !== null && averageFunding < 0 && holding) {
    reasons.push(`funding averaged ${(averageFunding * 100).toFixed(4)}%/8h over the last ${s.avgFundingPeriods} settlements`);
    return plan([{ kind: "unwind" }]);
  }

  const spotGapUsd = (target.spotEth - h.spotEth) * h.indexPrice;
  const sizeBandUsd = Math.max(s.minTradeUsd, (target.spotUsd * s.rebalanceBandPct) / 100);
  const sizeOff = Math.abs(spotGapUsd) > sizeBandUsd;
  const leverageOff = leverage !== null && (leverage > s.maxLeverage || leverage < s.minLeverage);
  const gapEth = h.spotEth - short;
  const deltaPct = short > 0 ? (gapEth / short) * 100 : h.spotEth > 0 ? Infinity : 0;
  const hedgeable = Math.abs(gapEth) >= PERP_MIN_ORDER_ETH;
  // A gap under one perp order can only be closed by moving spot, and only while a short is open.
  const deltaOff = Math.abs(deltaPct) > s.deltaBandPct && (hedgeable || short > 0);

  if (sizeOff) reasons.push(`spot is $${Math.abs(spotGapUsd).toFixed(2)} ${spotGapUsd > 0 ? "below" : "above"} target`);
  if (leverageOff) reasons.push(`leverage ${leverage!.toFixed(2)}x outside ${s.minLeverage}–${s.maxLeverage}x`);

  if (sizeOff || leverageOff) {
    const steps: Step[] = [];
    const needsMargin = target.marginUsd - h.perpEquity > s.minTradeUsd;
    const excessMargin = h.perpEquity - target.marginUsd > s.minTradeUsd;
    // Margin first: the reserve can be deposited in one transaction, before any slower spot sells.
    if (needsMargin) steps.push({ kind: "marginTo", usd: target.marginUsd });
    if (h.spotEth * h.indexPrice - target.spotUsd > s.minTradeUsd) {
      // Shrink by at least one perp order, or spot would be sold with no short to cover.
      const eth = target.spotEth < short ? Math.min(target.spotEth, short - PERP_MIN_ORDER_ETH) : target.spotEth;
      steps.push({ kind: "shrinkTo", eth: Math.max(eth, 0) });
      // Sale proceeds land in the wallet: finish topping up margin with them.
      if (needsMargin) steps.push({ kind: "marginTo", usd: target.marginUsd });
    }
    if (excessMargin) {
      if (s.allowWithdraw) steps.push({ kind: "withdrawTo", usd: target.marginUsd });
      else notes.push(`$${(h.perpEquity - target.marginUsd).toFixed(2)} extra margin stays on the exchange (withdraw disabled)`);
    }
    if (spotGapUsd > s.minTradeUsd) {
      // Grow by at least one perp order, or the short can't follow the spot bought.
      const eth = target.spotEth > short ? Math.max(target.spotEth, short + PERP_MIN_ORDER_ETH + ALIGN_BUFFER_ETH) : target.spotEth;
      steps.push({ kind: "growTo", eth, keepUsd: target.reserveUsd + target.feeBudgetUsd });
    }
    steps.push({ kind: "hedge" });
    return plan(steps);
  }

  if (deltaOff) {
    reasons.push(`legs ${Math.abs(deltaPct).toFixed(1)}% apart`);
    if (hedgeable) return plan([{ kind: "hedge" }]);
    // Spot over the short: buy up to a full extra perp order and short it. Spot under: buy up to the short.
    const eth = short + (gapEth > 0 ? PERP_MIN_ORDER_ETH : 0) + ALIGN_BUFFER_ETH;
    notes.push(`gap ${Math.abs(gapEth).toFixed(4)} ETH is under the ${PERP_MIN_ORDER_ETH} ETH minimum order, so spot moves instead`);
    // May dip into half the reserve: the amounts are a few dollars.
    return plan([{ kind: "alignSpot", eth, keepUsd: target.reserveUsd / 2 }, { kind: "hedge" }]);
  }

  return plan([]);
}
