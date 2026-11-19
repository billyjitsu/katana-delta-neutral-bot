/**
 * WBTC carry: the deposit sits as Morpho collateral, the bot borrows vbUSDC against it, buys an
 * extra "slice" of WBTC (also collateral) and shorts exactly the slice on BTC-USD. Net BTC stays
 * equal to the deposit; funding on the short minus interest on the debt is the yield, in BTC.
 *
 * Notation (as in the scope doc): l = target LTV on all collateral, k = perp leverage on the slice,
 * D = deposit (BTC), x = slice as a share of D, B = debt as a share of D·P.
 */
import type { Alert } from "./types";

/** Katana Perps BTC-USD order granularity. */
export const BTC_STEP = 0.0001;
export const BTC_MIN_ORDER = 0.0005;
/** Below this the bot treats a BTC amount as zero (1,000 sats). */
export const DUST_BTC = 0.00001;

export interface CarrySettings {
  targetLtv: number;
  targetPerpLeverage: number;
  /** Kind 1 band: move USDC between Morpho and the perp account when leverage leaves it. */
  minPerpLeverage: number;
  maxPerpLeverage: number;
  /** Below minLtv the slice grows; above maxLtv the bot repays (and alerts). */
  minLtv: number;
  maxLtv: number;
  /** Kind 2: resize the slice when it is this % away from its target. */
  sliceBandPct: number;
  /** Re-hedge when the short and the slice are this % apart. */
  deltaBandPct: number;
  /** Halve the slice once the borrow APY has stayed at or above this for shrinkAfterHours. */
  shrinkBorrowApy: number;
  shrinkAfterHours: number;
  /** A halved slice only grows back once the borrow APY is below this. */
  resumeBorrowApy: number;
  unwindBorrowApy: number;
  maxNegativeFundingPeriods: number;
  /** Ladder: alert at retry*, shrink at shrink*, unwind at unwindLtv. */
  retryPerpLeverage: number;
  shrinkPerpLeverage: number;
  shrinkLtv: number;
  unwindLtv: number;
  minTradeUsd: number;
  /** vbUSDC kept in the wallet; anything above it repays debt. */
  walletReserveUsd: number;
  compoundMinUsd: number;
  compoundEveryDays: number;
}

/** Config A from the scope doc. */
export const DEFAULT_CARRY_SETTINGS: CarrySettings = {
  targetLtv: 0.4,
  targetPerpLeverage: 3.3,
  minPerpLeverage: 2.5,
  maxPerpLeverage: 4.5,
  minLtv: 0.3,
  maxLtv: 0.5,
  sliceBandPct: 15,
  deltaBandPct: 2,
  shrinkBorrowApy: 0.07,
  shrinkAfterHours: 24,
  resumeBorrowApy: 0.05,
  unwindBorrowApy: 0.1,
  maxNegativeFundingPeriods: 3,
  retryPerpLeverage: 6.2,
  shrinkPerpLeverage: 9.8,
  shrinkLtv: 0.6,
  unwindLtv: 0.7,
  minTradeUsd: 5,
  walletReserveUsd: 0,
  compoundMinUsd: 25,
  compoundEveryDays: 7,
};

export interface CarryHoldings {
  /** Target net BTC: deposits plus compounded profit, minus withdrawals. */
  depositBtc: number;
  collateralBtc: number;
  /** vbWBTC sitting in the wallet, not yet supplied. */
  walletBtc: number;
  debtUsd: number;
  walletUsdc: number;
  perpEquity: number;
  /** Signed BTC-USD position, negative = short. */
  perpQty: number;
  markPrice: number;
  indexPrice: number;
  /** Morpho oracle, USD per BTC: what liquidation is measured against. */
  oraclePrice: number;
  /** Current 8h funding rate. */
  fundingRate: number;
  borrowApy: number;
  lltv: number;
}

export interface CarryMetrics {
  sliceBtc: number;
  shortBtc: number;
  /** BTC exposure: collateral + wallet BTC − short. Should equal depositBtc. */
  netBtc: number;
  netBtcDriftPct: number;
  ltv: number | null;
  perpLeverage: number | null;
  equityUsd: number;
  equityBtc: number;
  profitBtc: number;
  profitUsd: number;
  /** Oracle price at which Morpho liquidates, and how far that is from the current oracle price. */
  morphoLiquidationPrice: number | null;
  dropToMorphoLiquidationPct: number | null;
  /** Mark price at which the perp short is liquidated (modeled from MMF). */
  perpLiquidationPrice: number | null;
  rallyToPerpLiquidationPct: number | null;
  /** Annualized funding on the short minus interest on the debt, as a share of the deposit's value. */
  liveYieldPct: number | null;
}

