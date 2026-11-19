import { basisPct, netDeltaEth, netDeltaPct, rallyToLiquidationPct, totalEquity, type Alert } from "@kdn/core";
import type { Context } from "./context";
import { pause, pauseState, resume, runsToday } from "./auto";
import { env, maxAutoRebalancesPerDay, riskCheckIntervalMs } from "./env";
import { buildCurrentReport, rebalanceTriggers } from "./jobs/report";
import { takeSnapshot } from "./jobs/snapshot";
import { logEvent } from "./log";

/** Shared between the watch loop and command replies, so /status can report on the loop. */
export const watchStatus = {
  startedAt: Date.now(),
  lastTickAt: 0,
  lastTickOk: true,
  lastError: "",
  lastAlerts: [] as Alert[],
  autoRebalance: false,
  lastRiskCheckAt: 0,
  leverage: null as number | null,
  stop: null as { triggerPrice: number; qty: number } | null,
};

const COMMANDS = [
  { command: "balance", description: "Live position and balances" },
  { command: "pnl", description: "PnL, funding earned, costs" },
  { command: "funding", description: "Funding rate and recent payments" },
  { command: "status", description: "Is the bot running and healthy" },
  { command: "pause", description: "Stop automatic rebalancing" },
  { command: "resume", description: "Allow automatic rebalancing again" },
  { command: "help", description: "List commands" },
];

