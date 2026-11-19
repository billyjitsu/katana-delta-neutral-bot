import { liquidationRallyForLeverage } from "@kdn/core";
import { ADDRESSES, DECIMALS, createChainReader, createPerpsPublicReader, improvementPct, isDefaultRoute } from "@kdn/katana";
import { formatUnits, parseUnits, type Hash } from "viem";
import { createContext, type Context } from "./context";
import { env, execution } from "./env";
import { costsReport, DEFAULT_SIZES } from "./jobs/costs";
import { exit, hedge, rebalance, withdrawAndRecord } from "./jobs/execute";
import { checkPosition } from "./jobs/snapshot";
import { maintainStop } from "./jobs/protect";
import { watch } from "./jobs/watch";
import { createTradingContext } from "./wallet";
import { buildCurrentReport, formatReport } from "./jobs/report";
import { recordOwnSwap, recordSwap, syncFills, syncFunding, syncSwaps } from "./jobs/sync";
import { initLogging, logEvent, recentEvents } from "./log";
import { dispatchAlerts, send } from "./notify";
import { pause, resume } from "./auto";

const USAGE = `Usage: npm run bot -- <command>

  market                 Live market + Sushi basis (no credentials needed)
  routes buy <usdc>|sell <eth>  Quote every Sushi V3 route (no credentials needed)
  snapshot               Snapshot both legs and print alerts
  sync                   Pull fills, funding payments, funding rates and new swaps
  report                 PnL and hypothesis status (H1–H6)
  logs [n]               Last n logged actions (full logs in data/logs/)
  pause [reason]         Stop automatic rebalancing (watching and alerts continue)
  resume                 Allow automatic rebalancing again
  costs [usd ...]        Fees paid so far + round-trip cost and payback at each capital size
  watch                  Loop: sync + snapshot + alerts every WATCH_INTERVAL_MIN
  capital <usd> [note]   Record money put in (positive) or taken out (negative)
  log-swap <txHash>      Record a past Sushi swap made by the wallet

Trading (needs WALLET_PRIVATE_KEY; dry run unless --go is passed)
  rebalance [--go]       Size the whole position from current holdings and move to target
                         (first entry, added capital, leverage drift, leg drift, negative funding)
  exit [--go]            Close the short and sell vbETH in chunks
  hedge [--go]           Resize the short to match the vbETH held
  protect [--go]         Place/refresh the reduce-only stop on the exchange (STOP_BELOW_LIQ_PCT under liquidation)
  cancel-orders [--go]   List open perp orders in every market; cancel them all with --go
  deposit <usd> [--go]   Move vbUSDC from the wallet into perp margin
  withdraw <usd> [--go]  Move margin back to the wallet (API key needs Withdraw scope)
  swap buy <usdc>|sell <eth> [--go]  One swap on the best Sushi V3 route`;

async function market() {
  const perps = createPerpsPublicReader();
  const chain = createChainReader(env.rpcUrls);
  const [m, sushi] = await Promise.all([perps.market(), chain.sushiMidPrice()]);
  const apr = m.currentFundingRate * 3 * 365 * 100;
  console.log(`ETH-USD  index $${m.indexPrice.toFixed(2)}  mark $${m.markPrice.toFixed(2)}`);
  console.log(`Sushi    mid   $${sushi.toFixed(2)}  basis ${((sushi / m.indexPrice - 1) * 100).toFixed(3)}%`);
  console.log(`Funding  ${(m.currentFundingRate * 100).toFixed(4)}%/8h (${apr.toFixed(2)}% APR)  next ${new Date(m.nextFundingTime).toISOString()}`);
  console.log(`Margin   IMF ${(m.initialMarginFraction * 100).toFixed(1)}%  MMF ${(m.maintenanceMarginFraction * 100).toFixed(1)}%  fees maker ${(m.makerFeeRate * 100).toFixed(4)}% taker ${(m.takerFeeRate * 100).toFixed(4)}%`);
  for (const L of [1.5, 2, 3, 5]) {
    const rally = liquidationRallyForLeverage(L, m.maintenanceMarginFraction) * 100;
    console.log(`  ${L}x short → liquidation after ~+${rally.toFixed(0)}% rally`);
  }
}

