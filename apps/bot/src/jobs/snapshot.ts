import { evaluateAlerts, type Alert, type Snapshot } from "@kdn/core";
import type { Context } from "../context";
import { thresholds } from "../env";
import { syncFills } from "./sync";

/** Perp size changes smaller than this are rounding, not ADL. */
const QTY_EPSILON = 0.0005;
const RECENT_RATES_MS = 3 * 86_400_000;

export async function takeSnapshot({ store, perps, chain, wallet }: Context): Promise<Snapshot> {
  const [account, market, balances, sushiPrice] = await Promise.all([
    perps.account(),
    perps.market(),
    chain.balances(wallet),
    chain.sushiMidPrice(),
  ]);
  const p = account.position;
  const snapshot: Snapshot = {
    time: Date.now(),
    indexPrice: market.indexPrice,
    markPrice: market.markPrice,
    sushiPrice,
    ...balances,
    perpQty: p?.qty ?? 0,
    perpEntryPrice: p?.entryPrice ?? 0,
    perpEquity: account.equity,
    perpLeverage: account.leverage,
    marginRatio: account.marginRatio,
    liquidationPrice: p?.liquidationPrice ?? 0,
    perpTotalFunding: p?.totalFunding ?? 0,
  };
  await store.saveSnapshot(snapshot);
  return snapshot;
}

/** Snapshot both legs and evaluate risk rules. */
export async function checkPosition(ctx: Context): Promise<{ snapshot: Snapshot; alerts: Alert[] }> {
  const previous = await ctx.store.latestSnapshot();
  await syncFills(ctx);
  const snapshot = await takeSnapshot(ctx);

  let unexplainedPositionChange = false;
  if (previous && Math.abs(snapshot.perpQty - previous.perpQty) > QTY_EPSILON) {
    const ourFills = await ctx.store.fills(previous.time);
    unexplainedPositionChange = ourFills.length === 0;
  }

  const rates = await ctx.store.fundingRates(Date.now() - RECENT_RATES_MS);
  const alerts = evaluateAlerts({
    current: snapshot,
    recentRates: rates.map((r) => r.rate).reverse(),
    unexplainedPositionChange,
    thresholds,
  });
  return { snapshot, alerts };
}
