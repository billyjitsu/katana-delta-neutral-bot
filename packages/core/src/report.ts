import {
  PERP_TAKER_FEE,
  basisPct,
  expectedFundingUsd,
  hasShort,
  modeledSwapCostPct,
  netDeltaPct,
  totalEquity,
} from "./metrics";
import { summarizeCosts, type CostBreakdown } from "./costs";
import type { CapitalFlow, CostEntry, FundingPayment, FundingRate, PerpFill, Snapshot, SwapRecord, Thresholds } from "./types";

const DAY = 86_400_000;
const PILOT_MIN_DAYS = 21;
const FUNDING_TOLERANCE = 0.05;
const COST_TOLERANCE = 0.25;
const MAX_REBALANCES_PER_WEEK = 1;
/** Swaps within this window of the first swap count as the initial entry, not rebalances. */
const ENTRY_WINDOW = DAY;

export type Status = "pass" | "fail" | "pending";

export interface Hypothesis {
  id: string;
  title: string;
  status: Status;
  detail: string;
}

export interface ReportInput {
  now: number;
  snapshots: Snapshot[]; // ascending by time
  payments: FundingPayment[];
  rates: FundingRate[];
  fills: PerpFill[];
  swaps: SwapRecord[];
  capital: CapitalFlow[];
  /** Gas on non-swap transactions and withdrawal fees. */
  costEntries: CostEntry[];
  /** USD it would cost right now to close both legs (spot sell impact + perp taker fee). */
  exitCostUsd: number;
  thresholds: Thresholds;
}

export interface Report {
  latest: Snapshot | undefined;
  days: number;
  netCapital: number;
  equity: number;
  pnl: number;
  pnlAfterExit: number;
  funding: { realized: number; expected: number; settlements: number; missed: number; aprOnCapital: number };
  costs: CostBreakdown & { modeled: number };
  rebalances: number;
  hypotheses: Hypothesis[];
}

function latestAtOrBefore(snapshots: Snapshot[], time: number): Snapshot | undefined {
  let found: Snapshot | undefined;
  for (const s of snapshots) {
    if (s.time > time) break;
    found = s;
  }
  return found;
}

