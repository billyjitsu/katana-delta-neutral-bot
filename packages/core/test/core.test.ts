import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THRESHOLDS,
  averageFunding,
  basisPct,
  buildReport,
  consecutiveNegative,
  evaluateAlerts,
  evaluateFastRisk,
  protectiveStopPrice,
  stopNeedsReplacing,
  expectedFundingUsd,
  leverageTriggerPrice,
  liquidationRallyForLeverage,
  modeledSwapCostPct,
  netDeltaPct,
  computeTarget,
  holdingsMoved,
  planRebalance,
  PERP_MIN_ORDER_ETH,
  roundDownToStep,
  shortAdjustment,
  swapCostUsd,
  totalEquity,
  type Holdings,
  type Snapshot,
  type StrategySettings,
} from "../src/index";

const HOUR = 3_600_000;

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    time: 0,
    indexPrice: 2500,
    markPrice: 2500,
    sushiPrice: 2500,
    spotEth: 1,
    walletUsdc: 100,
    gasEth: 0.01,
    perpQty: -1,
    perpEntryPrice: 2500,
    perpEquity: 1250,
    perpLeverage: 2,
    marginRatio: 0.1,
    liquidationPrice: 3700,
    perpTotalFunding: 0,
    ...overrides,
  };
}

test("short receives funding when the rate is positive", () => {
  assert.equal(expectedFundingUsd(-2, 0.0001, 2500), 0.5);
  assert.equal(expectedFundingUsd(2, 0.0001, 2500), -0.5);
});

test("liquidation rally matches live margin params", () => {
  assert.ok(Math.abs(liquidationRallyForLeverage(2, 0.01) - 0.485) < 0.001);
  assert.ok(Math.abs(liquidationRallyForLeverage(3, 0.01) - 0.32) < 0.001);
});

test("net delta, basis and equity", () => {
  assert.ok(Math.abs(netDeltaPct(snap({ spotEth: 1.02 })) - 2) < 1e-9);
  assert.equal(netDeltaPct(snap({ perpQty: 0, spotEth: 0 })), 0);
  assert.ok(Math.abs(basisPct(snap({ sushiPrice: 2512.5 })) - 0.5) < 1e-9);
  assert.equal(totalEquity(snap()), 2500 + 100 + 1250);
});

test("swap cost model interpolates measured points", () => {
  assert.equal(modeledSwapCostPct(100), 0.1);
  assert.ok(Math.abs(modeledSwapCostPct(550) - 0.145) < 1e-9);
  assert.equal(modeledSwapCostPct(6_400), 0.7);
});

test("swap cost is positive when execution is worse than reference", () => {
  const base = { txHash: "0x", time: 0, ethAmount: 1, refPrice: 2500, gasEth: 0 };
  assert.equal(swapCostUsd({ ...base, direction: "buy", usdcAmount: 2510 }), 10);
  assert.equal(swapCostUsd({ ...base, direction: "sell", usdcAmount: 2490 }), 10);
});

test("alerts escalate to kill", () => {
  const input = { recentRates: [], unexplainedPositionChange: false, thresholds: DEFAULT_THRESHOLDS };
  assert.deepEqual(evaluateAlerts({ ...input, current: snap() }), []);

  const codes = (s: Snapshot, extra = {}) => evaluateAlerts({ ...input, ...extra, current: s }).map((a) => a.code);
  assert.deepEqual(codes(snap({ perpLeverage: 3.2 })), ["LEVERAGE_HIGH"]);
  assert.deepEqual(codes(snap({ perpLeverage: 4.1 })), ["LEVERAGE_KILL"]);
  assert.deepEqual(codes(snap({ sushiPrice: 2530 })), ["BASIS_KILL"]);
  assert.deepEqual(codes(snap({ spotEth: 0.97 })), ["DELTA_DRIFT"]);
  assert.deepEqual(codes(snap(), { recentRates: [-0.0001, -0.0001, -0.0001, 0.0001] }), ["FUNDING_KILL"]);
  assert.deepEqual(codes(snap(), { unexplainedPositionChange: true }), ["POSITION_CHANGED"]);
  assert.equal(consecutiveNegative([-1, -1, 1, -1]), 2);
});

