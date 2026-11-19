import { carryYield, fundingApr } from "@kdn/core";
import { initLogging, logEvent, recentEvents } from "@kdn/bot/log";
import { pause, pauseState, resume } from "./auto";
import { createAccountContext, createContext } from "./context";
import { carry, env } from "./env";
import { currentPlan, deposit, exit, hedge, printState, rebalance, withdrawBtc } from "./jobs/execute";
import { maintainStop } from "./jobs/protect";
import { positionReport, trackerReport } from "./jobs/report";
import { checkPosition, syncFunding, syncRates } from "./jobs/state";
import { formatObservation, observe } from "./jobs/track";
import { watch } from "./jobs/watch";
import { createTradingContext } from "./wallet";

const USAGE = `Usage: npm run wbtc -- <command>     (settings in .env.wbtc, never the ETH bot's .env)

No wallet needed
  track                  One market reading: funding, Morpho borrow rate, Sushi cost of the slice, model yield
  model                  Yield for configs A/B/C at today's rates and at the tracker's averages
  report                 Tracker summary, plus the position and H1–H7 once a deposit is recorded
  watch                  Loop: tracker every TRACK_INTERVAL_MIN; with a wallet also the position checks
  logs [n]               Last n logged actions

Position (WALLET_ADDRESS + read-only Katana Perps key)
  status                 Holdings, LTV, perp leverage, distances to liquidation, and the plan (no trades)
  sync                   Pull funding payments, fills and funding rates
  pause [reason]         Stop automatic rebalancing (watching and alerts continue)
  resume                 Allow automatic rebalancing again

Trading (needs WALLET_PRIVATE_KEY; dry run unless --go is passed)
  deposit <btc> [--go]          Supply wallet vbWBTC to Morpho and add it to the target net BTC
  rebalance [--go]              Plan from live holdings and execute (entry, margin moves, resize, ladder)
  hedge [--go]                  Resize the BTC-USD short to the slice
  protect [--go]                Place/refresh the reduce-only stop (STOP_BELOW_LIQ_PCT under liquidation)
  cancel-orders [--go]          List open perp orders; cancel them all with --go
  exit [--go]                   Unwind the slice (close short, sell slice, repay); the deposit stays on Morpho
  withdraw-btc <btc|all> [--go] After exit: take collateral back to the wallet`;

async function model(ctx: ReturnType<typeof createContext>) {
  const o = await observe(ctx);
  const obs = ctx.store.observations();
  const avgBorrow = obs.reduce((s, x) => s + x.borrowApy, 0) / obs.length;
  const avgFunding = obs.reduce((s, x) => s + x.fundingRate, 0) / obs.length;
  const configs = [
    ["A", 0.4, 3.3],
    ["B", 0.5, 2.5],
    ["C", 0.4, 2.5],
    ["env", carry.targetLtv, carry.targetPerpLeverage],
  ] as const;
  const p = (n: number) => `${(n * 100).toFixed(2)}%`.padStart(7);
  console.log(`Funding now ${p(fundingApr(o.fundingRate))} APR, borrow now ${p(o.borrowApy)};  tracker averages (${obs.length} readings): funding ${p(fundingApr(avgFunding))}, borrow ${p(avgBorrow)}`);
  console.log("Config   LTV   perp   slice   debt    now    avg  break-even");
  for (const [name, l, k] of configs) {
    const now = carryYield(l, k, fundingApr(o.fundingRate), o.borrowApy);
    const avg = carryYield(l, k, fundingApr(avgFunding), avgBorrow);
    console.log(
      `${name.padEnd(6)} ${(l * 100).toFixed(0).padStart(4)}% ${k.toFixed(1).padStart(5)}x ${p(now.sliceFraction)} ${p(now.debtFraction)} ${p(now.netYield)} ${p(avg.netYield)} ${p(now.breakEvenBorrowApy)}`,
    );
  }
  console.log("Yield = more BTC per year as a share of the deposit, before one-off entry/exit costs.");
}

