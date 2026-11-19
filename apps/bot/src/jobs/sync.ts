import type { Hash } from "viem";
import type { Context } from "../context";
import { logEvent } from "../log";

const DAY = 86_400_000;
const RATE_BACKFILL = 30 * DAY;
const LOG_CHUNK = 5_000n;
const SWAP_SCAN_KEY = "swapScanBlock";

export async function syncFills({ store, perps }: Context): Promise<number> {
  const last = (await store.fills()).at(-1)?.time;
  const fills = await perps.fills(last === undefined ? undefined : last + 1);
  await store.saveFills(fills);
  return fills.length;
}

export async function syncFunding({ store, perps }: Context): Promise<{ payments: number; rates: number }> {
  const lastPayment = (await store.fundingPayments()).at(-1)?.time;
  const payments = await perps.fundingPayments(lastPayment === undefined ? undefined : lastPayment + 1);
  await store.saveFundingPayments(payments);

  const lastRate = (await store.fundingRates()).at(-1)?.time;
  const rates = await perps.fundingRates(lastRate === undefined ? Date.now() - RATE_BACKFILL : lastRate + 1);
  await store.saveFundingRates(rates);

  return { payments: payments.length, rates: rates.length };
}

/** Records one swap transaction. Returns false if the tx isn't a vbUSDC/vbETH swap by our wallet. */
export async function recordSwap(
  { store, perps, chain, wallet }: Context,
  hash: Hash,
  route?: { route: string; poolFeePct: number },
): Promise<boolean> {
  const swap = await chain.swapFromTx(hash, wallet);
  if (!swap) return false;
  const refPrice = await perps.priceAt(swap.time);
  await store.saveSwap({ ...swap, refPrice, ...route });
  return true;
}

/** Records a swap the bot just made, with the route it used. */
export async function recordOwnSwap(
  ctx: Context,
  swap: { hash: Hash; route: string; poolFeePct: number; quotedOut: number; minOut: number },
): Promise<boolean> {
  const ok = await recordSwap(ctx, swap.hash, { route: swap.route, poolFeePct: swap.poolFeePct });
  const saved = (await ctx.store.swaps()).find((s) => s.txHash === swap.hash);
  logEvent("swap", { ...saved, quotedOut: swap.quotedOut, minOut: swap.minOut, recorded: ok });
  return ok;
}

/**
 * Picks up new swaps by scanning vbETH transfers in and out of the wallet since the last scan.
 * The first run starts at the current block; record older swaps with `log-swap`.
 */
export async function syncSwaps(ctx: Context): Promise<number> {
  const { store, chain, wallet } = ctx;
  const head = await chain.blockNumber();
  const saved = store.getMeta(SWAP_SCAN_KEY);
  let from = saved === undefined ? head : BigInt(saved) + 1n;
  let found = 0;

  while (from <= head) {
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    for (const hash of await chain.vbEthTransferTxs(wallet, from, to)) {
      if (await recordSwap(ctx, hash)) found++;
    }
    store.setMeta(SWAP_SCAN_KEY, to.toString());
    from = to + 1n;
  }
  return found;
}
