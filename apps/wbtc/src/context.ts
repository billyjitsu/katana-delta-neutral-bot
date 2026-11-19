import { BTC_MARKET, WBTC_MORPHO_MARKET, DECIMALS, createChainReader, createMorphoMarket, createPerpsPublicReader, createPerpsReader } from "@kdn/katana";
import type { Address } from "viem";
import { env } from "./env";
import { WbtcStore } from "./store";

/** Market data only: works with no wallet and no API key. */
export function createContext() {
  const chain = createChainReader(env.rpcUrls, "direct");
  return {
    store: new WbtcStore(env.dbPath),
    chain,
    morpho: createMorphoMarket(chain, WBTC_MORPHO_MARKET, DECIMALS.vbUSDC, DECIMALS.vbWBTC),
    market: createPerpsPublicReader(undefined, BTC_MARKET),
  };
}

export type Context = ReturnType<typeof createContext>;

/** Adds the strategy wallet's Katana Perps account (read-only API key). */
export function createAccountContext(ctx: Context) {
  if (!env.wallet) throw new Error("WALLET_ADDRESS is not set in .env.wbtc: only track, model, report and watch (tracker only) work without it");
  const wallet: Address = env.wallet;
  return { ...ctx, wallet, perps: createPerpsReader({ apiKey: env.apiKey(), apiSecret: env.apiSecret(), wallet, market: BTC_MARKET }) };
}

export type AccountContext = ReturnType<typeof createAccountContext>;
