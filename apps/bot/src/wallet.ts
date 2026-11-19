import { createPrivateKeyTypedDataSigner } from "@katanaperps/katana-perps-sdk";
import { createPerpsTrader, createSpotTrader, rpcTransport, type TxExecutor } from "@kdn/katana";
import { createWalletClient, formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { katana } from "viem/chains";
import type { Context } from "./context";
import { env } from "./env";
import { logEvent } from "./log";

function createLocalExecutor(privateKey: Hex, ctx: Context): TxExecutor {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({ account, chain: katana, transport: rpcTransport(env.rpcUrls) });
  return {
    address: account.address,
    async send({ to, data, value }, label) {
      const hash = await client.sendTransaction({ to, data, value });
      console.log(`  → ${label}: ${hash}`);
      const receipt = await ctx.chain.client.waitForTransactionReceipt({ hash });
      // Every transaction's gas goes in the cost ledger, reverted ones included.
      const gasEth = Number(formatEther(receipt.gasUsed * receipt.effectiveGasPrice));
      const { indexPrice } = await ctx.perps.market();
      await ctx.store.saveCost({ time: Date.now(), kind: "gas", label, usd: gasEth * indexPrice, txHash: hash });
      logEvent("tx", { label, hash, status: receipt.status, block: receipt.blockNumber, gasEth, gasUsd: gasEth * indexPrice });
      if (receipt.status !== "success") throw new Error(`Transaction reverted: ${label} (${hash})`);
      return { hash };
    },
  };
}

/** Adds signing on top of the read-only context. Requires WALLET_PRIVATE_KEY. */
export function createTradingContext(ctx: Context) {
  const privateKey = env.walletPrivateKey();
  const exec = createLocalExecutor(privateKey, ctx);
  if (exec.address.toLowerCase() !== ctx.wallet.toLowerCase()) {
    throw new Error(`WALLET_PRIVATE_KEY is for ${exec.address}, but WALLET_ADDRESS is ${ctx.wallet}`);
  }
  return {
    ...ctx,
    exec,
    spot: createSpotTrader(ctx.chain, exec),
    trader: createPerpsTrader(
      { apiKey: env.apiKey(), apiSecret: env.apiSecret(), signer: createPrivateKeyTypedDataSigner(privateKey) },
      ctx.perps,
      ctx.chain,
      exec,
    ),
  };
}

export type TradingContext = ReturnType<typeof createTradingContext>;