export interface CarryTarget {
  sliceFraction: number;
  sliceBtc: number;
  shortBtc: number;
  debtUsd: number;
  marginUsd: number;
}

export type CarryStep =
  /** Supply the wallet's vbWBTC as Morpho collateral. */
  | { kind: "supply" }
  /** Add `usd` perp margin: wallet vbUSDC first, then borrow. */
  | { kind: "topUp"; usd: number }
  /** Withdraw `usd` perp margin and repay Morpho with it when it lands. */
  | { kind: "release"; usd: number }
  /** Repay Morpho from wallet vbUSDC above the reserve. */
  | { kind: "repay"; usd: number }
  /** Borrow, buy vbWBTC, supply it and short it, chunk by chunk, until the slice is `sliceBtc`. */
  | { kind: "grow"; sliceBtc: number; marginUsd: number }
  /** Close short and sell slice together, repaying as it goes, down to `sliceBtc`. */
  | { kind: "shrink"; sliceBtc: number }
  /** Resize the short to the slice. */
  | { kind: "hedge" }
  /** Turn `usd` of profit into WBTC added to the deposit. */
  | { kind: "compound"; usd: number }
  /** Close the short, sell the whole slice, repay everything. The deposit stays as collateral. */
  | { kind: "unwind" };

export type CarryUrgency = "none" | "rebalance" | "emergency";

export interface CarryPlan {
  metrics: CarryMetrics;
  target: CarryTarget;
  /** The rate guard has halved the slice target; the caller persists this as sliceHalved. */
  halved: boolean;
  urgency: CarryUrgency;
  reasons: string[];
  notes: string[];
  steps: CarryStep[];
}

export interface CarryPlanContext {
  negativeFundingStreak: number;
  /** How long the borrow APY has stayed at or above shrinkBorrowApy (0 if it is below now). */
  hoursAboveShrinkApy: number;
  /** The slice was halved by the rate guard and the rate hasn't come back below resumeBorrowApy. */
  sliceHalved: boolean;
  lastCompoundAt: number | undefined;
  now: number;
  maintenanceMarginFraction: number;
}

export function roundBtc(qty: number): number {
  return Math.floor(qty / BTC_STEP + 1e-9) * BTC_STEP;
}

/** Slice as a share of the deposit: x = l / (1 + 1/k − l). */
export function sliceFraction(targetLtv: number, perpLeverage: number): number {
  return targetLtv / (1 + 1 / perpLeverage - targetLtv);
}

export interface YieldModel {
  sliceFraction: number;
  /** Debt as a share of the deposit's value: l·(1 + x). */
  debtFraction: number;
  marginFraction: number;
  /** Yearly gain as a share of the deposit (0.031 = 3.1% more BTC a year), before one-off costs. */
  netYield: number;
  /** Borrow APY at which the slice stops paying: F / (1 + 1/k). */
  breakEvenBorrowApy: number;
}

/** `fundingApr` and `borrowApy` as fractions. */
export function carryYield(targetLtv: number, perpLeverage: number, fundingApr: number, borrowApy: number): YieldModel {
  const x = sliceFraction(targetLtv, perpLeverage);
  const debt = targetLtv * (1 + x);
  return {
    sliceFraction: x,
    debtFraction: debt,
    marginFraction: x / perpLeverage,
    netYield: x * fundingApr - debt * borrowApy,
    breakEvenBorrowApy: fundingApr / (1 + 1 / perpLeverage),
  };
}

export const fundingApr = (rate8h: number) => rate8h * 3 * 365;

/** Mark price at which a short of `shortBtc` with `equity` hits maintenance margin. */
export function shortLiquidationPrice(shortBtc: number, equity: number, mark: number, mmf: number): number | null {
  if (shortBtc <= 0) return null;
  return (equity + shortBtc * mark) / (shortBtc * (1 + mmf));
}

