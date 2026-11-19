import { carryYield, expectedFundingUsd, fundingApr } from "@kdn/core";
import { carry, borrowCeiling } from "../env";
import type { Observation, Snapshot, WbtcStore } from "../store";

const DAY = 86_400_000;
const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const p = (n: number, d = 2) => `${(n * 100).toFixed(d)}%`;
const mark = (ok: boolean | null) => (ok === null ? "…" : ok ? "✅" : "❌");

/** Time-weighted mean of `value` over the samples, each holding until the next one. */
function timeWeighted<T extends { time: number }>(rows: T[], value: (r: T) => number, until = Date.now()): number {
  if (!rows.length) return NaN;
  let total = 0;
  let weight = 0;
  rows.forEach((r, i) => {
    const w = (rows[i + 1]?.time ?? until) - r.time;
    total += value(r) * w;
    weight += w;
  });
  return weight > 0 ? total / weight : value(rows[0]!);
}

function shareAbove(rows: Observation[], threshold: number): number {
  return timeWeighted(rows, (o) => (o.borrowApy >= threshold ? 1 : 0));
}

/** What the read-only tracker has seen: the rates and depth the pilot would have run on. */
export function trackerReport(store: WbtcStore, since = 0): string {
  const obs = store.observations(since);
  if (!obs.length) return "Tracker: no observations yet (run `track` or `watch`).";
  const days = (Date.now() - obs[0]!.time) / DAY;
  const borrow = timeWeighted(obs, (o) => o.borrowApy);
  const rates = store.fundingRates(obs[0]!.time);
  const funding = rates.length ? rates.reduce((s, r) => s + r.rate, 0) / rates.length : timeWeighted(obs, (o) => o.fundingRate);
  const model = carryYield(carry.targetLtv, carry.targetPerpLeverage, fundingApr(funding), borrow);
  const worst = (f: (o: Observation) => number) => obs.reduce((m, o) => Math.max(m, Math.abs(f(o))), 0);
  const last = obs.at(-1)!;
  return [
    `Tracker: ${obs.length} readings over ${days.toFixed(1)} days (since ${new Date(obs[0]!.time).toISOString().slice(0, 16)}Z)`,
    `  Borrow APY   avg ${p(borrow)}  max ${p(Math.max(...obs.map((o) => o.borrowApy)))}  now ${p(last.borrowApy)}  ` +
      `time ≥4% ${p(shareAbove(obs, 0.04), 0)}, ≥7% ${p(shareAbove(obs, carry.shrinkBorrowApy), 0)}, ≥10% ${p(shareAbove(obs, carry.unwindBorrowApy), 0)}`,
    `  Funding      avg ${(funding * 100).toFixed(4)}%/8h (${p(fundingApr(funding), 1)} APR) ${rates.length ? `over ${rates.length} settlements` : "(current rate, no settlement yet)"}`,
    `  Morpho       utilization max ${p(Math.max(...obs.map((o) => o.utilization)), 1)}, free liquidity min $${(Math.min(...obs.map((o) => o.availableUsd)) / 1000).toFixed(0)}k`,
    `  Sushi        $${last.sliceUsd.toFixed(0)} slice buy cost avg ${(obs.reduce((s, o) => s + o.sliceBuyCostPct, 0) / obs.length).toFixed(2)}%, max ${Math.max(...obs.map((o) => o.sliceBuyCostPct)).toFixed(2)}%`,
    `  Peg          worst Sushi vs index ${worst((o) => (o.sushiPrice / o.indexPrice - 1) * 100).toFixed(2)}%, oracle vs index ${worst((o) => (o.oraclePrice / o.indexPrice - 1) * 100).toFixed(2)}%`,
    `  Model        ${p(model.netYield)} more BTC a year at these averages (break-even borrow ${p(model.breakEvenBorrowApy, 1)})`,
  ].join("\n");
}

interface Hypothesis {
  id: string;
  text: string;
  ok: boolean | null;
  detail: string;
}