test("report checks funding against published rates", () => {
  const snapshots = [snap({ time: 0 }), snap({ time: 8 * HOUR }), snap({ time: 16 * HOUR })];
  const rates = [8, 16].map((h) => ({ time: h * HOUR, rate: 0.0001, indexPrice: 2500 }));
  const payments = rates.map((r) => ({ time: r.time, market: "ETH-USD", paymentUsd: 0.25, positionQty: -1, rate: r.rate, indexPrice: 2500 }));

  const report = buildReport({
    now: 16 * HOUR,
    snapshots,
    payments,
    rates,
    fills: [],
    swaps: [],
    capital: [{ time: 0, usd: 3850, note: "initial" }],
    costEntries: [],
    exitCostUsd: 20,
    thresholds: DEFAULT_THRESHOLDS,
  });

  const h1 = report.hypotheses.find((h) => h.id === "H1")!;
  assert.equal(h1.status, "pass");
  assert.equal(report.funding.expected, 0.5);
  assert.equal(report.funding.realized, 0.5);
  assert.equal(report.pnl, 0);
  assert.equal(report.pnlAfterExit, -20);
  assert.equal(report.hypotheses.find((h) => h.id === "H5")!.status, "pending");

  const missing = buildReport({ ...{ now: 16 * HOUR, snapshots, rates, fills: [], swaps: [], capital: [], costEntries: [], exitCostUsd: 0, thresholds: DEFAULT_THRESHOLDS }, payments: payments.slice(0, 1) });
  assert.equal(missing.hypotheses.find((h) => h.id === "H1")!.status, "fail");
  assert.equal(missing.funding.missed, 1);
});

const SETTINGS: StrategySettings = {
  targetLeverage: 2,
  minLeverage: 1.5,
  maxLeverage: 2.5,
  reservePct: 5,
  rebalanceBandPct: 10,
  deltaBandPct: 2,
  minTradeUsd: 5,
  maxNegativeFundingPeriods: 3,
  avgFundingPeriods: 6,
  minGrowFundingRate: 0.00005,
  allowWithdraw: false,
};

function holdings(overrides: Partial<Holdings> = {}): Holdings {
  return { walletUsdc: 300, spotEth: 0, perpEquity: 0, perpQty: 0, markPrice: 2500, indexPrice: 2500, fundingRate: 0.0001, ...overrides };
}

const kinds = (p: { steps: { kind: string }[] }) => p.steps.map((s) => s.kind);

test("target splits capital into reserve, fees, margin and spot at target leverage", () => {
  const t = computeTarget(holdings(), SETTINGS);
  assert.equal(t.capitalUsd, 300);
  assert.equal(t.reserveUsd, 15);
  assert.ok(t.feeBudgetUsd > 0 && t.feeBudgetUsd < 1);
  assert.ok(Math.abs(t.reserveUsd + t.feeBudgetUsd + t.marginUsd + t.spotUsd - 300) < 1e-9);
  assert.ok(Math.abs(t.spotUsd / t.marginUsd - 2) < 1e-9);
  assert.equal(t.shortEth, roundDownToStep(t.spotEth));
  assert.ok(t.breakevenDays! > 0);
});

test("fresh capital: deposit margin, then grow and hedge", () => {
  const p = planRebalance(holdings(), SETTINGS, 0);
  assert.deepEqual(kinds(p), ["marginTo", "growTo", "hedge"]);
});

test("position on target does nothing", () => {
  const t = computeTarget(holdings(), SETTINGS);
  const h = holdings({ walletUsdc: t.reserveUsd + t.feeBudgetUsd, spotEth: t.spotEth, perpEquity: t.marginUsd, perpQty: -t.shortEth });
  assert.deepEqual(kinds(planRebalance(h, SETTINGS, 0)), []);
});

test("ETH rally: margin from reserve first, then shrink, then finish margin", () => {
  // 0.076 ETH long + short opened at $2500 with ~$95 margin; ETH now $3200.
  const h = holdings({ walletUsdc: 15, spotEth: 0.076, perpQty: -0.076, perpEquity: 95 - 0.076 * 700, markPrice: 3200, indexPrice: 3200 });
  const p = planRebalance(h, SETTINGS, 0);
  assert.ok(p.leverage! > SETTINGS.maxLeverage);
  assert.deepEqual(kinds(p), ["marginTo", "shrinkTo", "marginTo", "hedge"]);
});

test("ETH drop: extra margin stays put when withdraw is disabled", () => {
  const h = holdings({ walletUsdc: 15, spotEth: 0.076, perpQty: -0.076, perpEquity: 95 + 0.076 * 800, markPrice: 1700, indexPrice: 1700 });
  const p = planRebalance(h, SETTINGS, 0);
  assert.ok(p.leverage! < SETTINGS.minLeverage);
  assert.ok(!kinds(p).includes("withdrawTo"));
  assert.ok(p.notes.some((n) => n.includes("withdraw disabled")));
  assert.ok(kinds({ steps: planRebalance(h, { ...SETTINGS, allowWithdraw: true }, 0).steps }).includes("withdrawTo"));
});

