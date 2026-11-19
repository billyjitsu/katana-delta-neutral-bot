import { PERP_STEP_ETH, protectiveStopPrice, roundDownToStep, stopNeedsReplacing } from "@kdn/core";
import { protectiveStop } from "../env";
import { logEvent } from "../log";
import type { TradingContext } from "../wallet";

export interface StopState {
  triggerPrice: number;
  qty: number;
}

/**
 * Keeps exactly one reduce-only stop on the exchange matching the short. Places the new stop
 * before cancelling the old one, so the short is never left uncovered. Returns the stop in force.
 */
export async function maintainStop(t: TradingContext): Promise<StopState | null> {
  if (!protectiveStop.enabled) return null;
  const [account, stops] = await Promise.all([t.perps.account(), t.trader.openStops()]);
  const short = roundDownToStep(Math.max(-(account.position?.qty ?? 0), 0));
  const liquidation = account.position?.liquidationPrice ?? 0;

  if (short < PERP_STEP_ETH || liquidation <= 0) {
    if (stops.length) {
      await t.trader.cancelOrders(stops.map((s) => s.orderId));
      logEvent("order", { purpose: "stop-cancel", reason: "no short", orderIds: stops.map((s) => s.orderId) });
    }
    return null;
  }

  const trigger = protectiveStopPrice(liquidation, protectiveStop.belowLiqPct);
  const [keep, ...extra] = stops;
  if (keep && !extra.length && !stopNeedsReplacing(keep, short, trigger)) return { triggerPrice: keep.triggerPrice, qty: keep.qty };

  const orderId = await t.trader.placeStop(short, trigger);
  if (stops.length) await t.trader.cancelOrders(stops.map((s) => s.orderId));
  console.log(`  → protective stop: buy ${short.toFixed(3)} ETH if index ≥ $${trigger.toFixed(1)} (liquidation $${liquidation.toFixed(2)})`);
  logEvent("order", { purpose: "stop", orderId, qty: short, triggerPrice: trigger, liquidationPrice: liquidation, replaced: stops.map((s) => s.orderId) });
  return { triggerPrice: trigger, qty: short };
}