/** The pilot's position, PnL in BTC, and H1–H7. */
export function positionReport(store: WbtcStore): string {
  const flows = store.btcFlows();
  const snaps = store.snapshots();
  const latest: Snapshot | undefined = snaps.at(-1);
  if (!flows.length || !latest) return "Position: nothing deposited yet (`deposit <btc> --go`).";

  const start = flows[0]!.time;
  const days = (Date.now() - start) / DAY;
  const { holdings: h, metrics: m } = latest;
  const payments = store.fundingPayments().filter((x) => x.time >= start);
  const funding = payments.reduce((s, x) => s + x.paymentUsd, 0);
  const expected = payments.reduce((s, x) => s + expectedFundingUsd(x.positionQty, x.rate, x.indexPrice), 0);
  const interest = Math.max(h.debtUsd - store.principal(), 0);
  const costs = store.costs().filter((c) => c.time >= start);
  const gas = costs.filter((c) => c.kind === "gas").reduce((s, c) => s + c.usd, 0);
  const withdrawalFees = costs.filter((c) => c.kind === "withdrawal").reduce((s, c) => s + c.usd, 0);
  const perpFees = store.fills(start).reduce((s, f) => s + f.feeUsd, 0);
  const swapCost = store
    .swaps()
    .filter((s) => s.time >= start)
    .reduce((sum, s) => sum + (s.direction === "buy" ? s.usdc - s.btc * s.refPrice : s.btc * s.refPrice - s.usdc), 0);

  // Hypotheses.
  const obs = store.observations(start);
  const active = snaps.filter((s) => s.time >= start && s.metrics.shortBtc > 0);
  const rates = store.fundingRates(active[0]?.time ?? Date.now());
  const missed = Math.max(rates.length - payments.length, 0);
  const borrowAvg = timeWeighted(obs, (o) => o.borrowApy);
  const worstDrift = active.reduce((w, s) => Math.max(w, Math.abs(s.metrics.netBtcDriftPct)), 0);
  const rebalances = store.rebalances(start).slice(1);
  const weeks = Math.max(days / 7, 1);
  const rebalanceCost = rebalances.length ? (gas + withdrawalFees) / (rebalances.length + 1) : 0;
  const carryUsd = funding - interest;
  const fundingAvg = rates.length ? rates.reduce((s, r) => s + r.rate, 0) / rates.length : h.fundingRate;
  const modelUsd = carryYield(carry.targetLtv, carry.targetPerpLeverage, fundingApr(fundingAvg), borrowAvg).netYield * h.depositBtc * h.indexPrice * (days / 365);
  const worstBasis = obs.reduce((w, o) => Math.max(w, Math.abs(o.sushiPrice / o.indexPrice - 1), Math.abs(o.oraclePrice / o.indexPrice - 1)), 0) * 100;
  const withdrawals = store.withdrawals();
  const latencies = withdrawals.filter((w) => w.arrivedAt !== null).map((w) => (w.arrivedAt! - w.requestedAt) / 60_000);
  const pending = withdrawals.filter((w) => w.arrivedAt === null && Date.now() - w.requestedAt > 10 * 60_000).length;

  const hs: Hypothesis[] = [
    {
      id: "H1",
      text: "Funding matches the published rate",
      ok: payments.length ? funding >= expected * 0.95 && missed === 0 : null,
      detail: payments.length ? `${usd(funding)} of ${usd(expected)} expected (${p(funding / expected, 0)}), ${payments.length} paid, ${missed} missed` : "no payments yet",
    },
    {
      id: "H2",
      text: `Borrow cost stays under ${p(borrowCeiling, 0)}`,
      ok: obs.length ? borrowAvg <= borrowCeiling : null,
      detail: obs.length ? `time-weighted ${p(borrowAvg)} since the deposit` : "no readings yet",
    },
    {
      id: "H3",
      text: "Net BTC stays equal to the deposit",
      ok: active.length ? worstDrift <= 1 : null,
      detail: active.length ? `worst drift ${worstDrift.toFixed(2)}% over ${active.length} snapshots` : "no hedged snapshots yet",
    },
    {
      id: "H4",
      text: "Rebalances are rare and cheap",
      ok: days >= 7 ? rebalances.length / weeks <= 1 && rebalanceCost < 0.1 : null,
      detail: `${rebalances.length} after entry (${(rebalances.length / weeks).toFixed(1)}/week), gas + withdrawal fees ${usd(rebalanceCost)} each`,
    },
    {
      id: "H5",
      text: "BTC gain is on track to beat its costs",
      ok: days >= 3 && modelUsd > 0 ? Math.abs(carryUsd / modelUsd - 1) <= 0.2 : null,
      detail: `carry ${usd(carryUsd)} vs model ${usd(modelUsd)}; costs so far ${usd(gas + withdrawalFees + perpFees + swapCost)}`,
    },
    {
      id: "H6",
      text: "vbWBTC holds its peg",
      ok: obs.length ? worstBasis < 0.5 : null,
      detail: `worst Sushi or oracle vs index ${worstBasis.toFixed(2)}%`,
    },
    {
      id: "H7",
      text: "Perp withdrawals are fast enough for the ladder",
      ok: withdrawals.length ? pending === 0 && latencies.every((l) => l <= 10) && withdrawals.every((w) => w.feeUsd <= 1) : null,
      detail: withdrawals.length
        ? `${latencies.length} landed, slowest ${latencies.length ? Math.max(...latencies).toFixed(1) : "—"} min, ${pending} overdue, max fee ${usd(Math.max(...withdrawals.map((w) => w.feeUsd)))}`
        : "no withdrawals yet",
    },
  ];

  return [
    `Position (day ${days.toFixed(1)}, snapshot ${new Date(latest.time).toISOString().slice(0, 16)}Z)`,
    `  Deposit     ${h.depositBtc.toFixed(6)} BTC   equity ${m.equityBtc.toFixed(6)} BTC   profit ${m.profitBtc >= 0 ? "+" : ""}${m.profitBtc.toFixed(6)} BTC (${usd(m.profitUsd)})`,
    `  Legs        collateral ${h.collateralBtc.toFixed(6)}, slice ${m.sliceBtc.toFixed(6)}, short ${m.shortBtc.toFixed(4)} BTC, net ${m.netBtc.toFixed(6)} (${m.netBtcDriftPct.toFixed(2)}%)`,
    `  Morpho      debt ${usd(h.debtUsd)}, LTV ${m.ltv === null ? "—" : p(m.ltv, 1)}, liquidation after a ${m.dropToMorphoLiquidationPct?.toFixed(1) ?? "—"}% drop, borrow ${p(h.borrowApy)}`,
    `  Perp        margin ${usd(h.perpEquity)}, ${m.perpLeverage?.toFixed(2) ?? "—"}x, liquidation after a +${m.rallyToPerpLiquidationPct?.toFixed(1) ?? "—"}% rally`,
    `  Carry       funding ${usd(funding)} − interest ${usd(interest)} = ${usd(carryUsd)}; live ${m.liveYieldPct?.toFixed(2) ?? "—"}% a year in BTC`,
    `  Costs       swaps ${usd(swapCost)}, perp fees ${usd(perpFees)}, gas ${usd(gas)}, withdrawal fees ${usd(withdrawalFees)}`,
    "Hypotheses",
    ...hs.map((x) => `  ${mark(x.ok)} ${x.id} ${x.text}: ${x.detail}`),
  ].join("\n");
}