test("leg drift only resizes the short", () => {
  const t = computeTarget(holdings(), SETTINGS);
  const h = holdings({ walletUsdc: t.reserveUsd + t.feeBudgetUsd, spotEth: t.spotEth, perpEquity: t.marginUsd, perpQty: -(t.shortEth - 0.012) });
  assert.deepEqual(kinds(planRebalance(h, SETTINGS, 0)), ["hedge"]);
});

test("leg gap under one perp order moves spot instead of the short", () => {
  // Live 2026-10-30: grew spot by 0.0097 ETH, too small for the 0.01 ETH minimum order.
  const h = holdings({ walletUsdc: 15.46, spotEth: 0.0857, perpQty: -0.076, perpEquity: 95.19, markPrice: 2205, indexPrice: 2205 });
  const p = planRebalance(h, SETTINGS, 0);
  assert.deepEqual(kinds(p), ["alignSpot", "hedge"]);
  const align = p.steps[0] as { eth: number; keepUsd: number };
  assert.ok(roundDownToStep(align.eth) - 0.076 >= PERP_MIN_ORDER_ETH - 1e-9);
  assert.ok((align.eth - h.spotEth) * h.indexPrice < 2);
  assert.ok(h.walletUsdc - align.keepUsd > 2);

  // Over-hedged by less than an order: buy spot up to the short.
  const under = planRebalance(holdings({ walletUsdc: 15, spotEth: 0.0815, perpQty: -0.086, perpEquity: 95 }), SETTINGS, 0);
  assert.deepEqual(kinds(under), ["alignSpot", "hedge"]);
  assert.ok(Math.abs(roundDownToStep((under.steps[0] as { eth: number }).eth) - 0.086) < 1e-9);

  // Leftover spot with no short (e.g. after an exit) is not re-hedged.
  assert.ok(!kinds(planRebalance(holdings({ walletUsdc: 300, spotEth: 0.005 }), SETTINGS, 0)).includes("alignSpot"));
});

test("growing buys at least one perp order beyond the short", () => {
  // Leverage drifted low with spot ~$20 under target: the grow must leave room for a 0.01 short.
  const h = holdings({ walletUsdc: 36, spotEth: 0.0765, perpQty: -0.076, perpEquity: 95, markPrice: 2205, indexPrice: 2205 });
  const p = planRebalance(h, SETTINGS, 0);
  const grow = p.steps.find((s) => s.kind === "growTo") as { eth: number } | undefined;
  assert.ok(grow);
  assert.ok(roundDownToStep(grow.eth) - 0.076 >= PERP_MIN_ORDER_ETH - 1e-9);
});

test("negative funding streak unwinds", () => {
  const h = holdings({ walletUsdc: 15, spotEth: 0.076, perpQty: -0.076, perpEquity: 95 });
  assert.deepEqual(kinds(planRebalance(h, SETTINGS, 3)), ["unwind"]);
  assert.notDeepEqual(kinds(planRebalance(h, SETTINGS, 2)), ["unwind"]);
});

test("short adjustment respects step and minimum order", () => {
  assert.deepEqual(shortAdjustment(0.2537, 0), { side: "sell", qty: 0.253 });
  assert.deepEqual(shortAdjustment(0.2537, -0.25), { side: "sell", qty: 0 });
  assert.deepEqual(shortAdjustment(0.2, -0.25), { side: "buy", qty: 0.05 });
  assert.equal(roundDownToStep(0.03), 0.03); // 0.03 / 0.001 is 29.999… in floating point
  assert.equal(roundDownToStep(0.0299999), 0.029);
});

test("fast risk flags leverage above band and close liquidation", () => {
  const base = { shortEth: 0.076, perpEquity: 95, markPrice: 2500, liquidationPrice: 3700 };
  const calm = evaluateFastRisk(base, 2.5, DEFAULT_THRESHOLDS);
  assert.ok(Math.abs(calm.leverage! - 2) < 0.01);
  assert.equal(calm.urgent, false);
  assert.deepEqual(calm.alerts, []);

  const rallied = evaluateFastRisk({ ...base, perpEquity: 60, markPrice: 2950 }, 2.5, DEFAULT_THRESHOLDS);
  assert.ok(rallied.leverage! > 3.7);
  assert.equal(rallied.urgent, true);
  assert.deepEqual(rallied.alerts.map((a) => a.code), ["LEVERAGE_HIGH"]);

  const nearLiq = evaluateFastRisk({ ...base, perpEquity: 40, markPrice: 3300 }, 2.5, DEFAULT_THRESHOLDS);
  assert.deepEqual(nearLiq.alerts.map((a) => a.code), ["LEVERAGE_KILL", "LIQ_CLOSE"]);

  assert.equal(evaluateFastRisk({ ...base, shortEth: 0 }, 2.5, DEFAULT_THRESHOLDS).urgent, false);
});