async function routes(direction: string | undefined, amountArg: string | undefined) {
  if ((direction !== "buy" && direction !== "sell") || !(Number(amountArg) > 0)) {
    throw new Error("Usage: routes buy <usdc> | routes sell <eth>");
  }
  const amount = Number(amountArg);
  const chain = createChainReader(env.rpcUrls, env.swapRouting);
  const { indexPrice } = await createPerpsPublicReader().market();
  const [tokenIn, tokenOut, decIn, decOut] =
    direction === "buy"
      ? [ADDRESSES.vbUSDC, ADDRESSES.vbETH, DECIMALS.vbUSDC, DECIMALS.vbETH]
      : [ADDRESSES.vbETH, ADDRESSES.vbUSDC, DECIMALS.vbETH, DECIMALS.vbUSDC];
  const found = await chain.routes(tokenIn, tokenOut, parseUnits(amount.toString(), decIn));
  console.log(`${direction} ${amount} ${direction === "buy" ? "vbUSDC" : "vbETH"}  (index $${indexPrice.toFixed(2)})`);
  // Routes through near-empty pools quote absurd prices; only show those within 10% of the best.
  const best = found[0]?.amountOut ?? 0n;
  const shown = found.filter((r) => r.amountOut * 10n >= best * 9n);
  for (const [i, r] of shown.entries()) {
    const out = Number(formatUnits(r.amountOut, decOut));
    const price = direction === "buy" ? amount / out : out / amount;
    const vsIndex = (direction === "buy" ? price / indexPrice - 1 : 1 - price / indexPrice) * 100;
    const marker = i === 0 ? "→" : " ";
    console.log(`${marker} ${r.label.padEnd(44)} out ${out.toFixed(direction === "buy" ? 6 : 2).padStart(12)}  $${price.toFixed(2)}  cost ${vsIndex.toFixed(3)}% vs index${isDefaultRoute(r) ? "  (reference pool)" : ""}`);
  }
  if (found.length > shown.length) console.log(`  (${found.length - shown.length} routes through thin pools hidden)`);
  if (found[0] && found.length > 1) console.log(`\nBest route beats the direct 0.05% pool by ${improvementPct(found[0], found).toFixed(3)}%`);
}

/** Prints the most recent action events in a readable form. */
function printEvents(count: number) {
  const events = recentEvents(Infinity).filter((e) => e.type !== "command").slice(-count);
  if (!events.length) return console.log("No trades, transfers or alerts logged yet (dry runs only log the command).");
  for (const e of events) {
    const { time, type, command, ...rest } = e;
    const detail = Object.entries(rest)
      .filter(([, v]) => v !== undefined && typeof v !== "object")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const stamp = typeof time === "number" ? new Date(time).toISOString() : String(time);
    console.log(`${stamp.slice(0, 19)}  ${String(type).padEnd(10)} [${command}] ${detail}`);
  }
}

async function sync(ctx: Context) {
  const fills = await syncFills(ctx);
  const funding = await syncFunding(ctx);
  const swaps = await syncSwaps(ctx);
  console.log(`Synced ${fills} fills, ${funding.payments} funding payments, ${funding.rates} funding rates, ${swaps} swaps`);
}

