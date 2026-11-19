import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseAbi, parseUnits, type Address, type Hex } from "viem";
import type { ChainReader } from "./chain";
import { ADDRESSES, DECIMALS } from "./constants";
import type { TxExecutor } from "./execution";
import { isDefaultRoute, type Route } from "./routes";

const routerAbi = parseAbi([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

const DEADLINE_SECONDS = 300;

export interface SwapResult {
  hash: Hex;
  direction: "buy" | "sell";
  route: string;
  quotedOut: number;
  minOut: number;
  /** How much more the chosen route quoted than the default 0.05% direct pool, in %. */
  improvementPct: number;
  /** Total pool fee along the route, in %. */
  poolFeePct: number;
}

/** A token traded against vbUSDC on Sushi V3. */
export interface SpotAsset {
  address: Address;
  decimals: number;
  symbol: string;
}

export const VBETH: SpotAsset = { address: ADDRESSES.vbETH, decimals: DECIMALS.vbETH, symbol: "vbETH" };
export const VBWBTC: SpotAsset = { address: ADDRESSES.vbWBTC, decimals: DECIMALS.vbWBTC, symbol: "vbWBTC" };

const SYMBOLS: Record<string, string> = {
  [ADDRESSES.vbUSDC.toLowerCase()]: "vbUSDC",
  [ADDRESSES.vbETH.toLowerCase()]: "vbETH",
  [ADDRESSES.vbWBTC.toLowerCase()]: "vbWBTC",
};

/** Approves `spender` for the maximum amount if the current allowance is below `needed`. */
export async function ensureAllowance(chain: ChainReader, exec: TxExecutor, token: Address, spender: Address, needed: bigint) {
  if ((await chain.allowance(token, exec.address, spender)) >= needed) return;
  await exec.send(
    { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }) },
    `approve ${SYMBOLS[token.toLowerCase()] ?? token} for ${spender}`,
  );
}

export function improvementPct(best: Route, routes: Route[]): number {
  const baseline = routes.find(isDefaultRoute);
  if (!baseline || baseline.amountOut === 0n) return 0;
  return (Number(best.amountOut) / Number(baseline.amountOut) - 1) * 100;
}

export function createSpotTrader(chain: ChainReader, exec: TxExecutor, asset: SpotAsset = VBETH) {
  /**
   * Swaps vbUSDC <-> `asset` on the best Sushi V3 route found at send time (direct pools at every
   * fee tier, or two hops through a liquid token). `amountIn` is USDC for a buy and the asset for a sell.
   * Reverts onchain if output falls more than `maxSlippageBps` below the quote.
   */
  async function swap(direction: "buy" | "sell", amountIn: number, maxSlippageBps: number): Promise<SwapResult> {
    const [tokenIn, tokenOut, decIn, decOut] =
      direction === "buy"
        ? [ADDRESSES.vbUSDC, asset.address, DECIMALS.vbUSDC, asset.decimals]
        : [asset.address, ADDRESSES.vbUSDC, asset.decimals, DECIMALS.vbUSDC];
    // A float amount can round to a hair above the real balance, which makes the router's transfer
    // fail ("STF"). Never ask for more than the wallet actually holds.
    const requested = parseUnits(amountIn.toFixed(decIn), decIn);
    const held = await chain.client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "balanceOf", args: [exec.address] });
    const rawIn = requested > held ? held : requested;
    if (rawIn === 0n) throw new Error(`Nothing to ${direction}: wallet holds 0 of the input token`);
    const routes = await chain.routes(tokenIn, tokenOut, rawIn);
    const best = routes[0];
    if (!best) throw new Error(`No Sushi V3 route quoted for ${direction} of ${amountIn}`);
    const minOut = (best.amountOut * BigInt(10_000 - maxSlippageBps)) / 10_000n;

    await ensureAllowance(chain, exec, tokenIn, ADDRESSES.sushiV3SwapRouter, rawIn);
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "exactInput",
      args: [
        {
          path: best.path,
          recipient: exec.address,
          deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
          amountIn: rawIn,
          amountOutMinimum: minOut,
        },
      ],
    });
    const gain = improvementPct(best, routes);
    const what =
      direction === "buy" ? `buy ${asset.symbol} with ${amountIn.toFixed(2)} vbUSDC` : `sell ${amountIn.toFixed(asset.decimals === 8 ? 8 : 6)} ${asset.symbol}`;
    const label = `${what} via ${best.label}${isDefaultRoute(best) ? "" : ` (+${gain.toFixed(3)}% vs direct 0.05%)`}`;
    const { hash } = await exec.send({ to: ADDRESSES.sushiV3SwapRouter, data }, label);
    return {
      hash,
      direction,
      route: best.label,
      quotedOut: Number(formatUnits(best.amountOut, decOut)),
      minOut: Number(formatUnits(minOut, decOut)),
      improvementPct: gain,
      poolFeePct: (1 - best.fees.reduce((keep, fee) => keep * (1 - fee / 1_000_000), 1)) * 100,
    };
  }

  return {
    buy: (usdc: number, maxSlippageBps: number) => swap("buy", usdc, maxSlippageBps),
    sell: (amount: number, maxSlippageBps: number) => swap("sell", amount, maxSlippageBps),
    buyEth: (usdc: number, maxSlippageBps: number) => swap("buy", usdc, maxSlippageBps),
    sellEth: (eth: number, maxSlippageBps: number) => swap("sell", eth, maxSlippageBps),
  };
}

export type SpotTrader = ReturnType<typeof createSpotTrader>;