test("protective stop sits below liquidation and is only replaced when it drifts", () => {
  assert.equal(protectiveStopPrice(3700, 15), 3145);
  assert.equal(stopNeedsReplacing({ qty: 0.076, triggerPrice: 3145 }, 0.076, 3150), false);
  assert.equal(stopNeedsReplacing({ qty: 0.076, triggerPrice: 3145 }, 0.08, 3145), true);
  assert.equal(stopNeedsReplacing({ qty: 0.076, triggerPrice: 3000 }, 0.076, 3145), true);
});

test("leverage trigger prices bracket the current price", () => {
  // Live numbers from 2026-10-24: short 0.076 ETH, equity $107.26, mark $2,312.40, leverage 1.64x.
  const low = leverageTriggerPrice(0.076, 107.26, 2312.4, 1.5)!;
  const high = leverageTriggerPrice(0.076, 107.26, 2312.4, 2.5)!;
  assert.ok(Math.abs(low - 2234) < 1);
  assert.ok(Math.abs(high - 2659) < 1);
  // At the trigger price the leverage equals the target.
  const equityAt = (p: number) => 107.26 + 0.076 * (2312.4 - p);
  assert.ok(Math.abs((0.076 * high) / equityAt(high) - 2.5) < 1e-9);
  assert.equal(leverageTriggerPrice(0, 100, 2500, 2), null);
});

test("legs far apart escalate from warn to urgent", () => {
  const input = { recentRates: [0.0001], unexplainedPositionChange: false, thresholds: DEFAULT_THRESHOLDS };
  const level = (spotEth: number) => evaluateAlerts({ ...input, current: snap({ spotEth }) }).find((a) => a.code.startsWith("DELTA_DRIFT"))?.level;
  assert.equal(level(1.03), "warn");
  assert.equal(level(1.128), "urgent"); // the 2026-10-30 gap
});

test("alternating negative funding unwinds on the rolling average", () => {
  const bleed = [-0.0002, 0.0001, -0.0002, 0.0001, -0.0002, 0.0001]; // newest first, never 3 in a row
  assert.equal(consecutiveNegative(bleed), 1);
  assert.ok(averageFunding(bleed, 6)! < 0);
  assert.equal(averageFunding(bleed.slice(0, 5), 6), null);

  const h = holdings({ walletUsdc: 15, spotEth: 0.076, perpQty: -0.076, perpEquity: 95 });
  assert.deepEqual(kinds(planRebalance(h, SETTINGS, 1, averageFunding(bleed, 6))), ["unwind"]);
  assert.notDeepEqual(kinds(planRebalance(h, SETTINGS, 1, 0.00005)), ["unwind"]);

  const input = { recentRates: bleed, unexplainedPositionChange: false, thresholds: DEFAULT_THRESHOLDS };
  assert.ok(evaluateAlerts({ ...input, current: snap() }).some((a) => a.code === "FUNDING_AVG_KILL" && a.level === "kill"));
});

test("shrinking covers at least one perp order", () => {
  // Spot ~$25 over target but the target short is under 0.01 ETH below the current one.
  const t = computeTarget(holdings(), SETTINGS);
  const short = roundDownToStep(t.spotEth) + 0.008;
  const h = holdings({ walletUsdc: t.reserveUsd + t.feeBudgetUsd, spotEth: short, perpQty: -short, perpEquity: t.marginUsd, markPrice: 2500 });
  const shrink = planRebalance(h, { ...SETTINGS, rebalanceBandPct: 1 }, 0).steps.find((s) => s.kind === "shrinkTo") as { eth: number } | undefined;
  assert.ok(shrink);
  assert.ok(short - roundDownToStep(shrink.eth) >= PERP_MIN_ORDER_ETH - 1e-9);
});

test("holdingsMoved ignores a rebalance that traded nothing", () => {
  const h = { walletUsdc: 52.18, spotEth: 0.2695, perpEquity: 471, perpQty: -0.269, markPrice: 1800, indexPrice: 1800, fundingRate: 0.0001 };
  // Nov 9 Yearn case: grow found no vbUSDC above the reserve; only prices and equity drifted.
  assert.equal(holdingsMoved(h, { ...h, perpEquity: 470.2, markPrice: 1795, walletUsdc: 52.181 }), false);
  assert.equal(holdingsMoved(h, { ...h, walletUsdc: 196.07 }), true); // margin withdrawn
  assert.equal(holdingsMoved(h, { ...h, spotEth: 0.2795 }), true); // spot bought
  assert.equal(holdingsMoved(h, { ...h, perpQty: -0.279 }), true); // short resized
});
