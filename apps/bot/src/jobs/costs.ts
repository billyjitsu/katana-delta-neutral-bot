import { projectScale, scaleTargets, summarizeCosts, walkBook, type ScaleRow } from "@kdn/core";
import { ADDRESSES, DECIMALS } from "@kdn/katana";
import { formatUnits, parseUnits } from "viem";
import type { Context } from "../context";
import { strategy } from "../env";

export const DEFAULT_SIZES = [300, 1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

/** The public RPC meters eth_call work; large quotes cross many ticks, so space them out. */
const QUOTE_SPACING_MS = 1_500;

/** Sub-dollar amounts get 4 decimals so test-size fees don't all read $0.00. */
function usd(n: number): string {
  const d = Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2;
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
const pct = (n: number | null, d = 3) => (n === null ? "—" : `${n.toFixed(d)}%`);

type ProjectionRow = ScaleRow | { capitalUsd: number; error: string };

async function printLedger(ctx: Context) {
  const [swaps, fills, entries] = await Promise.all([ctx.store.swaps(), ctx.store.fills(), ctx.store.costs()]);
  const c = summarizeCosts(swaps, fills, entries);
  console.log("Paid so far");
  console.log(`  Swap pool fees   ${usd(c.swapPoolFees).padStart(10)}`);
  console.log(`  Swap impact      ${usd(c.swapImpact).padStart(10)}   (execution vs perp price, minus pool fee)`);
  console.log(`  Perp fees        ${usd(c.perpFees).padStart(10)}`);
  console.log(`  Perp slippage    ${usd(c.perpSlippage).padStart(10)}   (fill vs index)`);
  console.log(`  Gas              ${usd(c.gas).padStart(10)}`);
  console.log(`  Withdrawal fees  ${usd(c.withdrawalFees).padStart(10)}`);
  console.log(`  Total            ${usd(c.total).padStart(10)}   = ${c.bps.toFixed(1)} bps of ${usd(c.tradedUsd)} traded`);
  if (entries.length) {
    console.log("  Ledger");
    for (const e of entries) console.log(`    ${new Date(e.time).toISOString().slice(0, 16)}  ${e.kind.padEnd(10)} ${usd(e.usd).padStart(8)}  ${e.label}`);
  }
}

/** Live round-trip cost at each capital size: Sushi quotes for spot, order book depth for the perp. */
async function projectSizes(ctx: Context, sizes: number[]): Promise<ProjectionRow[]> {
  const [market, book] = await Promise.all([ctx.perps.market(), ctx.perps.orderBook()]);
  const rows: ProjectionRow[] = [];
  for (const [i, target] of scaleTargets(sizes, strategy, market.indexPrice).entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, QUOTE_SPACING_MS));
    try {
      const usdcIn = parseUnits(target.spotUsd.toFixed(DECIMALS.vbUSDC), DECIMALS.vbUSDC);
      const ethOutRaw = await ctx.chain.quoteExactIn(ADDRESSES.vbUSDC, ADDRESSES.vbETH, usdcIn);
      const ethOut = Number(formatUnits(ethOutRaw, DECIMALS.vbETH));
      const usdcBackRaw = await ctx.chain.quoteExactIn(ADDRESSES.vbETH, ADDRESSES.vbUSDC, ethOutRaw);
      const usdcBack = Number(formatUnits(usdcBackRaw, DECIMALS.vbUSDC));

      const open = walkBook(book.bids, target.shortEth);
      const close = walkBook(book.asks, target.shortEth);
      rows.push(
        projectScale(
          {
            ...target,
            spotBuyPct: ethOut > 0 ? (target.spotUsd / ethOut / market.indexPrice - 1) * 100 : Infinity,
            spotSellPct: ethOut > 0 ? (1 - usdcBack / ethOut / market.indexPrice) * 100 : Infinity,
            perpOpenSlippagePct: open === null ? null : (1 - open / book.markPrice) * 100,
            perpCloseSlippagePct: close === null ? null : (close / book.markPrice - 1) * 100,
          },
          market.currentFundingRate,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split("\n")[0] ?? message;
      rows.push({ capitalUsd: target.capitalUsd, error: message.includes("Rate Limit") ? "RPC rate-limited (needs a keyed RPC)" : firstLine });
    }
  }
  return rows;
}

export async function costsReport(ctx: Context, sizes: number[]) {
  await printLedger(ctx);

  const { currentFundingRate, indexPrice } = await ctx.perps.market();
  console.log(`\nCost to enter and exit, by capital (${strategy.targetLeverage}x, ETH $${indexPrice.toFixed(2)}, funding ${(currentFundingRate * 100).toFixed(4)}%/8h)`);
  console.log("Spot from live Sushi quotes (one swap per leg, no chunking); perp from the live order book + 0.019% taker fee each way.\n");
  const header = ["Capital", "Spot", "Buy", "Sell", "Perp open", "Perp close", "Round trip", "bps", "Funding/day", "Breakeven", "APR 30d net"];
  const widths = [10, 12, 9, 9, 11, 11, 14, 8, 13, 12, 13];
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("");
  console.log(line(header));
  for (const r of await projectSizes(ctx, sizes)) {
    if ("error" in r) {
      console.log(`${usd(r.capitalUsd).padEnd(widths[0]!)}  quote failed: ${r.error}`);
      continue;
    }
    console.log(
      line([
        usd(r.capitalUsd),
        usd(r.spotUsd),
        pct(r.spotBuyPct),
        pct(r.spotSellPct),
        pct(r.perpOpenSlippagePct),
        pct(r.perpCloseSlippagePct),
        r.roundTripUsd === null ? "book too thin" : usd(r.roundTripUsd),
        r.roundTripBps === null ? "—" : r.roundTripBps.toFixed(1),
        usd(r.dailyFundingUsd),
        r.breakevenDays === null ? "—" : `${r.breakevenDays.toFixed(1)} d`,
        pct(r.aprAfterCostsPct, 2),
      ]),
    );
  }
  console.log("\nChunking spot into MAX_CHUNK_USD pieces over time lowers the Buy/Sell columns at large sizes.");
}
