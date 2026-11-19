import { logEvent } from "@kdn/bot/log";
import type { AccountContext } from "./context";
import { maxAutoRebalancesPerDay } from "./env";
import { RebalanceBlocked, rebalance } from "./jobs/execute";
import { send } from "./notify";
import type { WbtcStore } from "./store";
import type { TradingContext } from "./wallet";

const PAUSED_KEY = "autoRebalancePaused";
const RUNS_KEY = "autoRebalanceRuns";
const DAY = 86_400_000;
/** Blocked pre-checks are re-announced at most this often. */
const BLOCKED_ALERT_EVERY = 60 * 60_000;

export interface PauseState {
  reason: string;
  time: number;
}

export function pauseState(store: WbtcStore): PauseState | undefined {
  const raw = store.getMeta(PAUSED_KEY);
  return raw ? (JSON.parse(raw) as PauseState) : undefined;
}

export function pause(store: WbtcStore, reason: string) {
  store.setMeta(PAUSED_KEY, JSON.stringify({ reason, time: Date.now() }));
  logEvent("rebalance", { phase: "paused", reason });
}

export function resume(store: WbtcStore) {
  store.setMeta(PAUSED_KEY, "");
  logEvent("rebalance", { phase: "resumed" });
}

function runsToday(store: WbtcStore): number[] {
  const raw = store.getMeta(RUNS_KEY);
  return (raw ? (JSON.parse(raw) as number[]) : []).filter((t) => Date.now() - t < DAY);
}

async function announceBlocked(store: WbtcStore, problems: string[]) {
  const last = store.lastAlertTime("REBALANCE_BLOCKED");
  if (last !== undefined && Date.now() - last < BLOCKED_ALERT_EVERY) return;
  await send(`⚠️ Rebalance needed but blocked:\n- ${problems.join("\n- ")}`);
  store.markAlertSent("REBALANCE_BLOCKED", Date.now());
}

/**
 * One automatic rebalance attempt. A failure after something was sent pauses automation, since the
 * position may be half-moved. A failure before anything was sent (a flaky read, a blocked pre-check)
 * only alerts and is retried on the next check.
 */
export async function autoRebalanceTick(ctx: AccountContext, trading: TradingContext): Promise<void> {
  const { store } = ctx;
  if (pauseState(store)) return;

  const runs = runsToday(store);
  if (runs.length >= maxAutoRebalancesPerDay) {
    const reason = `${runs.length} automatic rebalances in 24h (cap ${maxAutoRebalancesPerDay})`;
    pause(store, reason);
    await send(`⏸ Auto-rebalance paused: ${reason}. Something may be churning. Check \`report\`, then \`resume\`.`);
    return;
  }

  const sentBefore = trading.actions.count;
  try {
    const result = await rebalance(ctx, trading, { quiet: true });
    if (!result.executed) return;
    store.setMeta(RUNS_KEY, JSON.stringify([...runs, Date.now()]));
    const icon = result.plan.urgency === "emergency" ? "🚨" : "🔁";
    await send(`${icon} Rebalanced (${result.plan.reasons.join("; ")}): ${result.log.join(", ") || "no trades needed"}`);
  } catch (err) {
    if (err instanceof RebalanceBlocked) return announceBlocked(store, err.problems);
    const message = err instanceof Error ? err.message : String(err);
    if (trading.actions.count === sentBefore) {
      logEvent("error", { where: "auto", message, sent: 0 });
      return announceBlocked(store, [`failed before sending anything (will retry): ${message.slice(0, 300)}`]);
    }
    pause(store, `rebalance failed: ${message}`);
    await send(`⏸ Auto-rebalance paused after a failed rebalance (part of it was sent):\n${message.slice(0, 400)}\n\nCheck \`report\`, then \`resume\`.`);
  }
}
