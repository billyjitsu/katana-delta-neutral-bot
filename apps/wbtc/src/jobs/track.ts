import { carryTarget, carryYield, fundingApr } from "@kdn/core";
import { ADDRESSES, DECIMALS } from "@kdn/katana";
import { logEvent } from "@kdn/bot/log";
import { parseUnits } from "viem";
import type { Context } from "../context";
import { carry, env } from "../env";
import type { Observation } from "../store";

/** Quoted cost of buying `usd` of vbWBTC on Sushi, as % above index. */
export async function buyCostPct(ctx: Context, usd: number, indexPrice: number): Promise<number> {
  const out = await ctx.chain.quoteExactIn(ADDRESSES.vbUSDC, ADDRESSES.vbWBTC, parseUnits(usd.toFixed(6), DECIMALS.vbUSDC));
  if (out === 0n) return Infinity;
  return (usd / (Number(out) / 10 ** DECIMALS.vbWBTC) / indexPrice - 1) * 100;
}

/**
 * One tracker reading: funding, borrow rate, utilization, prices and the Sushi cost of the slice a
 * TRACK_DEPOSIT_USD deposit would buy. No wallet or key needed.
 */
export async function observe(ctx: Context): Promise<Observation> {
  const [market, morpho, sushiPrice] = await Promise.all([
    ctx.market.market(),
    ctx.morpho.state(),
    ctx.chain.midPrice(ADDRESSES.vbWBTC, DECIMALS.vbWBTC),
  ]);
  const target = carryTarget(env.trackDepositUsd / market.indexPrice, market.indexPrice, carry);
  const sliceUsd = target.sliceBtc * market.indexPrice;
  const sliceBuyCostPct = await buyCostPct(ctx, sliceUsd, market.indexPrice);
  const model = carryYield(carry.targetLtv, carry.targetPerpLeverage, fundingApr(market.currentFundingRate), morpho.borrowApy);
  const o: Observation = {
    time: Date.now(),
    indexPrice: market.indexPrice,
    markPrice: market.markPrice,
    fundingRate: market.currentFundingRate,
    oraclePrice: morpho.oraclePrice,
    sushiPrice,
    borrowApy: morpho.borrowApy,
    utilization: morpho.utilization,
    availableUsd: morpho.available,
    sliceBuyCostPct,
    sliceUsd,
    modelYield: model.netYield,
  };
  ctx.store.saveObservation(o);
  logEvent("observation", { ...o });
  return o;
}

export function formatObservation(o: Observation): string {
  const p = (n: number, d = 2) => `${(n * 100).toFixed(d)}%`;
  return [
    `BTC-USD   index $${o.indexPrice.toFixed(0)}  mark $${o.markPrice.toFixed(0)}  funding ${(o.fundingRate * 100).toFixed(4)}%/8h (${p(fundingApr(o.fundingRate), 1)} APR)`,
    `Morpho    borrow ${p(o.borrowApy)}  utilization ${p(o.utilization, 1)}  available $${(o.availableUsd / 1000).toFixed(0)}k  oracle $${o.oraclePrice.toFixed(0)} (${((o.oraclePrice / o.indexPrice - 1) * 100).toFixed(2)}% vs index)`,
    `Sushi     mid $${o.sushiPrice.toFixed(0)} (${((o.sushiPrice / o.indexPrice - 1) * 100).toFixed(2)}% vs index)  buying the $${o.sliceUsd.toFixed(0)} slice costs ${o.sliceBuyCostPct.toFixed(2)}%`,
    `Model     ${p(o.modelYield)} more BTC a year at these rates (${p(carry.targetLtv, 0)} LTV, ${carry.targetPerpLeverage}x perp)`,
  ].join("\n");
}
