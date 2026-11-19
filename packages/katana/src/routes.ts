import { BaseError, ContractFunctionRevertedError, encodePacked, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { ADDRESSES, HOP_TOKENS, SUSHI_FEE_TIER, SUSHI_V3_FEE_TIERS } from "./constants";

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
// QuoterV2 is non-view onchain but returns normally under eth_call, so it is declared view here.
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) view returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

const SYMBOLS: Record<string, string> = Object.fromEntries([
  [ADDRESSES.vbUSDC.toLowerCase(), "vbUSDC"],
  [ADDRESSES.vbETH.toLowerCase(), "vbETH"],
  ...Object.entries(HOP_TOKENS).map(([symbol, address]) => [address.toLowerCase(), symbol]),
]);

const QUOTE_CONCURRENCY = 2;
/** Large enough that the pool lookup goes out as one eth_call instead of several. */
const MULTICALL_BATCH_BYTES = 65_536;

/** Like Promise.allSettled over `items.map(fn)`, with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface Route {
  tokens: Address[];
  fees: number[];
  path: Hex;
  amountOut: bigint;
  gasEstimate: bigint;
  /** e.g. "vbUSDC -0.05%-> vbETH" */
  label: string;
}

/** The direct pool the bot used before route search, kept as the comparison baseline. */
export function isDefaultRoute(r: Route): boolean {
  return r.fees.length === 1 && r.fees[0] === SUSHI_FEE_TIER;
}

function describe(tokens: Address[], fees: number[]): string {
  return tokens
    .map((t, i) => (SYMBOLS[t.toLowerCase()] ?? t) + (i < fees.length ? ` -${fees[i]! / 10_000}%->` : ""))
    .join(" ");
}

function encodePath(tokens: Address[], fees: number[]): Hex {
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  tokens.forEach((t, i) => {
    types.push("address");
    values.push(t);
    if (i < fees.length) {
      types.push("uint24");
      values.push(fees[i]!);
    }
  });
  return encodePacked(types, values);
}

/** Pools don't move once created, so each process looks them up once per token pair. */
const poolCache = new Map<string, Promise<Set<string>>>();

function existingPools(client: PublicClient, tokenIn: Address, tokenOut: Address, mids: Address[]): Promise<Set<string>> {
  const key = `${tokenIn}-${tokenOut}`;
  let cached = poolCache.get(key);
  if (!cached) {
    cached = lookupPools(client, tokenIn, tokenOut, mids);
    poolCache.set(key, cached);
    cached.catch(() => poolCache.delete(key));
  }
  return cached;
}

async function lookupPools(client: PublicClient, tokenIn: Address, tokenOut: Address, mids: Address[]): Promise<Set<string>> {
  const pairs: [Address, Address, number][] = [];
  for (const fee of SUSHI_V3_FEE_TIERS) {
    pairs.push([tokenIn, tokenOut, fee]);
    for (const mid of mids) pairs.push([tokenIn, mid, fee], [mid, tokenOut, fee]);
  }

  const pools = await client.multicall({
    contracts: pairs.map(([a, b, fee]) => ({
      address: ADDRESSES.sushiV3Factory,
      abi: factoryAbi,
      functionName: "getPool" as const,
      args: [a, b, fee] as const,
    })),
    allowFailure: true,
    batchSize: MULTICALL_BATCH_BYTES,
  });
  // getPool never reverts, so any failure is the RPC. Fail loudly rather than search a partial set.
  const lookupFailure = pools.find((p) => p.status === "failure");
  if (lookupFailure) throw new Error(`Pool lookup failed: ${String(lookupFailure.error?.message ?? "RPC error").slice(0, 200)}`);

  const exists = new Set<string>();
  pools.forEach((p, i) => {
    if (p.status === "success" && p.result !== zeroAddress) {
      const [a, b, fee] = pairs[i]!;
      exists.add(`${a}-${b}-${fee}`);
    }
  });
  return exists;
}

/** Quotes only the direct pool at SUSHI_FEE_TIER: one eth_call, light enough for the public RPC. */
export async function directRoute(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route[]> {
  const tokens = [tokenIn, tokenOut];
  const fees = [SUSHI_FEE_TIER];
  const path = encodePath(tokens, fees);
  const [amountOut, , , gasEstimate] = await client.readContract({
    address: ADDRESSES.sushiV3QuoterV2,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });
  return amountOut === 0n ? [] : [{ tokens, fees, path, amountOut, gasEstimate, label: describe(tokens, fees) }];
}

/**
 * Quotes every Sushi V3 route from `tokenIn` to `tokenOut`: the direct pool at each fee tier and
 * two-hop routes through HOP_TOKENS. Returns routes with a quote, best first.
 */
export async function findRoutes(client: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route[]> {
  const mids = Object.values(HOP_TOKENS) as Address[];
  const exists = await existingPools(client, tokenIn, tokenOut, mids);
  const has = (a: Address, b: Address, fee: number) => exists.has(`${a}-${b}-${fee}`);

  const candidates: { tokens: Address[]; fees: number[] }[] = [];
  for (const mid of mids) {
    for (const fee1 of SUSHI_V3_FEE_TIERS) {
      if (!has(tokenIn, mid, fee1)) continue;
      for (const fee2 of SUSHI_V3_FEE_TIERS) {
        if (has(mid, tokenOut, fee2)) candidates.push({ tokens: [tokenIn, mid, tokenOut], fees: [fee1, fee2] });
      }
    }
  }

  // Quotes go out as separate eth_calls, not one multicall: a route through a thin pool can burn
  // millions of gas, and in a shared multicall that blows the RPC gas cap for every route at once.
  const paths = candidates.map((c) => encodePath(c.tokens, c.fees));
  const quotes = await mapLimit(paths, QUOTE_CONCURRENCY, (path) =>
    client.readContract({ address: ADDRESSES.sushiV3QuoterV2, abi: quoterAbi, functionName: "quoteExactInput", args: [path, amountIn] }),
  );

  // A revert means the pool can't fill this size: skip that route. Anything else is the RPC, and a
  // missing quote could hide the best route, so abort.
  const rpcFailure = quotes.find(
    (q) => q.status === "rejected" && !(q.reason instanceof BaseError && q.reason.walk((e) => e instanceof ContractFunctionRevertedError)),
  );
  if (rpcFailure?.status === "rejected") throw new Error(`Route quote failed: ${String((rpcFailure.reason as Error)?.message).slice(0, 200)}`);

  const routes: Route[] = [];
  quotes.forEach((q, i) => {
    if (q.status !== "fulfilled" || q.value[0] === 0n) return;
    const c = candidates[i]!;
    routes.push({ ...c, path: paths[i]!, amountOut: q.value[0], gasEstimate: q.value[3], label: describe(c.tokens, c.fees) });
  });
  return routes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
}
