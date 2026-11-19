import { createPrivateKeyTypedDataSigner } from "@katanaperps/katana-perps-sdk";
import { BTC_MARKET, DECIMALS, VBWBTC, createMorphoTrader, createPerpsTrader, createSpotTrader, rpcTransport, type TxExecutor } from "@kdn/katana";
import { logEvent } from "@kdn/bot/log";
import { createWalletClient, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { katana } from "viem/chains";
import type { AccountContext } from "./context";
import { env } from "./env";

/** Counts what was actually sent (transactions, orders, withdrawals), so a failure before the first one isn't treated as a half-done rebalance. */
export interface ActionCounter {
  count: number;
}

function createLocalExecutor(privateKey: Hex, ctx: AccountContext, actions: ActionCounter): TxExecutor {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: katana, transport: rpcTransport(env.rpcUrls) });
  return {
    address: account.address,
    async send({ to, data, value }, label) {
      const hash = await client.sendTransaction({ to, data, value });
      actions.count++;
      console.log(`  → ${label}: ${hash}`);
      const receipt = await ctx.chain.client.waitForTransactionReceipt({ hash });
      const gasEth = Number(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
      // Gas is paid in ETH, so price it off the vbUSDC/vbETH pool rather than the BTC index.
      const ethUsd = await ctx.chain.sushiMidPrice().catch(() => 0);
      ctx.store.saveCost({ time: Date.now(), kind: "gas", label, usd: gasEth * ethUsd, txHash: hash });
      logEvent("tx", { label, hash, status: receipt.status, block: receipt.blockNumber, gasEth, gasUsd: gasEth * ethUsd });
      if (receipt.status !== "success") throw new Error(`Transaction reverted: ${label} (${hash})`);
      return { hash };
    },
  };
}

/** Adds signing on top of the account context. Requires WALLET_PRIVATE_KEY in .env.wbtc. */
export function createTradingContext(ctx: AccountContext) {
  const privateKey = env.walletPrivateKey();
  const actions: ActionCounter = { count: 0 };
  const exec = createLocalExecutor(privateKey, ctx, actions);
  if (exec.address.toLowerCase() !== ctx.wallet.toLowerCase()) {
    throw new Error(`WALLET_PRIVATE_KEY is for ${exec.address}, but WALLET_ADDRESS is ${ctx.wallet}`);
  }
  return {
    ...ctx,
    exec,
    actions,
    spot: createSpotTrader(ctx.chain, exec, VBWBTC),
    trader: createPerpsTrader(
      { apiKey: env.apiKey(), apiSecret: env.apiSecret(), signer: createPrivateKeyTypedDataSigner(privateKey), market: BTC_MARKET },
      ctx.perps,
      ctx.chain,
      exec,
    ),
    lender: createMorphoTrader(ctx.morpho, ctx.chain, exec, DECIMALS.vbUSDC, DECIMALS.vbWBTC),
  };
}

export type TradingContext = ReturnType<typeof createTradingContext>;
