import type { Context } from "./context";
import type { SqliteStore } from "./db";
import { maxAutoRebalancesPerDay, strategy } from "./env";
import { RebalanceBlocked, rebalance } from "./jobs/execute";
import { logEvent } from "./log";
import { send } from "./notify";
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

export function pauseState(store: SqliteStore): PauseState | undefined {
  const raw = store.getMeta(PAUSED_KEY);
  return raw ? (JSON.parse(raw) as PauseState) : undefined;
}

export function pause(store: SqliteStore, reason: string) {
  store.setMeta(PAUSED_KEY, JSON.stringify({ reason, time: Date.now() }));
  logEvent("rebalance", { phase: "paused", reason });
}

export function resume(store: SqliteStore) {
  store.setMeta(PAUSED_KEY, "");
  logEvent("rebalance", { phase: "resumed" });
}

/** Times of executed automatic rebalances in the last 24 hours. */
export function runsToday(store: SqliteStore): number[] {
  const raw = store.getMeta(RUNS_KEY);
  const runs = raw ? (JSON.parse(raw) as number[]) : [];
  return runs.filter((t) => Date.now() - t < DAY);
}

/**
 * One automatic rebalance attempt. Pauses automation (and says why on Telegram) when a
 * rebalance fails partway or the daily cap is reached; a blocked pre-check only alerts.
 */
export async function autoRebalanceTick(ctx: Context, trading: TradingContext): Promise<void> {
  const { store } = ctx;
  if (pauseState(store)) return;

  const runs = runsToday(store);
  if (runs.length >= maxAutoRebalancesPerDay) {
    const reason = `${runs.length} automatic rebalances in 24h (cap ${maxAutoRebalancesPerDay})`;
    pause(store, reason);
    await send(`⏸ Auto-rebalance paused: ${reason}. Something may be churning. Check /balance, then /resume.`);
    return;
  }

  try {
    const result = await rebalance(ctx, trading, { quiet: true });
    if (!result.executed) return;
    if (!result.traded) {
      // Nothing changed (e.g. no vbUSDC to buy with). Not a run toward the cap, or a plan that can't
      // move would pause the bot after a few ticks; alert instead and keep trying each tick.
      const last = store.lastAlertTime("REBALANCE_STUCK");
      if (last === undefined || Date.now() - last > BLOCKED_ALERT_EVERY) {
        await send(`⚠️ Rebalance needed but nothing could be traded (${result.plan.reasons.join("; ")}): ${result.log.join(", ") || "no steps ran"}`);
        store.markAlertSent("REBALANCE_STUCK", Date.now());
      }
      return;
    }
    store.setMeta(RUNS_KEY, JSON.stringify([...runs, Date.now()]));
    const summary = `(${result.plan.reasons.join("; ")}): ${result.log.join(", ") || "no trades needed"}`;
    const apart = Math.abs(result.legsApartPct ?? 0);
    if (apart > strategy.deltaBandPct) {
      // Not paused: the next check plans a fix for the gap. This says the rebalance did not finish the job.
      await send(`🚨 Rebalanced but legs are ${Number.isFinite(apart) ? `${apart.toFixed(1)}%` : "fully"} apart ${summary}`);
    } else {
      await send(`🔁 Rebalanced ${summary}`);
    }
  } catch (err) {
    if (err instanceof RebalanceBlocked) {
      const last = store.lastAlertTime("REBALANCE_BLOCKED");
      if (last === undefined || Date.now() - last > BLOCKED_ALERT_EVERY) {
        await send(`⚠️ Rebalance needed but blocked:\n- ${err.problems.join("\n- ")}`);
        store.markAlertSent("REBALANCE_BLOCKED", Date.now());
      }
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    pause(store, `rebalance failed: ${message}`);
    await send(`⏸ Auto-rebalance paused after a failed rebalance:\n${message.slice(0, 400)}\n\nCheck /balance, then /resume.`);
  }
}
