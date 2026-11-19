import type { Alert } from "@kdn/core";
import { logEvent } from "@kdn/bot/log";
import { env } from "./env";
import type { WbtcStore } from "./store";

/** Don't repeat the same alert more often than this. Kill alerts repeat faster. */
const REPEAT_MS = { warn: 60 * 60_000, urgent: 15 * 60_000, kill: 15 * 60_000 };

/** Send-only: the ETH bot owns the Telegram commands, so this instance never polls for updates. */
export async function send(text: string): Promise<void> {
  console.log(text);
  if (!env.telegramToken || !env.telegramChatId) return;
  const res = await fetch(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.telegramChatId, text: env.telegramPrefix ? `${env.telegramPrefix} ${text}` : text }),
  });
  if (!res.ok) console.error(`Telegram send failed: ${res.status} ${await res.text()}`);
}

export async function dispatchAlerts(store: WbtcStore, alerts: Alert[], now = Date.now()): Promise<void> {
  for (const a of alerts) {
    const last = store.lastAlertTime(a.code);
    if (last !== undefined && now - last < REPEAT_MS[a.level]) continue;
    await send(`${a.level === "kill" ? "🛑" : a.level === "urgent" ? "🚨" : "⚠️"} ${a.message}`);
    logEvent("alert", { ...a });
    store.markAlertSent(a.code, now);
  }
}