export function buildReport(input: ReportInput): Report {
  const { now, snapshots, payments, rates, fills, swaps, capital, costEntries, exitCostUsd, thresholds } = input;
  const latest = snapshots.at(-1);
  const positioned = snapshots.filter(hasShort);
  const start = positioned[0]?.time ?? now;
  const days = Math.max((now - start) / DAY, 0);

  const netCapital = capital.reduce((sum, c) => sum + c.usd, 0);
  const equity = latest ? totalEquity(latest) : 0;
  const pnl = equity - netCapital;
  const pnlAfterExit = pnl - exitCostUsd;

  // H1: realized funding vs published rate x our position at each settlement.
  let expected = 0;
  let settlements = 0;
  let missed = 0;
  for (const r of rates) {
    if (r.time < start || r.time > now) continue;
    const s = latestAtOrBefore(snapshots, r.time);
    if (!s || !hasShort(s)) continue;
    settlements++;
    expected += expectedFundingUsd(s.perpQty, r.rate, r.indexPrice);
    if (!payments.some((p) => Math.abs(p.time - r.time) < 60_000)) missed++;
  }
  const realized = payments.filter((p) => p.time >= start).reduce((sum, p) => sum + p.paymentUsd, 0);
  const aprOnCapital = netCapital > 0 && days > 0 ? (realized / netCapital) * (365 / days) * 100 : 0;

  // H3: actual trading costs vs model (gas and withdrawal fees are reported but not modeled).
  const breakdown = summarizeCosts(swaps, fills, costEntries);
  const tradingCost = breakdown.swapPoolFees + breakdown.swapImpact + breakdown.perpFees + breakdown.perpSlippage;
  const modeled =
    swaps.reduce((sum, s) => sum + (s.ethAmount * s.refPrice * modeledSwapCostPct(s.ethAmount * s.refPrice)) / 100, 0) +
    fills.reduce((sum, f) => sum + f.quoteQty * PERP_TAKER_FEE, 0);

  // H4: spot swaps after the initial entry window.
  const firstSwap = swaps[0]?.time;
  const rebalances = firstSwap === undefined ? 0 : swaps.filter((s) => s.time > firstSwap + ENTRY_WINDOW).length;

  const hypotheses: Hypothesis[] = [];
  const pct = (n: number) => `${n.toFixed(2)}%`;

  if (settlements === 0) {
    hypotheses.push({ id: "H1", title: "Funding matches published rate", status: "pending", detail: "no settlements with an open short yet" });
  } else {
    const ratio = expected === 0 ? 0 : realized / expected;
    const ok = Math.abs(ratio - 1) <= FUNDING_TOLERANCE && missed === 0;
    hypotheses.push({
      id: "H1",
      title: "Funding matches published rate",
      status: ok ? "pass" : "fail",
      detail: `realized $${realized.toFixed(2)} vs expected $${expected.toFixed(2)} (${(ratio * 100).toFixed(1)}%), ${missed}/${settlements} settlements without a payment`,
    });
  }

  if (positioned.length === 0) {
    hypotheses.push({ id: "H2", title: "Hedge stays neutral", status: "pending", detail: "no position yet" });
  } else {
    const within = positioned.filter((s) => Math.abs(netDeltaPct(s)) < thresholds.alertDeltaPct).length;
    const share = within / positioned.length;
    const worst = Math.max(...positioned.map((s) => Math.abs(netDeltaPct(s))));
    hypotheses.push({
      id: "H2",
      title: "Hedge stays neutral",
      status: share >= 0.95 ? "pass" : "fail",
      detail: `${(share * 100).toFixed(1)}% of snapshots within ${thresholds.alertDeltaPct}%, worst ${pct(worst)}`,
    });
  }

  if (swaps.length === 0 && fills.length === 0) {
    hypotheses.push({ id: "H3", title: "Costs match the model", status: "pending", detail: "no trades yet" });
  } else {
    const ok = tradingCost <= modeled * (1 + COST_TOLERANCE);
    hypotheses.push({
      id: "H3",
      title: "Costs match the model",
      status: ok ? "pass" : "fail",
      detail: `trading costs $${tradingCost.toFixed(2)} vs modeled $${modeled.toFixed(2)} (+ gas $${breakdown.gas.toFixed(2)}, withdrawal fees $${breakdown.withdrawalFees.toFixed(2)})`,
    });
  }

  const weeks = days / 7;
  hypotheses.push({
    id: "H4",
    title: "Rebalances are rare",
    status: days < 7 ? "pending" : rebalances / weeks <= MAX_REBALANCES_PER_WEEK ? "pass" : "fail",
    detail: `${rebalances} spot rebalances over ${days.toFixed(1)} days`,
  });

  hypotheses.push({
    id: "H5",
    title: "Net PnL positive after exit cost",
    status: days < PILOT_MIN_DAYS ? "pending" : pnlAfterExit > 0 ? "pass" : "fail",
    detail: `PnL $${pnl.toFixed(2)}, after exit cost $${pnlAfterExit.toFixed(2)} (day ${days.toFixed(1)} of ${PILOT_MIN_DAYS})`,
  });

  const withSpot = snapshots.filter((s) => s.spotEth > 0 || hasShort(s));
  if (withSpot.length === 0) {
    hypotheses.push({ id: "H6", title: "vbETH / vbUSDC hold peg", status: "pending", detail: "no position yet" });
  } else {
    const worst = Math.max(...withSpot.map((s) => Math.abs(basisPct(s))));
    hypotheses.push({
      id: "H6",
      title: "vbETH / vbUSDC hold peg",
      status: worst <= thresholds.pegBasisPct ? "pass" : "fail",
      detail: `worst Sushi vs index basis ${pct(worst)}`,
    });
  }

  return {
    latest,
    days,
    netCapital,
    equity,
    pnl,
    pnlAfterExit,
    funding: { realized, expected, settlements, missed, aprOnCapital },
    costs: { ...breakdown, modeled },
    rebalances,
    hypotheses,
  };
}