export function carryTarget(depositBtc: number, price: number, s: CarrySettings, sliceScale = 1): CarryTarget {
  const x = sliceFraction(s.targetLtv, s.targetPerpLeverage);
  const sliceBtc = x * depositBtc * sliceScale;
  return {
    sliceFraction: x * sliceScale,
    sliceBtc,
    shortBtc: roundBtc(sliceBtc),
    debtUsd: s.targetLtv * (depositBtc + sliceBtc) * price,
    marginUsd: (sliceBtc * price) / s.targetPerpLeverage,
  };
}

export function carryMetrics(h: CarryHoldings, mmf: number): CarryMetrics {
  const btc = h.collateralBtc + h.walletBtc;
  const shortBtc = Math.max(-h.perpQty, 0);
  const netBtc = btc + h.perpQty;
  const ltv = h.collateralBtc > 0 ? h.debtUsd / (h.collateralBtc * h.oraclePrice) : h.debtUsd > 0 ? Infinity : null;
  const perpLeverage = shortBtc > 0 ? (h.perpEquity > 0 ? (shortBtc * h.markPrice) / h.perpEquity : Infinity) : null;
  const equityUsd = btc * h.indexPrice - h.debtUsd + h.perpEquity + h.walletUsdc;
  const morphoLiq = h.collateralBtc > 0 && h.debtUsd > 0 ? h.debtUsd / (h.collateralBtc * h.lltv) : null;
  const perpLiq = shortLiquidationPrice(shortBtc, h.perpEquity, h.markPrice, mmf);
  const depositUsd = h.depositBtc * h.indexPrice;
  return {
    sliceBtc: btc - h.depositBtc,
    shortBtc,
    netBtc,
    netBtcDriftPct: h.depositBtc > 0 ? (netBtc / h.depositBtc - 1) * 100 : 0,
    ltv,
    perpLeverage,
    equityUsd,
    equityBtc: equityUsd / h.indexPrice,
    profitBtc: equityUsd / h.indexPrice - h.depositBtc,
    profitUsd: equityUsd - depositUsd,
    morphoLiquidationPrice: morphoLiq,
    dropToMorphoLiquidationPct: morphoLiq === null ? null : (1 - morphoLiq / h.oraclePrice) * 100,
    perpLiquidationPrice: perpLiq,
    rallyToPerpLiquidationPct: perpLiq === null ? null : (perpLiq / h.markPrice - 1) * 100,
    liveYieldPct:
      depositUsd > 0 ? ((shortBtc * h.markPrice * fundingApr(h.fundingRate) - h.debtUsd * h.borrowApy) / depositUsd) * 100 : null,
  };
}

/**
 * BTC to take out of the slice (closing the same amount of short) so that perp leverage is back
 * to `maxLev` and LTV back to `maxLtv`. Selling q BTC cuts the notional by q·P and repays q·P of debt.
 */
export function shrinkAmount(h: CarryHoldings, m: CarryMetrics, maxLev: number, maxLtv: number): number {
  const qLev = m.shortBtc - (maxLev * Math.max(h.perpEquity, 0)) / h.markPrice;
  const qLtv = (h.debtUsd - maxLtv * h.collateralBtc * h.oraclePrice) / (h.oraclePrice * (1 - maxLtv));
  return Math.min(Math.max(qLev, qLtv, 0), Math.max(m.sliceBtc, 0));
}

