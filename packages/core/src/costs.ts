import { PERP_TAKER_FEE, swapCostUsd } from "./metrics";
import { computeTarget, type StrategySettings } from "./strategy";
import type { CostEntry, PerpFill, SwapRecord } from "./types";

/** [price, quantity] levels, best first. */
export type BookSide = ReadonlyArray<readonly [price: number, qty: number]>;

/** Average fill price for taking `qty` from one side of the book, or null if the book is too thin. */
export function walkBook(levels: BookSide, qty: number): number | null {
  let remaining = qty;
  let cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(size, remaining);
    cost += take * price;
    remaining -= take;
    if (remaining <= 1e-12) return cost / qty;
  }
  return null;
}

export interface CostBreakdown {
  swapPoolFees: number;
  swapImpact: number;
  perpFees: number;
  perpSlippage: number;
  gas: number;
  withdrawalFees: number;
  total: number;
  /** Notional traded across both legs, in USD. */
  tradedUsd: number;
  /** Total cost per notional traded, in basis points. */
  bps: number;
}

/** Everything the strategy has paid so far, split by where it went. */
export function summarizeCosts(swaps: SwapRecord[], fills: PerpFill[], entries: CostEntry[]): CostBreakdown {
  let swapPoolFees = 0;
  let swapImpact = 0;
  for (const s of swaps) {
    const notional = s.ethAmount * s.refPrice;
    const fee = s.poolFeePct == null ? 0 : (notional * s.poolFeePct) / 100;
    swapPoolFees += fee;
    swapImpact += swapCostUsd(s) - fee;
  }

  let perpFees = 0;
  let perpSlippage = 0;
  for (const f of fills) {
    perpFees += f.feeUsd;
    // Paid vs the index at fill time: selling below it or buying above it costs us.
    if (f.indexPrice) perpSlippage += (f.side === "sell" ? f.indexPrice - f.price : f.price - f.indexPrice) * f.qty;
  }

  // Swap gas is on the swap record; other txs are cost entries. Count each tx hash once.
  const entryHashes = new Set(entries.map((e) => e.txHash).filter(Boolean));
  const swapGas = swaps.filter((s) => !entryHashes.has(s.txHash)).reduce((sum, s) => sum + s.gasEth * s.refPrice, 0);
  const gas = swapGas + entries.filter((e) => e.kind === "gas").reduce((sum, e) => sum + e.usd, 0);
  const withdrawalFees = entries.filter((e) => e.kind === "withdrawal").reduce((sum, e) => sum + e.usd, 0);

  const tradedUsd = swaps.reduce((sum, s) => sum + s.ethAmount * s.refPrice, 0) + fills.reduce((sum, f) => sum + f.quoteQty, 0);
  const total = swapPoolFees + swapImpact + perpFees + perpSlippage + gas + withdrawalFees;
  return { swapPoolFees, swapImpact, perpFees, perpSlippage, gas, withdrawalFees, total, tradedUsd, bps: tradedUsd > 0 ? (total / tradedUsd) * 10_000 : 0 };
}

export interface ScaleQuote {
  capitalUsd: number;
  spotUsd: number;
  shortEth: number;
  /** USDC -> ETH cost vs index, in % (from a live quote for spotUsd). */
  spotBuyPct: number;
  /** ETH -> USDC cost vs index, in % (from a live quote for the bought ETH). */
  spotSellPct: number;
  /** Selling `shortEth` into the bids vs mark, in %; null if the book can't fill it. */
  perpOpenSlippagePct: number | null;
  /** Buying `shortEth` from the asks vs mark, in %. */
  perpCloseSlippagePct: number | null;
}

export interface ScaleRow extends ScaleQuote {
  roundTripUsd: number | null;
  roundTripBps: number | null; // of spot notional
  dailyFundingUsd: number;
  breakevenDays: number | null;
  aprAfterCostsPct: number | null; // on capital, holding 30 days then exiting
}

/** Inputs for a projection: the sizes to test and the strategy split to apply at each. */
export function scaleTargets(sizesUsd: number[], s: StrategySettings, indexPrice: number) {
  return sizesUsd.map((capitalUsd) => {
    const t = computeTarget(
      { walletUsdc: capitalUsd, spotEth: 0, perpEquity: 0, perpQty: 0, markPrice: indexPrice, indexPrice, fundingRate: 0 },
      s,
    );
    return { capitalUsd, spotUsd: t.spotUsd, shortEth: t.shortEth };
  });
}

const HOLD_DAYS = 30;

/** Round-trip cost and payback at each size, from live quotes and the live order book. */
export function projectScale(q: ScaleQuote, fundingRate: number): ScaleRow {
  const perpFeePct = PERP_TAKER_FEE * 100;
  const dailyFundingUsd = q.spotUsd * fundingRate * 3;
  if (q.perpOpenSlippagePct === null || q.perpCloseSlippagePct === null) {
    return { ...q, roundTripUsd: null, roundTripBps: null, dailyFundingUsd, breakevenDays: null, aprAfterCostsPct: null };
  }
  const pct = q.spotBuyPct + q.spotSellPct + 2 * perpFeePct + q.perpOpenSlippagePct + q.perpCloseSlippagePct;
  const roundTripUsd = (q.spotUsd * pct) / 100;
  const net30 = dailyFundingUsd * HOLD_DAYS - roundTripUsd;
  return {
    ...q,
    roundTripUsd,
    roundTripBps: pct * 100,
    dailyFundingUsd,
    breakevenDays: dailyFundingUsd > 0 ? roundTripUsd / dailyFundingUsd : null,
    aprAfterCostsPct: (net30 / q.capitalUsd) * (365 / HOLD_DAYS) * 100,
  };
}
