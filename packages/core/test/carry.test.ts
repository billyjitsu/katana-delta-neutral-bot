import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_CARRY_SETTINGS as S,
  DEFAULT_CARRY_THRESHOLDS,
  carryMetrics,
  carryTarget,
  carryYield,
  evaluateCarryAlerts,
  hoursAbove,
  planCarry,
  shortLiquidationPrice,
  sliceFraction,
  type CarryHoldings,
  type CarryPlanContext,
} from "../src/index";

const P0 = 80_000;
const D = 0.1;
const MMF = 0.01;
const X = sliceFraction(S.targetLtv, S.targetPerpLeverage);
const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

const ctx = (overrides: Partial<CarryPlanContext> = {}): CarryPlanContext => ({
  negativeFundingStreak: 0,
  hoursAboveShrinkApy: 0,
  sliceHalved: false,
  lastCompoundAt: Date.now(),
  now: Date.now(),
  maintenanceMarginFraction: MMF,
  ...overrides,
});

/** Config A entered at P0, then the price moved to P0·move with no rebalance. */
function entered(move = 1, overrides: Partial<CarryHoldings> = {}): CarryHoldings {
  const t = carryTarget(D, P0, S);
  const p = P0 * move;
  return {
    depositBtc: D,
    collateralBtc: D + t.sliceBtc,
    walletBtc: 0,
    debtUsd: t.debtUsd,
    walletUsdc: 0,
    perpEquity: t.marginUsd - t.sliceBtc * (p - P0),
    perpQty: -t.sliceBtc,
    markPrice: p,
    indexPrice: p,
    oraclePrice: p,
    fundingRate: 0.0001,
    borrowApy: 0.033,
    lltv: 0.86,
    ...overrides,
  };
}

test("sizing matches the scope doc", () => {
  close(sliceFraction(0.4, 3.3), 0.443);
  close(sliceFraction(0.5, 2.5), 0.5556);
  close(sliceFraction(0.4, 2.5), 0.4);
  const a = carryYield(0.4, 3.3, 0.112, 0.033);
  close(a.debtFraction, 0.5772);
  close(a.marginFraction, 0.1342);
  close(a.netYield, 0.0306);
  close(a.breakEvenBorrowApy, 0.086);
  close(carryYield(0.5, 2.5, 0.112, 0.033).netYield, 0.0365);
});

test("a freshly entered position is neutral and needs nothing", () => {
  const h = entered();
  const m = carryMetrics(h, MMF);
  close(m.ltv!, 0.4);
  close(m.perpLeverage!, 3.3);
  close(m.netBtc, D, 1e-9);
  close(m.profitBtc, 0, 1e-9);
  close(m.dropToMorphoLiquidationPct!, 53.5, 0.1);
  close(m.rallyToPerpLiquidationPct!, 29.0, 0.1);
  assert.deepEqual(planCarry(h, S, ctx()).steps, []);
});

test("liquidation price of a short at maintenance margin", () => {
  // 1 BTC short, $20k equity at $100k: equity + S·P = 1.01·S·P' → P' = 120000/1.01.
  close(shortLiquidationPrice(1, 20_000, 100_000, 0.01)!, 118_811.9, 0.1);
});

test("BTC +7%: borrow and top up margin; both legs land back on target", () => {
  const h = entered(1.07);
  const plan = planCarry(h, S, ctx());
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0]!;
  assert.equal(step.kind, "topUp");
  const usd = step.kind === "topUp" ? step.usd : 0;
  const after = carryMetrics({ ...h, debtUsd: h.debtUsd + usd, perpEquity: h.perpEquity + usd }, MMF);
  close(after.perpLeverage!, 3.3);
  close(after.ltv!, 0.4, 0.002);
});

test("BTC −7.1%: release surplus margin to repay", () => {
  const plan = planCarry(entered(0.929), S, ctx());
  assert.equal(plan.steps[0]?.kind, "release");
  close(carryMetrics(entered(0.929), MMF).ltv!, 0.43, 0.002);
});

test("perp side ladder: +12.5% alerts, +18.5% shrinks back under 4.5x", () => {
  const at12 = entered(1.125);
  const alerts = evaluateCarryAlerts(
    { holdings: at12, metrics: carryMetrics(at12, MMF), utilization: 0.9, sushiPrice: at12.indexPrice, gasEth: 0.01, negativeFundingStreak: 0 },
    S,
    DEFAULT_CARRY_THRESHOLDS,
  );
  assert.ok(alerts.some((a) => a.code === "PERP_LEV_HIGH"));
  assert.equal(planCarry(at12, S, ctx()).steps[0]?.kind, "topUp");

  const h = entered(1.185);
  const m = carryMetrics(h, MMF);
  assert.ok(m.perpLeverage! >= 9.8);
  const plan = planCarry(h, S, ctx());
  assert.equal(plan.urgency, "emergency");
  const step = plan.steps[0]!;
  assert.equal(step.kind, "shrink");
  const q = m.sliceBtc - (step.kind === "shrink" ? step.sliceBtc : 0);
  const after = carryMetrics({ ...h, collateralBtc: h.collateralBtc - q, perpQty: h.perpQty + q, debtUsd: h.debtUsd - q * h.indexPrice }, MMF);
  close(after.perpLeverage!, 4.5, 0.01);
  close(after.netBtc, D, 1e-9);
});