export function planCarry(h: CarryHoldings, s: CarrySettings, c: CarryPlanContext): CarryPlan {
  const m = carryMetrics(h, c.maintenanceMarginFraction);
  const reasons: string[] = [];
  const notes: string[] = [];
  const steps: CarryStep[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  // A halved slice stays halved until the rate is clearly back down.
  const rateShrink = c.hoursAboveShrinkApy >= s.shrinkAfterHours;
  const halved = rateShrink || (c.sliceHalved && h.borrowApy >= s.resumeBorrowApy);
  const target = carryTarget(h.depositBtc, h.indexPrice, s, halved ? 0.5 : 1);
  const plan = (urgency: CarryUrgency): CarryPlan => ({ metrics: m, target, halved, urgency, reasons, notes, steps });

  const hasSlice = m.sliceBtc > DUST_BTC || m.shortBtc > 0;
  const btcUsd = (btc: number) => btc * h.indexPrice;

  if (h.perpQty > 0) {
    notes.push("Perp account holds a long BTC-USD position; close it manually first");
    return plan("none");
  }
  // Without a recorded deposit every BTC held would count as slice and be shorted away.
  if (h.depositBtc <= DUST_BTC) {
    if (m.shortBtc > 0 || h.debtUsd > 0 || h.collateralBtc > DUST_BTC || h.walletBtc > DUST_BTC) {
      notes.push("No deposit recorded: run `deposit <btc>` for the WBTC you put in before rebalancing");
    }
    return plan("none");
  }
  if (h.walletBtc > DUST_BTC) steps.push({ kind: "supply" });

  // Guards and the last rungs of the ladder: get out of the slice.
  if (hasSlice) {
    if (h.borrowApy >= s.unwindBorrowApy) reasons.push(`borrow APY ${pct(h.borrowApy)} ≥ ${pct(s.unwindBorrowApy)}`);
    if (c.negativeFundingStreak >= s.maxNegativeFundingPeriods) reasons.push(`funding negative for ${c.negativeFundingStreak} periods`);
    if (m.ltv !== null && m.ltv >= s.unwindLtv) reasons.push(`LTV ${pct(m.ltv)} ≥ ${pct(s.unwindLtv)}`);
    if (reasons.length) {
      steps.push({ kind: "unwind" });
      return plan("emergency");
    }

    const levTight = m.perpLeverage !== null && m.perpLeverage >= s.shrinkPerpLeverage;
    const ltvTight = m.ltv !== null && m.ltv >= s.shrinkLtv;
    if (levTight || ltvTight) {
      if (levTight) reasons.push(`perp leverage ${m.perpLeverage!.toFixed(1)}x ≥ ${s.shrinkPerpLeverage}x`);
      if (ltvTight) reasons.push(`LTV ${pct(m.ltv!)} ≥ ${pct(s.shrinkLtv)}`);
      const q = shrinkAmount(h, m, s.maxPerpLeverage, s.maxLtv);
      steps.push({ kind: "shrink", sliceBtc: Math.max(m.sliceBtc - q, 0) });
      return plan("emergency");
    }
  }

  // Kind 1: perp leverage out of band. One USDC move fixes leverage and LTV together.
  let urgency: CarryUrgency = "none";
  let movedMargin = false;
  if (m.perpLeverage !== null && (m.perpLeverage > s.maxPerpLeverage || m.perpLeverage < s.minPerpLeverage)) {
    const gap = (m.shortBtc * h.markPrice) / s.targetPerpLeverage - h.perpEquity;
    if (Math.abs(gap) >= s.minTradeUsd) {
      reasons.push(`perp leverage ${m.perpLeverage.toFixed(2)}x outside ${s.minPerpLeverage}–${s.maxPerpLeverage}x`);
      steps.push(gap > 0 ? { kind: "topUp", usd: gap } : { kind: "release", usd: -gap });
      if (m.perpLeverage >= s.retryPerpLeverage) notes.push("perp leverage past the retry rung: an earlier top-up may not have landed");
      urgency = "rebalance";
      movedMargin = true;
    }
  }

  // Margin that came back from the exchange (or any spare vbUSDC) pays down debt.
  const spareUsdc = h.walletUsdc - s.walletReserveUsd;
  if (!movedMargin && h.debtUsd > 0 && spareUsdc >= s.minTradeUsd) {
    steps.push({ kind: "repay", usd: Math.min(spareUsdc, h.debtUsd) });
    reasons.push(`$${spareUsdc.toFixed(2)} vbUSDC in the wallet`);
    urgency = "rebalance";
  }

  if (m.ltv !== null && m.ltv > s.maxLtv && !movedMargin) {
    notes.push(`LTV ${pct(m.ltv)} above ${pct(s.maxLtv)} with no perp margin to spare`);
  }

  // Kind 2: resize the slice (entry, added deposit, rate guard, LTV below band).
  const sliceGap = target.sliceBtc - m.sliceBtc;
  const sliceOff = Math.abs(sliceGap) > (target.sliceBtc * s.sliceBandPct) / 100 && btcUsd(Math.abs(sliceGap)) >= s.minTradeUsd;
  const ltvLow = m.ltv !== null && m.ltv < s.minLtv && sliceGap > 0 && btcUsd(sliceGap) >= s.minTradeUsd;
  if (h.depositBtc > 0 && (sliceOff || ltvLow)) {
    if (sliceGap > 0) {
      const fundingOk = h.fundingRate > 0;
      const rateOk = h.borrowApy < s.shrinkBorrowApy;
      if (!fundingOk) notes.push("slice below target but funding is not positive: not growing");
      else if (!rateOk) notes.push(`slice below target but borrow APY ${pct(h.borrowApy)} ≥ ${pct(s.shrinkBorrowApy)}: not growing`);
      else {
        reasons.push(m.sliceBtc <= DUST_BTC ? "no slice yet" : `slice ${m.sliceBtc.toFixed(5)} BTC below target ${target.sliceBtc.toFixed(5)}`);
        steps.push({ kind: "grow", sliceBtc: target.sliceBtc, marginUsd: target.marginUsd });
        if (urgency === "none") urgency = "rebalance";
      }
    } else {
      reasons.push(rateShrink ? `borrow APY ≥ ${pct(s.shrinkBorrowApy)} for ${c.hoursAboveShrinkApy.toFixed(0)}h: halving the slice` : `slice ${m.sliceBtc.toFixed(5)} BTC above target ${target.sliceBtc.toFixed(5)}`);
      steps.push({ kind: "shrink", sliceBtc: target.sliceBtc });
      if (urgency === "none") urgency = "rebalance";
    }
  }

  // Short drifted from the slice (a partial fill, the stop fired, collateral changed).
  const touchesShort = steps.some((x) => x.kind === "grow" || x.kind === "shrink");
  const hedgeGap = Math.abs(roundBtc(Math.max(m.sliceBtc, 0)) - m.shortBtc);
  const hedgeOff = hedgeGap >= BTC_MIN_ORDER && hedgeGap > (Math.max(m.sliceBtc, 0) * s.deltaBandPct) / 100;
  if (!touchesShort && hedgeOff) {
    reasons.push(`short ${m.shortBtc.toFixed(4)} vs slice ${m.sliceBtc.toFixed(4)} BTC`);
    steps.push({ kind: "hedge" });
    if (urgency === "none") urgency = "rebalance";
  }

  // Profit into WBTC, only when nothing else is going on.
  const compoundDue = c.lastCompoundAt === undefined || c.now - c.lastCompoundAt >= s.compoundEveryDays * 86_400_000;
  if (!steps.length && m.profitUsd >= s.compoundMinUsd && compoundDue && m.shortBtc > 0) {
    reasons.push(`$${m.profitUsd.toFixed(2)} profit to compound`);
    steps.push({ kind: "compound", usd: m.profitUsd });
    urgency = "rebalance";
  }

  return plan(steps.length ? urgency : "none");
}

export interface CarryThresholds {
  alertNetBtcDriftPct: number;
  alertBasisPct: number;
  killBasisPct: number;
  alertUtilization: number;
  /** Warn when the borrow APY passes this (the planning ceiling). */
  alertBorrowApy: number;
  minGasEth: number;
}

export const DEFAULT_CARRY_THRESHOLDS: CarryThresholds = {
  alertNetBtcDriftPct: 2,
  alertBasisPct: 0.5,
  killBasisPct: 2,
  alertUtilization: 0.99,
  alertBorrowApy: 0.07,
  minGasEth: 0.0005,
};

export interface CarryRiskInput {
  holdings: CarryHoldings;
  metrics: CarryMetrics;
  utilization: number;
  sushiPrice: number;
  gasEth: number;
  negativeFundingStreak: number;
}

/** Price checks against the perp index: Sushi (what we trade at) and the Morpho oracle (what liquidates us). */
export function carryBasis(h: CarryHoldings, sushiPrice: number) {
  return {
    sushiPct: (sushiPrice / h.indexPrice - 1) * 100,
    oraclePct: (h.oraclePrice / h.indexPrice - 1) * 100,
  };
}

export function evaluateCarryAlerts(r: CarryRiskInput, s: CarrySettings, t: CarryThresholds): Alert[] {
  const { holdings: h, metrics: m } = r;
  const alerts: Alert[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const active = m.shortBtc > 0 || m.sliceBtc > DUST_BTC || h.debtUsd > 0;

  if (m.perpLeverage !== null) {
    if (m.perpLeverage >= s.shrinkPerpLeverage) {
      alerts.push({ code: "PERP_LEV_KILL", level: "kill", message: `Perp leverage ${m.perpLeverage.toFixed(1)}x: shrinking the slice` });
    } else if (m.perpLeverage >= s.retryPerpLeverage) {
      alerts.push({ code: "PERP_LEV_HIGH", level: "warn", message: `Perp leverage ${m.perpLeverage.toFixed(1)}x: margin top-up hasn't landed, retrying` });
    }
  }
  if (m.ltv !== null && h.debtUsd > 0) {
    if (m.ltv >= s.shrinkLtv) {
      alerts.push({ code: "LTV_KILL", level: "kill", message: `Morpho LTV ${pct(m.ltv)}: shrinking the slice (liquidation at ${pct(h.lltv)})` });
    } else if (m.ltv >= s.maxLtv) {
      alerts.push({ code: "LTV_HIGH", level: "warn", message: `Morpho LTV ${pct(m.ltv)} ≥ ${pct(s.maxLtv)}: repay hasn't landed, retrying` });
    }
  }
  if (active && h.borrowApy >= t.alertBorrowApy) {
    alerts.push({
      code: "BORROW_APY_HIGH",
      level: h.borrowApy >= s.unwindBorrowApy ? "kill" : "warn",
      message: `Morpho borrow APY ${pct(h.borrowApy)} (shrink after ${s.shrinkAfterHours}h ≥ ${pct(s.shrinkBorrowApy)}, unwind ≥ ${pct(s.unwindBorrowApy)})`,
    });
  }
  if (active && r.utilization >= t.alertUtilization) {
    alerts.push({ code: "UTILIZATION_HIGH", level: "warn", message: `Morpho utilization ${pct(r.utilization)}: borrowing for top-ups may fail` });
  }
  if (h.depositBtc > 0 && Math.abs(m.netBtcDriftPct) >= t.alertNetBtcDriftPct) {
    alerts.push({
      code: "NET_BTC_DRIFT",
      level: "warn",
      message: `Net BTC ${m.netBtc.toFixed(5)} is ${m.netBtcDriftPct.toFixed(1)}% off the deposit ${h.depositBtc.toFixed(5)} (short ${m.shortBtc.toFixed(4)}, slice ${m.sliceBtc.toFixed(5)})`,
    });
  }
  const basis = carryBasis(h, r.sushiPrice);
  for (const [name, value] of [["Sushi", basis.sushiPct], ["Morpho oracle", basis.oraclePct]] as const) {
    if (!active) break;
    if (Math.abs(value) >= t.killBasisPct) {
      alerts.push({ code: `BASIS_KILL_${name === "Sushi" ? "SUSHI" : "ORACLE"}`, level: "kill", message: `${name} vs index ${value.toFixed(2)}%: possible vbWBTC depeg, trading stopped` });
    } else if (Math.abs(value) >= t.alertBasisPct) {
      alerts.push({ code: `BASIS_HIGH_${name === "Sushi" ? "SUSHI" : "ORACLE"}`, level: "warn", message: `${name} vs index ${value.toFixed(2)}%` });
    }
  }
  if (r.negativeFundingStreak > 0 && m.shortBtc > 0) {
    alerts.push({
      code: "FUNDING_NEGATIVE",
      level: r.negativeFundingStreak >= s.maxNegativeFundingPeriods ? "kill" : "warn",
      message: `BTC-USD funding negative ${r.negativeFundingStreak} period(s) in a row`,
    });
  }
  if (active && r.gasEth < t.minGasEth) {
    alerts.push({ code: "GAS_LOW", level: "warn", message: `Gas balance ${r.gasEth.toFixed(5)} ETH` });
  }
  return alerts;
}

/** Hours the borrow APY has stayed at or above `threshold`, from (time, apy) samples oldest first. */
export function hoursAbove(samples: { time: number; apy: number }[], threshold: number, now: number): number {
  let since: number | undefined;
  for (const x of samples) {
    if (x.apy >= threshold) since ??= x.time;
    else since = undefined;
  }
  return since === undefined ? 0 : (now - since) / 3_600_000;
}
