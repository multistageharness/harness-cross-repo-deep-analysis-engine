/**
 * loggingSetup.ts — idempotent logging configuration.
 *
 * Per the repo's logging convention: every node must emit BOTH structured
 * stdlib-style logging AND inline `console.log()` debug statements at
 * boundaries. This module provides the structured side (a printf-style logger
 * mirroring Python's `logging`); nodes use `console.log(...)` directly for the
 * inline `print()` equivalent.
 */

import { format } from "node:util";

const SEP = "=".repeat(72);

const LEVELS: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  WARN: 30,
  ERROR: 40,
};

let configured = false;
let threshold = LEVELS.INFO;

/** Idempotent. Reads LOG_LEVEL from the environment. Safe to call repeatedly. */
export function configureLogging(): void {
  if (configured) {
    return;
  }
  const levelName = (process.env.LOG_LEVEL || "INFO").toUpperCase();
  threshold = LEVELS[levelName] ?? LEVELS.INFO;
  configured = true;
}

function emit(level: string, name: string, msg: string, args: unknown[]): void {
  configureLogging();
  if ((LEVELS[level] ?? LEVELS.INFO) < threshold) {
    return;
  }
  const ts = new Date().toISOString().slice(0, 19) + "Z";
  const body = args.length ? format(msg, ...args) : msg;
  const line = `${ts} [${level}] ${name} -- ${body}`;
  if ((LEVELS[level] ?? 0) >= LEVELS.ERROR) {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  /** Mirrors Python `log.exception` — logs at ERROR level. */
  exception(msg: string, ...args: unknown[]): void;
}

/** Return a module-level logger, ensuring logging is configured. */
export function getLogger(name: string): Logger {
  configureLogging();
  return {
    debug: (msg, ...args) => emit("DEBUG", name, msg, args),
    info: (msg, ...args) => emit("INFO", name, msg, args),
    warning: (msg, ...args) => emit("WARNING", name, msg, args),
    error: (msg, ...args) => emit("ERROR", name, msg, args),
    exception: (msg, ...args) => emit("ERROR", name, msg, args),
  };
}

/**
 * Print and log a visible section separator at every node boundary.
 * Uses BOTH structured logging (INFO) and `console.log()` — required by repo
 * convention.
 */
export function banner(title: string): void {
  const msg = `\n${SEP}\n  ${title}\n${SEP}`;
  console.log(msg);
  getLogger("banner").info(title);
}
