import { basisPct, hasShort, netDeltaPct, rallyToLiquidationPct } from "./metrics";
import type { Alert, Snapshot, Thresholds } from "./types";

export const DEFAULT_THRESHOLDS: Thresholds = {
  alertLeverage: 3,
  killLeverage: 4,
  alertDeltaPct: 2,
  urgentDeltaPct: 5,
  alertBasisPct: 0.5,
  killBasisPct: 1,
  pegBasisPct: 0.5,
  killNegativeFundingPeriods: 3,
  avgFundingPeriods: 6,
  alertRallyToLiquidationPct: 20,
  minGasEth: 0.0005,
};

export interface RiskInput {
  current: Snapshot;
  /** Most recent published funding rates, newest first. */
  recentRates: number[];
  /** Perp size changed since the last snapshot without a fill of ours (ADL or liquidation). */
  unexplainedPositionChange: boolean;
  thresholds: Thresholds;
}

/** What the 15-second risk check can see: perp data only, no chain reads. */
export interface FastRiskInput {
  shortEth: number;
  perpEquity: number;
  markPrice: number;
  liquidationPrice: number; // 0 when no position
}

export interface FastRiskResult {
  leverage: number | null;
  rallyToLiquidationPct: number | null;
  alerts: Alert[];
  /** Leverage above the rebalance band or liquidation too close: act now, don't wait for the full check. */
  urgent: boolean;
}

export function evaluateFastRisk(r: FastRiskInput, maxLeverage: number, t: Thresholds): FastRiskResult {
  if (r.shortEth <= 0) return { leverage: null, rallyToLiquidationPct: null, alerts: [], urgent: false };
  const leverage = r.perpEquity > 0 ? (r.shortEth * r.markPrice) / r.perpEquity : Infinity;
  const rally = r.liquidationPrice > 0 ? (r.liquidationPrice / r.markPrice - 1) * 100 : null;
  const alerts: Alert[] = [];
  if (leverage >= t.killLeverage) {
    alerts.push({ code: "LEVERAGE_KILL", level: "kill", message: `Perp leverage ${leverage.toFixed(2)}x ≥ ${t.killLeverage}x` });
  } else if (leverage >= t.alertLeverage) {
    alerts.push({ code: "LEVERAGE_HIGH", level: "warn", message: `Perp leverage ${leverage.toFixed(2)}x ≥ ${t.alertLeverage}x: add margin` });
  }
  if (rally !== null && rally < t.alertRallyToLiquidationPct) {
    alerts.push({ code: "LIQ_CLOSE", level: "warn", message: `Liquidation at $${r.liquidationPrice.toFixed(2)}, only +${rally.toFixed(1)}% away` });
  }
  return {
    leverage,
    rallyToLiquidationPct: rally,
    alerts,
    urgent: leverage > maxLeverage || (rally !== null && rally < t.alertRallyToLiquidationPct),
  };
}

/**
 * Trigger price for the exchange-side protective stop: `belowLiqPct` % under the liquidation price,
 * rounded down to the market's tick (0.1 on ETH-USD, 1 on BTC-USD). Anchored to liquidation (not mark) so it only moves when margin or
 * size changes, instead of churning with every price tick.
 */
export function protectiveStopPrice(liquidationPrice: number, belowLiqPct: number, tick = 0.1): number {
  const steps = 1 / tick;
  return Math.floor(liquidationPrice * (1 - belowLiqPct / 100) * steps) / steps;
}

/** True when an existing stop no longer matches the short size or the target trigger. */
export function stopNeedsReplacing(
  stop: { qty: number; triggerPrice: number },
  shortEth: number,
  targetTrigger: number,
  tolerancePct = 1,
): boolean {
  return Math.abs(stop.qty - shortEth) > 1e-9 || Math.abs(stop.triggerPrice / targetTrigger - 1) * 100 > tolerancePct;
}