test("Morpho side ladder: −34% shrinks back to 50% LTV, −43% unwinds", () => {
  const h = entered(0.66);
  const m = carryMetrics(h, MMF);
  assert.ok(m.ltv! >= 0.6);
  const plan = planCarry(h, S, ctx());
  const step = plan.steps[0]!;
  assert.equal(step.kind, "shrink");
  const q = m.sliceBtc - (step.kind === "shrink" ? step.sliceBtc : 0);
  const after = carryMetrics({ ...h, collateralBtc: h.collateralBtc - q, perpQty: h.perpQty + q, debtUsd: h.debtUsd - q * h.oraclePrice }, MMF);
  close(after.ltv!, 0.5, 0.001);

  assert.deepEqual(planCarry(entered(0.57), S, ctx()).steps, [{ kind: "unwind" }]);
});

test("entry: supply the wallet's WBTC, then grow the slice", () => {
  const h: CarryHoldings = { ...entered(), collateralBtc: 0, walletBtc: D, debtUsd: 0, perpEquity: 0, perpQty: 0 };
  const plan = planCarry(h, S, ctx());
  assert.deepEqual(plan.steps.map((s) => s.kind), ["supply", "grow"]);
  const grow = plan.steps[1]!;
  if (grow.kind === "grow") {
    close(grow.sliceBtc, D * X, 1e-9);
    close(grow.marginUsd, (D * X * P0) / 3.3, 1e-6);
  }
});

test("WBTC without a recorded deposit is never shorted", () => {
  const plan = planCarry({ ...entered(), depositBtc: 0, collateralBtc: 0, walletBtc: D, debtUsd: 0, perpEquity: 0, perpQty: 0 }, S, ctx());
  assert.deepEqual(plan.steps, []);
  assert.match(plan.notes[0]!, /No deposit recorded/);
});

test("no growing into negative funding or a high borrow rate", () => {
  const empty: CarryHoldings = { ...entered(), collateralBtc: D, debtUsd: 0, perpEquity: 0, perpQty: 0 };
  assert.deepEqual(planCarry({ ...empty, fundingRate: -0.0001 }, S, ctx()).steps, []);
  assert.deepEqual(planCarry({ ...empty, borrowApy: 0.08 }, S, ctx()).steps, []);
});

test("rate guards: halve after 24h above 7%, unwind at 10%, stay halved until below 5%", () => {
  const plan = planCarry(entered(1, { borrowApy: 0.075 }), S, ctx({ hoursAboveShrinkApy: 25 }));
  assert.ok(plan.halved);
  const step = plan.steps[0]!;
  assert.equal(step.kind, "shrink");
  if (step.kind === "shrink") close(step.sliceBtc, (D * X) / 2, 1e-9);

  assert.deepEqual(planCarry(entered(1, { borrowApy: 0.11 }), S, ctx()).steps, [{ kind: "unwind" }]);

  const half = carryTarget(D, P0, S, 0.5);
  const halvedPos = { ...entered(), collateralBtc: D + half.sliceBtc, perpQty: -half.sliceBtc, debtUsd: half.debtUsd, perpEquity: half.marginUsd, borrowApy: 0.06 };
  const still = planCarry(halvedPos, S, ctx({ sliceHalved: true }));
  assert.ok(still.halved);
  assert.deepEqual(still.steps, []);
  const back = planCarry({ ...halvedPos, borrowApy: 0.04 }, S, ctx({ sliceHalved: true }));
  assert.ok(!back.halved);
  assert.equal(back.steps[0]?.kind, "grow");
});

test("three negative funding periods unwind the slice", () => {
  assert.deepEqual(planCarry(entered(), S, ctx({ negativeFundingStreak: 3 })).steps, [{ kind: "unwind" }]);
});

test("unhedged slice after the stop fired: re-hedge", () => {
  const plan = planCarry(entered(1, { perpQty: 0 }), S, ctx());
  assert.deepEqual(plan.steps.map((s) => s.kind), ["hedge"]);
});

test("vbUSDC in the wallet repays debt", () => {
  const plan = planCarry(entered(1, { walletUsdc: 50 }), S, ctx());
  assert.deepEqual(plan.steps, [{ kind: "repay", usd: 50 }]);
});

test("profit compounds weekly once above the minimum", () => {
  const rich = entered(1, { perpEquity: entered().perpEquity + 30 });
  assert.deepEqual(planCarry(rich, S, ctx()).steps, []);
  const due = planCarry(rich, S, ctx({ lastCompoundAt: Date.now() - 8 * 86_400_000 }));
  assert.equal(due.steps[0]?.kind, "compound");
  close(carryMetrics(rich, MMF).profitUsd, 30, 1e-6);
});

test("hoursAbove counts the current run above the threshold", () => {
  const h = 3_600_000;
  const samples = [
    { time: 0, apy: 0.08 },
    { time: h, apy: 0.05 },
    { time: 2 * h, apy: 0.075 },
    { time: 3 * h, apy: 0.09 },
  ];
  assert.equal(hoursAbove(samples, 0.07, 5 * h), 3);
  assert.equal(hoursAbove([...samples, { time: 4 * h, apy: 0.06 }], 0.07, 5 * h), 0);
});

test("alerts: utilization, borrow APY, drift and depeg", () => {
  const h = entered(1, { borrowApy: 0.08, perpQty: -0.03 });
  const alerts = evaluateCarryAlerts(
    { holdings: h, metrics: carryMetrics(h, MMF), utilization: 0.995, sushiPrice: h.indexPrice * 0.97, gasEth: 0.01, negativeFundingStreak: 0 },
    S,
    DEFAULT_CARRY_THRESHOLDS,
  );
  const codes = alerts.map((a) => a.code).sort();
  assert.deepEqual(codes, ["BASIS_KILL_SUSHI", "BORROW_APY_HIGH", "NET_BTC_DRIFT", "UTILIZATION_HIGH"]);
});
