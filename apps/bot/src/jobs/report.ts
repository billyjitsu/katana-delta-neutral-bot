import {
  PERP_TAKER_FEE,
  basisPct,
  buildReport,
  netDeltaEth,
  netDeltaPct,
  leverageTriggerPrice,
  rallyToLiquidationPct,
  type Report,
  type Snapshot,
  type Status,
} from "@kdn/core";
import type { Context } from "../context";
import { strategy, thresholds } from "../env";

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const ICON: Record<Status, string> = { pass: "✅", fail: "❌", pending: "⏳" };

/** USD lost if both legs were closed right now: spot sell impact vs index + perp taker fee. */
/** ETH prices at which leverage leaves the rebalance band, and how far away they are. */
export function rebalanceTriggers(s: Snapshot): { low: number; high: number; lowPct: number; highPct: number } | null {
  const short = Math.max(-s.perpQty, 0);
  const low = leverageTriggerPrice(short, s.perpEquity, s.markPrice, strategy.minLeverage);
  const high = leverageTriggerPrice(short, s.perpEquity, s.markPrice, strategy.maxLeverage);
  if (low === null || high === null) return null;
  return { low, high, lowPct: (low / s.markPrice - 1) * 100, highPct: (high / s.markPrice - 1) * 100 };
}

export function describeTriggers(s: Snapshot): string {
  const t = rebalanceTriggers(s);
  if (!t) return "— (no position)";
  const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
  return `if ETH ≤ ${usd(t.low)} (${pct(t.lowPct)}, ${strategy.minLeverage}x) or ≥ ${usd(t.high)} (${pct(t.highPct)}, ${strategy.maxLeverage}x)`;
}

async function exitCost({ chain, perps }: Context, s: Snapshot): Promise<number> {
  // Live index next to the live quote: the snapshot's price can be minutes old, and in a fast move
  // that gap shows up as a fake exit cost (or gain).
  const [received, market] = await Promise.all([chain.quoteSellEth(s.spotEth), perps.market()]);
  const spotCost = s.spotEth * market.indexPrice - received;
  const perpFee = Math.abs(s.perpQty) * market.markPrice * PERP_TAKER_FEE;
  return spotCost + perpFee;
}

export async function buildCurrentReport(ctx: Context): Promise<Report> {
  const { store } = ctx;
  const snapshots = await store.snapshots();
  const latest = snapshots.at(-1);
  return buildReport({
    now: Date.now(),
    snapshots,
    payments: await store.fundingPayments(),
    rates: await store.fundingRates(),
    fills: await store.fills(),
    swaps: await store.swaps(),
    capital: await store.capitalFlows(),
    costEntries: await store.costs(),
    exitCostUsd: latest ? await exitCost(ctx, latest) : 0,
    thresholds,
  });
}

export function formatReport(r: Report): string {
  const s = r.latest;
  if (!s) return "No snapshots yet. Run `npm run snapshot` first.";
  const rally = rallyToLiquidationPct(s);
  const lines = [
    `Delta-neutral pilot — ${new Date(s.time).toISOString()}  (day ${r.days.toFixed(1)})`,
    "",
    "Position",
    `  Spot        ${s.spotEth.toFixed(4)} vbETH   reserve ${usd(s.walletUsdc)}   gas ${s.gasEth.toFixed(5)} ETH`,
    `  Perp        ${s.perpQty.toFixed(4)} ETH @ ${usd(s.perpEntryPrice)}   equity ${usd(s.perpEquity)}   leverage ${s.perpLeverage.toFixed(2)}x`,
    `  Net delta   ${netDeltaEth(s).toFixed(4)} ETH (${Number.isFinite(netDeltaPct(s)) ? netDeltaPct(s).toFixed(2) + "%" : "unhedged"})`,
    `  Liquidation ${s.liquidationPrice > 0 ? usd(s.liquidationPrice) : "—"}${rally === null ? "" : ` (+${rally.toFixed(1)}%)`}`,
    `  Rebalance   ${describeTriggers(s)}`,
    `  Prices      index ${usd(s.indexPrice)}   mark ${usd(s.markPrice)}   sushi ${usd(s.sushiPrice)} (basis ${basisPct(s).toFixed(3)}%)`,
    "",
    "PnL",
    `  Capital in  ${usd(r.netCapital)}`,
    `  Equity      ${usd(r.equity)}`,
    `  PnL         ${usd(r.pnl)}   after exit cost ${usd(r.pnlAfterExit)}`,
    `  Funding     ${usd(r.funding.realized)} realized / ${usd(r.funding.expected)} expected over ${r.funding.settlements} settlements` +
      (r.netCapital > 0 ? `   → ${r.funding.aprOnCapital.toFixed(2)}% APR on capital` : ""),
    `  Costs       ${usd(r.costs.total)} total = ${r.costs.bps.toFixed(1)} bps of ${usd(r.costs.tradedUsd)} traded`,
    `              swap pool fees ${usd(r.costs.swapPoolFees)}   swap impact ${usd(r.costs.swapImpact)}   perp fees ${usd(r.costs.perpFees)}   perp slippage ${usd(r.costs.perpSlippage)}`,
    `              gas ${usd(r.costs.gas)}   withdrawal fees ${usd(r.costs.withdrawalFees)}   (trading-cost model ${usd(r.costs.modeled)}; run \`costs\` for scaling)`,
    "",
    "Hypotheses",
    ...r.hypotheses.map((h) => `  ${ICON[h.status]} ${h.id} ${h.title.padEnd(34)} ${h.detail}`),
  ];
  if (r.netCapital === 0) lines.push("", "Tip: record what you put in with `npm run bot -- capital <usd> [note]` so PnL is meaningful.");
  return lines.join("\n");
}