async function snapshot(ctx: Context) {
  const { alerts } = await checkPosition(ctx);
  console.log(formatReport(await buildCurrentReport(ctx)));
  if (alerts.length) {
    console.log("\nAlerts");
    for (const a of alerts) console.log(`  [${a.level}] ${a.message}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const go = argv.includes("--go");
  const [command, ...args] = argv.filter((a) => a !== "--go");
  initLogging(command ?? "help");
  logEvent("command", { args: argv });
  if (command === "logs") return printEvents(Number(args[0]) || 30);
  if (command === "market") return market();
  if (command === "routes") return routes(args[0], args[1]);
  if (!command || command === "help") return console.log(USAGE);

  const ctx = createContext();
  const trading = () => (go ? createTradingContext(ctx) : undefined);
  const amountArg = (required: boolean) => {
    const amount = args[0] === undefined ? undefined : Number(args[0]);
    if ((required && amount === undefined) || (amount !== undefined && !(amount > 0))) {
      throw new Error(`${command} needs a positive USD amount`);
    }
    return amount;
  };

  switch (command) {
    case "pause":
      pause(ctx.store, args.join(" ") || "paused by hand");
      return console.log("Auto-rebalance paused. Watching and alerts continue.");
    case "resume":
      resume(ctx.store);
      return console.log("Auto-rebalance resumed.");
    case "rebalance": {
      const t = trading();
      const result = await rebalance(ctx, t);
      if (t && result.executed) await maintainStop(t);
      return;
    }
    case "cancel-orders": {
      const orders = await ctx.perps.openOrders();
      if (!orders.length) return console.log("No open orders.");
      for (const o of orders) {
        const price = o.triggerPrice ? ` trigger $${o.triggerPrice}` : o.price ? ` @ $${o.price}` : "";
        console.log(`  ${o.orderId}  ${o.market} ${o.type} ${o.side} ${o.qty}${price}`);
      }
      const t = trading();
      if (!t) return console.log(`\nDry run. Add --go to cancel these ${orders.length} order(s), including any protective stop.`);
      await t.trader.cancelOrders(orders.map((o) => o.orderId));
      logEvent("order", { purpose: "cancel-all", orderIds: orders.map((o) => o.orderId) });
      return console.log(`Cancelled ${orders.length} order(s).`);
    }
    case "protect": {
      const t = trading();
      if (!t) return console.log("Dry run. Add --go to place or refresh the protective stop on the exchange.");
      const stop = await maintainStop(t);
      return console.log(stop ? `Stop in force: buy ${stop.qty.toFixed(3)} ETH if index ≥ $${stop.triggerPrice}` : "No short, so no stop (any old stops were cancelled).");
    }
    case "exit":
      return exit(ctx, trading());
    case "hedge": {
      const t = trading();
      if (!t) return console.log("Dry run. Add --go to resize the short.");
      const qty = await hedge(t);
      return console.log(qty ? "Short resized." : "Already matched.");
    }
    case "swap": {
      const [direction, amountText] = args;
      const amount = Number(amountText);
      if ((direction !== "buy" && direction !== "sell") || !(amount > 0)) throw new Error("Usage: swap buy <usdc> | swap sell <eth> [--go]");
      await routes(direction, amountText);
      const t = trading();
      if (!t) return console.log("\nDry run. Add --go to execute.");
      const result = await (direction === "buy" ? t.spot.buyEth(amount, execution.maxSlippageBps) : t.spot.sellEth(amount, execution.maxSlippageBps));
      await recordOwnSwap(ctx, result);
      const swap = (await ctx.store.swaps()).find((s) => s.txHash === result.hash);
      if (!swap) return console.log("Swap sent but not found in receipt logs");
      const price = swap.usdcAmount / swap.ethAmount;
      console.log(`Done: ${swap.direction} ${swap.ethAmount.toFixed(6)} vbETH for ${swap.usdcAmount.toFixed(2)} vbUSDC @ $${price.toFixed(2)}`);
      console.log(`  quoted ${result.quotedOut} (min ${result.minOut}), ref price $${swap.refPrice.toFixed(2)}, gas ${swap.gasEth.toFixed(8)} ETH`);
      return;
    }
    case "deposit":
    case "withdraw": {
      const amount = amountArg(true)!;
      const t = trading();
      if (!t) return console.log(`Dry run: would ${command} $${amount.toFixed(2)}. Add --go to execute.`);
      await (command === "deposit" ? t.trader.deposit(amount) : withdrawAndRecord(t, amount));
      return console.log(`${command === "deposit" ? "Deposit credited" : "Withdrawal submitted"}: $${amount.toFixed(2)}`);
    }
    case "snapshot":
      return snapshot(ctx);
    case "sync":
      return sync(ctx);
    case "costs": {
      const sizes = args.map(Number).filter((n) => n > 0);
      return costsReport(ctx, sizes.length ? sizes : DEFAULT_SIZES);
    }
    case "report":
      return console.log(formatReport(await buildCurrentReport(ctx)));
    case "watch":
      return watch(ctx);
    case "capital": {
      const amount = Number(args[0]);
      if (!Number.isFinite(amount) || amount === 0) throw new Error("capital needs a non-zero USD amount");
      await ctx.store.addCapital({ time: Date.now(), usd: amount, note: args.slice(1).join(" ") });
      return console.log(`Recorded ${amount > 0 ? "deposit" : "withdrawal"} of $${Math.abs(amount)}`);
    }
    case "log-swap": {
      const hash = args[0] as Hash | undefined;
      if (!hash?.startsWith("0x")) throw new Error("log-swap needs a transaction hash");
      const ok = await recordSwap(ctx, hash);
      return console.log(ok ? "Swap recorded" : "Not a vbUSDC/vbETH swap by this wallet");
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  logEvent("error", { message: err instanceof Error ? err.message : String(err) });
  // exitCode instead of exit(): exiting with sockets still open crashes libuv on Windows.
  process.exitCode = 1;
});
