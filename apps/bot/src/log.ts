import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

/** Read on use, so an app that loads its own env file after importing this still logs to its LOG_DIR. */
const logDir = () => process.env.LOG_DIR || "data/logs";

let command = "bot";

function day(time = new Date()): string {
  return time.toISOString().slice(0, 10);
}

function append(file: string, line: string) {
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(join(logDir(), file), line + "\n");
  } catch {
    // Logging must never break trading.
  }
}

/**
 * Mirrors console output to data/logs/YYYY-MM-DD.log with a timestamp and the command name,
 * so every run leaves a record of what it printed.
 */
export function initLogging(name: string) {
  command = name;
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const stamp = new Date().toISOString();
      const tag = level === "log" ? "" : ` ${level.toUpperCase()}`;
      for (const line of format(...args).split("\n")) append(`${day()}.log`, `${stamp} [${command}]${tag} ${line}`);
    };
  }
}

export type EventType =
  | "command"
  | "tx"
  | "order"
  | "swap"
  | "deposit"
  | "withdrawal"
  | "rebalance"
  | "alert"
  | "morpho"
  | "observation"
  | "error";

/** One JSON line per action in data/logs/events-YYYY-MM-DD.jsonl. */
export function logEvent(type: EventType, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), command, type, ...data }, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  append(`events-${day()}.jsonl`, line);
}

/** The last `count` events, newest last, across today's and yesterday's files. */
export function recentEvents(count: number): Record<string, unknown>[] {
  const yesterday = new Date(Date.now() - 86_400_000);
  const lines: string[] = [];
  for (const d of [day(yesterday), day()]) {
    const file = join(logDir(), `events-${d}.jsonl`);
    if (existsSync(file)) lines.push(...readFileSync(file, "utf8").split("\n").filter(Boolean));
  }
  return lines.slice(-count).map((l) => JSON.parse(l) as Record<string, unknown>);
}
