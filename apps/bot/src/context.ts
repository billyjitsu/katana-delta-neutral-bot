import { createChainReader, createPerpsReader } from "@kdn/katana";
import { SqliteStore } from "./db";
import { env } from "./env";

export function createContext() {
  const wallet = env.wallet();
  return {
    wallet,
    store: new SqliteStore(env.dbPath),
    perps: createPerpsReader({ apiKey: env.apiKey(), apiSecret: env.apiSecret(), wallet }),
    chain: createChainReader(env.rpcUrls, env.swapRouting),
  };
}

export type Context = ReturnType<typeof createContext>;
