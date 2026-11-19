import type { SwapRecord } from "@kdn/core";
import { createPublicClient, erc20Abi, fallback, formatUnits, http, parseAbi, parseEventLogs, parseUnits, type Address, type Hash } from "viem";
import { katana } from "viem/chains";
import { ADDRESSES, DECIMALS, SUSHI_FEE_TIER } from "./constants";
import { directRoute, findRoutes, type Route } from "./routes";

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
export interface WalletBalances {
  spotEth: number;
  walletUsdc: number;
  gasEth: number;
}

export type SwapRouting = "direct" | "search";

/**
 * RPC transport over one or more URLs, primary first. The public RPC rate-limits bursts, so each
 * URL retries briefly with backoff and then the next one takes the call.
 */
export function rpcTransport(rpcUrls?: string | string[]) {
  const urls = typeof rpcUrls === "string" ? [rpcUrls] : rpcUrls?.length ? rpcUrls : [undefined];
  if (urls.length === 1) return http(urls[0], { retryCount: 6, retryDelay: 400 });
  return fallback(urls.map((url) => http(url, { retryCount: 2, retryDelay: 400 })), { retryCount: 2, retryDelay: 1000 });
}

export function createChainReader(rpcUrls?: string | string[], routing: SwapRouting = "direct") {
  const client = createPublicClient({ chain: katana, transport: rpcTransport(rpcUrls) });
  const pools = new Map<Address, Address>();

  async function getPool(asset: Address): Promise<Address> {
    let pool = pools.get(asset);
    if (!pool) {
      pool = await client.readContract({
        address: ADDRESSES.sushiV3Factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [ADDRESSES.vbUSDC, asset, SUSHI_FEE_TIER],
      });
      pools.set(asset, pool);
    }
    return pool;
  }

  /** Mid price of the 0.05% vbUSDC/`asset` pool in USD per whole token. */
  async function midPrice(asset: Address, assetDecimals: number): Promise<number> {
    const [sqrtPriceX96] = await client.readContract({ address: await getPool(asset), abi: poolAbi, functionName: "slot0" });
    const sqrt = Number(sqrtPriceX96) / 2 ** 96;
    const usdcIsToken0 = ADDRESSES.vbUSDC.toLowerCase() < asset.toLowerCase();
    const [dec0, dec1] = usdcIsToken0 ? [DECIMALS.vbUSDC, assetDecimals] : [assetDecimals, DECIMALS.vbUSDC];
    const token1PerToken0 = sqrt * sqrt * 10 ** (dec0 - dec1);
    return usdcIsToken0 ? 1 / token1PerToken0 : token1PerToken0;
  }

  /**
   * Quoted Sushi V3 routes, best first. "direct" quotes only the 0.05% vbUSDC/vbETH pool;
   * "search" also tries other fee tiers and two-hop routes (needs an RPC without tight rate limits).
   */
  async function routes(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Route[]> {
    if (amountIn <= 0n) return [];
    return routing === "search" ? findRoutes(client, tokenIn, tokenOut, amountIn) : directRoute(client, tokenIn, tokenOut, amountIn);
  }

  /** Best exact-input quote across all routes, in raw token units. */
  async function quoteExactIn(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const [best] = await routes(tokenIn, tokenOut, amountIn);
    return best?.amountOut ?? 0n;
  }

  return {
    routes,
    client,

    async balances(wallet: Address): Promise<WalletBalances> {
      const [eth, usdc, gas] = await Promise.all([
        client.readContract({ address: ADDRESSES.vbETH, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
        client.readContract({ address: ADDRESSES.vbUSDC, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
        client.getBalance({ address: wallet }),
      ]);
      return {
        spotEth: Number(formatUnits(eth, DECIMALS.vbETH)),
        walletUsdc: Number(formatUnits(usdc, DECIMALS.vbUSDC)),
        gasEth: Number(formatUnits(gas, 18)),
      };
    },

    /** Mid price of the vbUSDC/vbETH pool in USD per ETH. */
    sushiMidPrice: () => midPrice(ADDRESSES.vbETH, DECIMALS.vbETH),

    midPrice,

    async tokenBalance(token: Address, wallet: Address): Promise<bigint> {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
    },

    quoteExactIn,

    /** USDC received for selling `eth` vbETH on the 0.05% pool. */
    async quoteSellEth(eth: number): Promise<number> {
      const amountIn = parseUnits(eth.toFixed(DECIMALS.vbETH), DECIMALS.vbETH);
      const out = await quoteExactIn(ADDRESSES.vbETH, ADDRESSES.vbUSDC, amountIn);
      return Number(formatUnits(out, DECIMALS.vbUSDC));
    },

    async allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
      return client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    },

    async blockNumber(): Promise<bigint> {
      return client.getBlockNumber();
    },

    /** Transaction hashes in [fromBlock, toBlock] that moved vbETH in or out of `wallet`. */
    async vbEthTransferTxs(wallet: Address, fromBlock: bigint, toBlock: bigint): Promise<Hash[]> {
      const event = erc20Abi.find((x) => x.type === "event" && x.name === "Transfer")!;
      const [out, inn] = await Promise.all([
        client.getLogs({ address: ADDRESSES.vbETH, event, args: { from: wallet }, fromBlock, toBlock }),
        client.getLogs({ address: ADDRESSES.vbETH, event, args: { to: wallet }, fromBlock, toBlock }),
      ]);
      return [...new Set([...out, ...inn].map((l) => l.transactionHash))];
    },

    /**
     * Reads a transaction and returns it as a swap if `wallet` both sent and received
     * vbETH/vbUSDC in it. `refPrice` is filled in by the caller.
     */
    async swapFromTx(hash: Hash, wallet: Address): Promise<Omit<SwapRecord, "refPrice"> | null> {
      const receipt = await client.getTransactionReceipt({ hash });
      if (receipt.status !== "success") return null;
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
      const me = wallet.toLowerCase();
      const net = (token: string) =>
        transfers
          .filter((t) => t.address.toLowerCase() === token.toLowerCase())
          .reduce((sum, t) => {
            if (t.args.to.toLowerCase() === me) return sum + t.args.value;
            if (t.args.from.toLowerCase() === me) return sum - t.args.value;
            return sum;
          }, 0n);
      const ethDelta = net(ADDRESSES.vbETH);
      const usdcDelta = net(ADDRESSES.vbUSDC);
      if (ethDelta === 0n || usdcDelta === 0n || ethDelta > 0n === usdcDelta > 0n) return null;

      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      const abs = (x: bigint) => (x < 0n ? -x : x);
      return {
        txHash: hash,
        time: Number(block.timestamp) * 1000,
        direction: ethDelta > 0n ? "buy" : "sell",
        ethAmount: Number(formatUnits(abs(ethDelta), DECIMALS.vbETH)),
        usdcAmount: Number(formatUnits(abs(usdcDelta), DECIMALS.vbUSDC)),
        gasEth: Number(formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)),
      };
    },
  };
}

export type ChainReader = ReturnType<typeof createChainReader>;
