import type { Snapshot, SwapRecord } from "./types";

export const PERP_TAKER_FEE = 0.00019;

/**
 * Sushi vbUSDC -> vbETH cost vs index by trade size, measured 2026-10-21 on the 0.05% pool.
 * Used as the model that real swap costs are compared against (H3).
 */
export const SWAP_COST_MODEL: ReadonlyArray<readonly [usd: number, pct: number]> = [
  [0, 0.05],
  [100, 0.1],
  [1_000, 0.19],
  [6_400, 0.7],
];

export function hasShort(s: Snapshot): boolean {
  return s.perpQty < 0;
}

/** ETH exposure left after the hedge. Positive = net long. */
export function netDeltaEth(s: Snapshot): number {
  return s.spotEth + s.perpQty;
}

/** Net exposure as a % of the short size. */
export function netDeltaPct(s: Snapshot): number {
  const short = Math.abs(s.perpQty);
  if (short === 0) return s.spotEth === 0 ? 0 : Infinity;
  return (netDeltaEth(s) / short) * 100;
}

/** Sushi spot price vs perp index, in %. Large values mean a vbETH/vbUSDC depeg or a thin pool. */
export function basisPct(s: Snapshot): number {
  return (s.sushiPrice / s.indexPrice - 1) * 100;
}

/** Strategy value in USD: spot leg at index + reserve + perp equity. Gas ETH is excluded. */
export function totalEquity(s: Snapshot): number {
  return s.spotEth * s.indexPrice + s.walletUsdc + s.perpEquity;
}

/** How far ETH can rally from mark before the short is liquidated, in %. */
export function rallyToLiquidationPct(s: Snapshot): number | null {
  if (!hasShort(s) || s.liquidationPrice <= 0) return null;
  return (s.liquidationPrice / s.markPrice - 1) * 100;
}

/**
 * ETH price at which the short's leverage reaches `targetLeverage`, all else equal.
 * Equity moves against the short one for one: E(P) = E₀ + q·(P₀ − P), so solving q·P / E(P) = L gives
 * P = L·(E₀ + q·P₀) / (q·(1 + L)). Returns null with no short.
 */
export function leverageTriggerPrice(shortEth: number, perpEquity: number, markPrice: number, targetLeverage: number): number | null {
  if (shortEth <= 0) return null;
  return (targetLeverage * (perpEquity + shortEth * markPrice)) / (shortEth * (1 + targetLeverage));
}

/** Approximate rally to liquidation for a fresh isolated short at leverage L. */
export function liquidationRallyForLeverage(leverage: number, maintenanceMarginFraction: number): number {
  return (1 / leverage - maintenanceMarginFraction) / (1 + maintenanceMarginFraction);
}

/** Funding received (USD) for one settlement. Shorts receive when the rate is positive. */
export function expectedFundingUsd(positionQty: number, rate: number, indexPrice: number): number {
  return -positionQty * rate * indexPrice;
}

/** Modeled swap cost for a trade of `usd`, in %. Linear between measured points, flat beyond. */
export function modeledSwapCostPct(usd: number): number {
  const points = SWAP_COST_MODEL;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    if (usd <= x1) {
      const [x0, y0] = points[i - 1]!;
      return y0 + ((usd - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  const [xN, yN] = points[points.length - 1]!;
  return yN * (usd / xN);
}

/** Execution cost of a swap vs the reference price, in USD. Positive = worse than reference. */
export function swapCostUsd(s: SwapRecord): number {
  const atRef = s.ethAmount * s.refPrice;
  return s.direction === "buy" ? s.usdcAmount - atRef : atRef - s.usdcAmount;
}