const OFFSET_KEY = "telegramUpdateOffset";
const POLL_SECONDS = 50;

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`;
};

async function api(method: string, body: unknown, timeoutMs = 15_000): Promise<{ ok: boolean; result?: unknown; error_code?: number; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; error_code?: number; description?: string };
}

/** Sends a monospace block, so the columns line up on a phone. */
async function reply(title: string, lines: string[]) {
  const text = `<b>${escape(title)}</b>\n<pre>${escape(lines.join("\n"))}</pre>`;
  const res = await api("sendMessage", { chat_id: env.telegramChatId, text, parse_mode: "HTML" });
  if (!res.ok) console.error(`Telegram reply failed: ${res.description}`);
}

async function balance(ctx: Context) {
  const s = await takeSnapshot(ctx);
  const rally = rallyToLiquidationPct(s);
  const triggers = rebalanceTriggers(s);
  const delta = netDeltaPct(s);
  await reply("Position", [
    `Wallet vbUSDC  ${usd(s.walletUsdc)}`,
    `Spot vbETH     ${s.spotEth.toFixed(4)} (${usd(s.spotEth * s.indexPrice)})`,
    `Perp margin    ${usd(s.perpEquity)}`,
    `Short          ${(-s.perpQty).toFixed(4)} ETH${s.perpQty < 0 ? ` @ ${usd(s.perpEntryPrice)}` : ""}`,
    `Net delta      ${netDeltaEth(s).toFixed(4)} ETH${Number.isFinite(delta) ? ` (${delta.toFixed(2)}%)` : ""}`,
    `Leverage       ${s.perpLeverage.toFixed(2)}x`,
    `Liquidation    ${s.liquidationPrice > 0 ? `${usd(s.liquidationPrice)}${rally === null ? "" : ` (+${rally.toFixed(1)}%)`}` : "—"}`,
    ...(triggers
      ? [
          `Rebalance at   ≤ ${usd(triggers.low)} (${triggers.lowPct.toFixed(1)}%)`,
          `            or ≥ ${usd(triggers.high)} (+${triggers.highPct.toFixed(1)}%)`,
        ]
      : []),
    `Total value    ${usd(totalEquity(s))}`,
    ``,
    `ETH index ${usd(s.indexPrice)}  Sushi basis ${basisPct(s).toFixed(3)}%`,
    `Gas ${s.gasEth.toFixed(5)} ETH`,
  ]);
}

async function pnl(ctx: Context) {
  const r = await buildCurrentReport(ctx);
  const c = r.costs;
  await reply(`PnL — day ${r.days.toFixed(1)}`, [
    `Capital in     ${usd(r.netCapital)}`,
    `Value now      ${usd(r.equity)}`,
    `PnL            ${usd(r.pnl)}`,
    `After exit     ${usd(r.pnlAfterExit)}`,
    ``,
    `Funding        ${usd(r.funding.realized)} of ${usd(r.funding.expected)} expected`,
    `Settlements    ${r.funding.settlements} (${r.funding.missed} missed)`,
    `APR on capital ${r.funding.aprOnCapital.toFixed(2)}%`,
    ``,
    `Costs          ${usd(c.total)} (${c.bps.toFixed(1)} bps of ${usd(c.tradedUsd)})`,
    `  swaps ${usd(c.swapPoolFees + c.swapImpact)}  perp ${usd(c.perpFees + c.perpSlippage)}`,
    `  gas ${usd(c.gas)}  withdrawals ${usd(c.withdrawalFees)}`,
    ...(r.netCapital === 0 ? ["", "Tip: record capital with `capital <usd>`"] : []),
  ]);
}

async function funding(ctx: Context) {
  const m = await ctx.perps.market();
  const payments = (await ctx.store.fundingPayments()).slice(-5).reverse();
  const minutes = Math.max(0, Math.round((m.nextFundingTime - Date.now()) / 60_000));
  await reply("Funding", [
    `Current rate   ${(m.currentFundingRate * 100).toFixed(4)}% / 8h`,
    `Annualized     ${(m.currentFundingRate * 3 * 365 * 100).toFixed(2)}%`,
    `Next payment   in ${Math.floor(minutes / 60)}h ${minutes % 60}m`,
    ``,
    payments.length ? "Recent payments" : "No payments yet",
    ...payments.map((p) => `${new Date(p.time).toISOString().slice(5, 16).replace("T", " ")}  ${usd(p.paymentUsd).padStart(8)}  ${(p.rate * 100).toFixed(4)}%`),
  ]);
}

async function status(ctx: Context) {
  const s = watchStatus;
  const paused = pauseState(ctx.store);
  const auto = !s.autoRebalance ? "off" : paused ? `PAUSED (${paused.reason.slice(0, 80)})` : "ON";
  await reply("Bot status", [
    `Running since  ${new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Last check     ${s.lastTickAt ? ago(s.lastTickAt) : "not yet"} — ${s.lastTickOk ? "ok" : "FAILED"}`,
    ...(s.lastTickOk ? [] : [`Error          ${s.lastError.slice(0, 120)}`]),
    `Risk check     ${s.lastRiskCheckAt ? ago(s.lastRiskCheckAt) : "not yet"} (every ${riskCheckIntervalMs / 1000}s)`,
    `Full check     every ${env.watchIntervalMs / 60_000} min`,
    `Leverage       ${s.leverage === null ? "no position" : `${s.leverage.toFixed(2)}x`}`,
    `Stop on exch.  ${s.stop ? `buy ${s.stop.qty.toFixed(3)} ETH at $${s.stop.triggerPrice}` : "none"}`,
    `Auto-rebalance ${auto}`,
    `Rebalances 24h ${runsToday(ctx.store).length} of ${maxAutoRebalancesPerDay} max`,
    `Active alerts  ${s.lastAlerts.length ? s.lastAlerts.map((a) => a.code).join(", ") : "none"}`,
  ]);
}

async function handle(ctx: Context, text: string) {
  const command = text.trim().split(/\s+/)[0]!.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  logEvent("command", { via: "telegram", command });
  switch (command) {
    case "balance":
    case "position":
      return balance(ctx);
    case "pnl":
      return pnl(ctx);
    case "funding":
      return funding(ctx);
    case "status":
      return status(ctx);
    case "pause":
      pause(ctx.store, "paused from Telegram");
      return reply("Auto-rebalance paused", ["Watching and alerts continue.", "Send /resume to allow trades again."]);
    case "resume":
      resume(ctx.store);
      return reply("Auto-rebalance resumed", [
        watchStatus.autoRebalance ? "Next check may trade if the position is out of its bands." : "Note: AUTO_REBALANCE is off in .env, so nothing trades automatically.",
      ]);
    default:
      return reply("Commands", COMMANDS.map((c) => `/${c.command.padEnd(8)} ${c.description}`));
  }
}

/**
 * Long-polls Telegram for commands and answers them. Only messages from TELEGRAM_CHAT_ID are
 * answered, and every command is read-only: nothing can trade through Telegram.
 */
export async function runTelegramCommands(ctx: Context): Promise<void> {
  if (!env.telegramToken || !env.telegramChatId) return;
  await api("setMyCommands", { commands: COMMANDS }).catch(() => {});

  let offset = Number(ctx.store.getMeta(OFFSET_KEY) ?? 0);
  for (;;) {
    try {
      const res = await api("getUpdates", { offset, timeout: POLL_SECONDS, allowed_updates: ["message"] }, (POLL_SECONDS + 15) * 1000);
      if (!res.ok) {
        // 409: something else is reading this bot's updates (another poller or a webhook).
        console.error(`Telegram getUpdates failed (${res.error_code}): ${res.description}`);
        await new Promise((r) => setTimeout(r, 30_000));
        continue;
      }
      for (const update of res.result as { update_id: number; message?: { chat: { id: number }; text?: string } }[]) {
        offset = update.update_id + 1;
        ctx.store.setMeta(OFFSET_KEY, String(offset));
        const message = update.message;
        if (!message?.text?.startsWith("/") || String(message.chat.id) !== String(env.telegramChatId)) continue;
        await handle(ctx, message.text).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Telegram command failed: ${msg}`);
          await reply("Error", [msg.slice(0, 300)]).catch(() => {});
        });
      }
    } catch {
      // Network hiccup or timeout: try again shortly.
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
