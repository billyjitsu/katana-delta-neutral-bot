import { BTC_STEP, protectiveStopPrice, roundBtc, stopNeedsReplacing } from "@kdn/core";
import { logEvent } from "@kdn/bot/log";
import { protectiveStop } from "../env";
import type { TradingContext } from "../wallet";

/** BTC-USD prices move in whole dollars. */
const BTC_TICK = 1;

export interface StopState {
  triggerPrice: number;
  qty: number;
}

/**
 * Keeps one reduce-only stop on the exchange matching the short, STOP_BELOW_LIQ_PCT under the
 * liquidation price. Places the new stop before cancelling the old one, so the short is never uncovered.
 */
export async function maintainStop(t: TradingContext): Promise<StopState | null> {
  if (!protectiveStop.enabled) return null;
  const [account, stops] = await Promise.all([t.perps.account(), t.trader.openStops()]);
  const short = roundBtc(Math.max(-(account.position?.qty ?? 0), 0));
  const liquidation = account.position?.liquidationPrice ?? 0;

  if (short < BTC_STEP || liquidation <= 0) {
    if (stops.length) {
      await t.trader.cancelOrders(stops.map((s) => s.orderId));
      logEvent("order", { purpose: "stop-cancel", reason: "no short", orderIds: stops.map((s) => s.orderId) });
    }
    return null;
  }

  const trigger = protectiveStopPrice(liquidation, protectiveStop.belowLiqPct, BTC_TICK);
  const [keep, ...extra] = stops;
  if (keep && !extra.length && !stopNeedsReplacing(keep, short, trigger)) return { triggerPrice: keep.triggerPrice, qty: keep.qty };

  const orderId = await t.trader.placeStop(short, trigger);
  if (stops.length) await t.trader.cancelOrders(stops.map((s) => s.orderId));
  console.log(`  → protective stop: buy ${short.toFixed(4)} BTC if index ≥ $${trigger.toFixed(0)} (liquidation $${liquidation.toFixed(0)})`);
  logEvent("order", { purpose: "stop", orderId, qty: short, triggerPrice: trigger, liquidationPrice: liquidation, replaced: stops.map((s) => s.orderId) });
  return { triggerPrice: trigger, qty: short };
}
