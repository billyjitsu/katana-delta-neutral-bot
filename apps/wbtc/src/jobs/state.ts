import {
  carryMetrics,
  consecutiveNegative,
  evaluateCarryAlerts,
  hoursAbove,
  type Alert,
  type CarryHoldings,
  type CarryPlanContext,
} from "@kdn/core";
import { ADDRESSES, DECIMALS, type MorphoMarketState, type PerpsAccount } from "@kdn/katana";
import { formatUnits } from "viem";
import type { AccountContext } from "../context";
import { carry, thresholds } from "../env";
import type { Snapshot } from "../store";

const DAY = 86_400_000;
const RATE_BACKFILL = 30 * DAY;
export const SLICE_HALVED_KEY = "sliceHalved";
export const LAST_COMPOUND_KEY = "lastCompoundAt";

export interface LiveState {
  holdings: CarryHoldings;
  morpho: MorphoMarketState;
  account: PerpsAccount;
  sushiPrice: number;
  gasEth: number;
  maintenanceMarginFraction: number;
}

/** Every number the planner needs, read fresh from Katana Perps, Morpho and the wallet. */
export async function readState(ctx: AccountContext): Promise<LiveState> {
  const [account, market, morpho, btc, usdc, gas, sushiPrice] = await Promise.all([
    ctx.perps.account(),
    ctx.perps.market(),
    ctx.morpho.read(ctx.wallet),
    ctx.chain.tokenBalance(ADDRESSES.vbWBTC, ctx.wallet),
    ctx.chain.tokenBalance(ADDRESSES.vbUSDC, ctx.wallet),
    ctx.chain.client.getBalance({ address: ctx.wallet }),
    ctx.chain.midPrice(ADDRESSES.vbWBTC, DECIMALS.vbWBTC),
  ]);
  return {
    holdings: {
      depositBtc: ctx.store.depositBtc(),
      collateralBtc: morpho.position.collateral,
      walletBtc: Number(formatUnits(btc, DECIMALS.vbWBTC)),
      debtUsd: morpho.position.debt,
      walletUsdc: Number(formatUnits(usdc, DECIMALS.vbUSDC)),
      perpEquity: account.equity,
      perpQty: account.position?.qty ?? 0,
      markPrice: market.markPrice,
      indexPrice: market.indexPrice,
      oraclePrice: morpho.state.oraclePrice,
      fundingRate: market.currentFundingRate,
      borrowApy: morpho.state.borrowApy,
      lltv: morpho.state.lltv,
    },
    morpho: morpho.state,
    account,
    sushiPrice,
    gasEth: Number(formatUnits(gas, 18)),
    maintenanceMarginFraction: market.maintenanceMarginFraction,
  };
}

export function negativeFundingStreak(ctx: AccountContext | { store: AccountContext["store"] }): number {
  const rates = ctx.store.fundingRates(Date.now() - 3 * DAY);
  return consecutiveNegative(rates.map((r) => r.rate).reverse());
}

/** Planner inputs that come from history: funding streak, how long the rate has been high, compounding. */
export function planContext(ctx: AccountContext, s: LiveState): CarryPlanContext {
  const now = Date.now();
  const samples = ctx.store
    .observations(now - 3 * DAY)
    .map((o) => ({ time: o.time, apy: o.borrowApy }))
    .concat({ time: now, apy: s.holdings.borrowApy });
  const lastCompound = ctx.store.getMeta(LAST_COMPOUND_KEY);
  // Never compound in the first week: entry costs come out of the first profit.
  const firstDeposit = ctx.store.btcFlows()[0]?.time;
  return {
    negativeFundingStreak: negativeFundingStreak(ctx),
    hoursAboveShrinkApy: hoursAbove(samples, carry.shrinkBorrowApy, now),
    sliceHalved: ctx.store.getMeta(SLICE_HALVED_KEY) === "true",
    lastCompoundAt: lastCompound ? Number(lastCompound) : firstDeposit,
    now,
    maintenanceMarginFraction: s.maintenanceMarginFraction,
  };
}

export async function syncFunding(ctx: AccountContext): Promise<{ payments: number; rates: number; fills: number }> {
  const lastPayment = ctx.store.fundingPayments().at(-1)?.time;
  const payments = await ctx.perps.fundingPayments(lastPayment === undefined ? undefined : lastPayment + 1);
  ctx.store.saveFundingPayments(payments);
  const lastFill = ctx.store.fills().at(-1)?.time;
  const fills = await ctx.perps.fills(lastFill === undefined ? undefined : lastFill + 1);
  ctx.store.saveFills(fills);
  return { payments: payments.length, rates: await syncRates(ctx), fills: fills.length };
}

export async function syncRates(ctx: { store: AccountContext["store"]; market: AccountContext["market"] }): Promise<number> {
  const lastRate = ctx.store.fundingRates().at(-1)?.time;
  const rates = await ctx.market.fundingRates(lastRate === undefined ? Date.now() - RATE_BACKFILL : lastRate + 1);
  ctx.store.saveFundingRates(rates);
  return rates.length;
}

/** Margin withdrawals that haven't been seen landing yet are marked once the wallet holds their amount. */
export function markArrivedWithdrawals(ctx: AccountContext, walletUsdc: number) {
  for (const w of ctx.store.withdrawals()) {
    if (w.arrivedAt === null && walletUsdc >= (w.usd - w.feeUsd) * 0.98) ctx.store.markWithdrawalArrived(w.id);
  }
}

/** Reads, stores and evaluates one snapshot of the whole position. */
export async function checkPosition(ctx: AccountContext): Promise<{ state: LiveState; snapshot: Snapshot; alerts: Alert[] }> {
  const state = await readState(ctx);
  const metrics = carryMetrics(state.holdings, state.maintenanceMarginFraction);
  const snapshot: Snapshot = {
    time: Date.now(),
    holdings: state.holdings,
    metrics,
    utilization: state.morpho.utilization,
    sushiPrice: state.sushiPrice,
    gasEth: state.gasEth,
  };
  ctx.store.saveSnapshot(snapshot);
  markArrivedWithdrawals(ctx, state.holdings.walletUsdc);
  const alerts = evaluateCarryAlerts(
    {
      holdings: state.holdings,
      metrics,
      utilization: state.morpho.utilization,
      sushiPrice: state.sushiPrice,
      gasEth: state.gasEth,
      negativeFundingStreak: negativeFundingStreak(ctx),
    },
    carry,
    thresholds,
  );
  return { state, snapshot, alerts };
}