function printEvents(count: number) {
  const events = recentEvents(Infinity).filter((e) => e.type !== "command" && e.type !== "observation").slice(-count);
  if (!events.length) return console.log("No trades, transfers or alerts logged yet.");
  for (const e of events) {
    const { time, type, command, ...rest } = e;
    const detail = Object.entries(rest)
      .filter(([, v]) => v !== undefined && typeof v !== "object")
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`${String(time).slice(0, 19)}  ${String(type).padEnd(10)} [${command}] ${detail}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const go = argv.includes("--go");
  const [command, ...args] = argv.filter((a) => a !== "--go");
  initLogging(`wbtc:${command ?? "help"}`);
  logEvent("command", { args: argv });
  if (!command || command === "help") return console.log(USAGE);
  if (command === "logs") return printEvents(Number(args[0]) || 30);

  const ctx = createContext();
  switch (command) {
    case "track": {
      await syncRates(ctx);
      return console.log(formatObservation(await observe(ctx)));
    }
    case "model":
      return model(ctx);
    case "report": {
      console.log(trackerReport(ctx.store));
      if (!env.wallet) return;
      const account = createAccountContext(ctx);
      await syncFunding(account);
      await checkPosition(account);
      const paused = pauseState(ctx.store);
      console.log(`\n${positionReport(ctx.store)}${paused ? `\n\nAuto-rebalance PAUSED: ${paused.reason}` : ""}`);
      return;
    }
    case "watch":
      return watch(ctx);
  }

  const account = createAccountContext(ctx);
  const trading = () => (go ? createTradingContext(account) : undefined);
  switch (command) {
    case "status": {
      const { state, plan } = await currentPlan(account);
      return printState(state, plan);
    }
    case "sync": {
      const r = await syncFunding(account);
      return console.log(`Synced ${r.payments} funding payments, ${r.fills} fills, ${r.rates} funding rates`);
    }
    case "pause":
      pause(ctx.store, args.join(" ") || "paused by hand");
      return console.log("Auto-rebalance paused. Watching and alerts continue.");
    case "resume":
      resume(ctx.store);
      return console.log("Auto-rebalance resumed.");
    case "deposit": {
      const amount = Number(args[0]);
      if (!(amount > 0)) throw new Error("deposit needs a positive BTC amount");
      return deposit(account, trading(), amount);
    }
    case "rebalance": {
      const t = trading();
      const result = await rebalance(account, t);
      if (t && result.executed) await maintainStop(t);
      return;
    }
    case "hedge": {
      const t = trading();
      if (!t) return console.log("Dry run. Add --go to resize the short.");
      return console.log((await hedge(t)) ? "Short resized." : "Already matched.");
    }
    case "protect": {
      const t = trading();
      if (!t) return console.log("Dry run. Add --go to place or refresh the protective stop.");
      const stop = await maintainStop(t);
      return console.log(stop ? `Stop in force: buy ${stop.qty.toFixed(4)} BTC if index ≥ $${stop.triggerPrice}` : "No short, so no stop.");
    }
    case "cancel-orders": {
      const orders = await account.perps.openOrders();
      if (!orders.length) return console.log("No open orders.");
      for (const o of orders) console.log(`  ${o.orderId}  ${o.market} ${o.type} ${o.side} ${o.qty}${o.triggerPrice ? ` trigger $${o.triggerPrice}` : ""}`);
      const t = trading();
      if (!t) return console.log(`\nDry run. Add --go to cancel these ${orders.length} order(s), including any protective stop.`);
      await t.trader.cancelOrders(orders.map((o) => o.orderId));
      logEvent("order", { purpose: "cancel-all", orderIds: orders.map((o) => o.orderId) });
      return console.log(`Cancelled ${orders.length} order(s).`);
    }
    case "exit": {
      const t = trading();
      await exit(account, t);
      if (t) await maintainStop(t);
      return;
    }
    case "withdraw-btc":
      if (!args[0]) throw new Error('withdraw-btc needs a BTC amount or "all"');
      return withdrawBtc(account, trading(), args[0]);
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  // Message only: SDK errors carry request headers, including the API key.
  console.error(err instanceof Error ? err.message : err);
  logEvent("error", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
