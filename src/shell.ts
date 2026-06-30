/**
 * shell.ts — Defensive subprocess wrapper for cross-repo-deep-analysis-engine.
 *
 * Public API
 * ----------
 * run(cmd, opts)        -> RunResult
 * requireBinary(name)   -> void (throws on missing)
 * ShellError            -> error class
 *
 * Rules enforced (never relaxed)
 * -------------------------------
 * - A shell is NEVER spawned. `spawnSync` is called with `shell: false`
 *   (the default) and an explicit argv array — no string interpolation into a
 *   shell, so command injection is structurally impossible.
 * - cmd must be a non-empty string array.
 * - cwd must exist on the filesystem when supplied.
 * - stdout and stderr are captured AND echoed with per-stream prefixes.
 * - A non-zero exit throws ShellError unless the code is in allowNonzeroCodes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, accessSync, constants } from "node:fs";
import * as path from "node:path";

import { getLogger } from "./loggingSetup.js";

const log = getLogger("shell");

export class ShellError extends Error {
  readonly cmd: string[];
  readonly returncode: number;
  readonly stderr: string;

  constructor(cmd: string[], returncode: number, stderr: string) {
    super(`Command ${JSON.stringify(cmd)} exited with code ${returncode}.\nstderr:\n${stderr}`);
    this.name = "ShellError";
    this.cmd = cmd;
    this.returncode = returncode;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  cwd?: string;
  /** Extra environment variables (merged over process.env). */
  env?: Record<string, string>;
  /** Exit codes treated as success (e.g. [1] for grep). */
  allowNonzeroCodes?: number[];
  /** Seconds before the subprocess is killed (default 300 s). */
  timeout?: number;
}

export interface RunResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

/** Fail loudly if *name* is not available on PATH. */
export function requireBinary(name: string): void {
  if (!which(name)) {
    throw new Error(`Required binary '${name}' not found on PATH. Install it and re-run.`);
  }
}

/** Minimal cross-platform `which`: scan PATH for an executable named *name*. */
function which(name: string): string | null {
  // Absolute / relative path supplied directly.
  if (name.includes(path.sep)) {
    return isExecutable(name) ? name : null;
  }
  const pathEnv = process.env.PATH || "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) {
      return false;
    }
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run *cmd* defensively and return the result.
 *
 * @throws Error      if cmd is empty, or cwd does not exist.
 * @throws ShellError if the exit code is non-zero and not in allowNonzeroCodes.
 */
export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  if (!Array.isArray(cmd) || cmd.length === 0) {
    throw new Error("cmd must be a non-empty array of strings");
  }

  const { cwd, env, allowNonzeroCodes = [], timeout = 300 } = opts;

  if (cwd !== undefined && !existsSync(cwd)) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }

  const mergedEnv = env ? { ...process.env, ...env } : undefined;

  // Dual logging: structured INFO + visible console.log.
  log.info("$ %s", cmd.join(" "));
  console.log(`$ ${cmd.join(" ")}`);

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    env: mergedEnv,
    encoding: "utf-8",
    timeout: timeout * 1000,
    // shell is INTENTIONALLY left false (the default) — never set it true.
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });

  // spawnSync sets `.error` on failure to launch (ENOENT, ETIMEDOUT, ...).
  if (result.error) {
    throw new ShellError(cmd, result.status ?? -1, String(result.error.message ?? result.error));
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  for (const line of stdout.split("\n")) {
    if (line) {
      log.debug("[stdout] %s", line);
      console.log(`  [stdout] ${line}`);
    }
  }
  for (const line of stderr.split("\n")) {
    if (line) {
      log.debug("[stderr] %s", line);
      console.log(`  [stderr] ${line}`);
    }
  }

  const code = result.status ?? -1;
  if (code !== 0 && !allowNonzeroCodes.includes(code)) {
    throw new ShellError(cmd, code, stderr);
  }

  return { returncode: code, stdout, stderr };
}