/** Mean of the latest `periods` settlements, or null until that many exist. */
export function averageFunding(ratesNewestFirst: number[], periods: number): number | null {
  if (periods <= 0 || ratesNewestFirst.length < periods) return null;
  return ratesNewestFirst.slice(0, periods).reduce((s, r) => s + r, 0) / periods;
}

export function consecutiveNegative(ratesNewestFirst: number[]): number {
  let n = 0;
  for (const r of ratesNewestFirst) {
    if (r >= 0) break;
    n++;
  }
  return n;
}

export function evaluateAlerts({ current: s, recentRates, unexplainedPositionChange, thresholds: t }: RiskInput): Alert[] {
  const alerts: Alert[] = [];
  const fmt = (n: number, d = 2) => n.toFixed(d);

  if (hasShort(s)) {
    if (s.perpLeverage >= t.killLeverage) {
      alerts.push({ code: "LEVERAGE_KILL", level: "kill", message: `Perp leverage ${fmt(s.perpLeverage)}x ≥ ${t.killLeverage}x` });
    } else if (s.perpLeverage >= t.alertLeverage) {
      alerts.push({ code: "LEVERAGE_HIGH", level: "warn", message: `Perp leverage ${fmt(s.perpLeverage)}x ≥ ${t.alertLeverage}x: add margin` });
    }

    const rally = rallyToLiquidationPct(s);
    if (rally !== null && rally < t.alertRallyToLiquidationPct) {
      alerts.push({ code: "LIQ_CLOSE", level: "warn", message: `Liquidation at $${fmt(s.liquidationPrice)}, only +${fmt(rally, 1)}% away` });
    }
  }

  if (hasShort(s) || s.spotEth > 0) {
    const delta = netDeltaPct(s);
    if (Math.abs(delta) >= t.alertDeltaPct) {
      const side = delta > 0 ? "long" : "short";
      const urgent = Math.abs(delta) >= t.urgentDeltaPct;
      alerts.push({
        code: urgent ? "DELTA_DRIFT_URGENT" : "DELTA_DRIFT",
        level: urgent ? "urgent" : "warn",
        message: `Legs ${fmt(Math.abs(delta), 1)}% apart (net ${side})${urgent ? ": position is not hedged" : ""}`,
      });
    }

    const basis = basisPct(s);
    if (Math.abs(basis) >= t.killBasisPct) {
      alerts.push({ code: "BASIS_KILL", level: "kill", message: `Sushi vs index basis ${fmt(basis)}% ≥ ${t.killBasisPct}%: possible depeg` });
    } else if (Math.abs(basis) >= t.alertBasisPct) {
      alerts.push({ code: "BASIS_HIGH", level: "warn", message: `Sushi vs index basis ${fmt(basis)}%` });
    }
  }

  const negatives = consecutiveNegative(recentRates);
  const average = averageFunding(recentRates, t.avgFundingPeriods);
  if (negatives >= t.killNegativeFundingPeriods) {
    alerts.push({ code: "FUNDING_KILL", level: "kill", message: `Funding negative for ${negatives} periods in a row` });
  } else if (average !== null && average < 0) {
    alerts.push({
      code: "FUNDING_AVG_KILL",
      level: "kill",
      message: `Funding averaged ${(average * 100).toFixed(4)}%/8h over the last ${t.avgFundingPeriods} settlements`,
    });
  } else if (negatives > 0) {
    alerts.push({ code: "FUNDING_NEGATIVE", level: "warn", message: `Latest funding rate negative (${negatives} in a row)` });
  }

  if (unexplainedPositionChange) {
    alerts.push({ code: "POSITION_CHANGED", level: "warn", message: "Perp size changed without our fill: check for ADL or liquidation" });
  }

  if (s.gasEth < t.minGasEth) {
    alerts.push({ code: "GAS_LOW", level: "warn", message: `Gas balance ${s.gasEth.toFixed(5)} ETH` });
  }

  return alerts;
}
