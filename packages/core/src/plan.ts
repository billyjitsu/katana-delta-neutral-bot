/** Katana Perps ETH-USD order granularity. */
export const PERP_STEP_ETH = 0.001;
export const PERP_MIN_ORDER_ETH = 0.01;

export function roundDownToStep(qty: number, step = PERP_STEP_ETH): number {
  return Math.floor(qty / step + 1e-9) * step;
}

/**
 * Size of the perp order (ETH, always positive) needed to bring the short in line with spot,
 * or 0 when the gap is below the minimum order size.
 */
export function shortAdjustment(spotEth: number, perpQty: number): { side: "sell" | "buy"; qty: number } {
  const target = roundDownToStep(spotEth);
  const current = Math.max(-perpQty, 0);
  const diff = roundDownToStep(Math.abs(target - current));
  if (diff < PERP_MIN_ORDER_ETH) return { side: "sell", qty: 0 };
  return { side: target > current ? "sell" : "buy", qty: diff };
}
