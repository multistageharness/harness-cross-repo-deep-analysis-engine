/**
 * main.ts — CLI entrypoint for cross-repo-deep-analysis-engine (Node/TS).
 *
 * Usage
 * -----
 *   tsx src/main.ts                         # reads repos.yaml from cwd
 *   REPOS_FILE=my-repos.json tsx src/main.ts
 *   DRY_RUN=1 tsx src/main.ts               # preview only; no clone, no LLM
 *   tsx src/main.ts --overwrite             # on-exist policy (see below)
 *   tsx src/main.ts --on-exist=continue     # equivalent long form
 *
 * On-exist policy (when .harness/<name>/ already exists)
 * ------------------------------------------------------
 *   --skip / --continue / --overwrite, or --on-exist=<skip|continue|overwrite|prompt>
 *   Precedence: CLI flag > ON_EXIST env var > "prompt" (interactive default).
 *
 * Exit codes
 * ----------
 *   0 — pipeline completed with no errors logged
 *   1 — graph execution failed, or one or more clone errors were logged
 *   2 — configuration error (missing repos file)
 *
 * LLM auth
 * --------
 * LLM nodes 5/6 go through the vendored `llm-sdk-github-copilot` harness, which
 * drives the GitHub Copilot runtime. Auth is the Copilot CLI's own (a prior
 * `copilot` login, or COPILOT_CLI_PATH / a GitHub token the runtime picks up) —
 * there is no ANTHROPIC_API_KEY requirement. An unauthenticated runtime surfaces
 * its own error at first LLM call.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";

import { GITHUB_BASE_HOST } from "../constant.mjs";
import { buildGraph } from "./graph.js";
import { shutdownChat } from "./llm.js";
import { banner, configureLogging, getLogger } from "./loggingSetup.js";
import type { WorkflowState } from "./state.js";

loadDotenv();
configureLogging();
const log = getLogger("main");

const VALID_POLICIES = new Set(["prompt", "skip", "continue", "overwrite"]);

/**
 * Resolve the on-exist collision policy.
 * Precedence: CLI flag > ON_EXIST env var > "prompt".
 * Accepts --skip / --continue / --overwrite or --on-exist=<value>.
 */
function resolveOnExistPolicy(argv: string[]): string {
  const flagMap: Record<string, string> = {
    "--skip": "skip",
    "--continue": "continue",
    "--overwrite": "overwrite",
    "--prompt": "prompt",
  };
  for (const arg of argv) {
    if (arg in flagMap) {
      return flagMap[arg];
    }
    if (arg.startsWith("--on-exist=")) {
      const val = arg.split("=", 2)[1].trim().toLowerCase();
      if (VALID_POLICIES.has(val)) {
        return val;
      }
      process.stderr.write(`[main] WARNING: invalid --on-exist value ${JSON.stringify(val)}; using 'prompt'.\n`);
      return "prompt";
    }
  }

  const envVal = (process.env.ON_EXIST || "").trim().toLowerCase();
  if (VALID_POLICIES.has(envVal)) {
    return envVal;
  }
  if (envVal) {
    process.stderr.write(`[main] WARNING: invalid ON_EXIST value ${JSON.stringify(envVal)}; using 'prompt'.\n`);
  }
  return "prompt";
}

async function main(): Promise<void> {
  banner("cross-repo-deep-analysis-engine -- START");

  // LLM nodes 5/6 authenticate through the Copilot runtime (see file header) —
  // no provider API key is required here.

  const reposFile = (process.env.REPOS_FILE || "repos.yaml").trim();
  if (!existsSync(reposFile)) {
    process.stderr.write(
      `[main] ERROR: repos file not found: ${reposFile}\n` +
        `       Set REPOS_FILE or place repos.yaml in the working directory.\n`,
    );
    process.exit(2);
  }

  log.info("Repos file: %s", reposFile);
  console.log(`[main] Repos file: ${reposFile}`);

  const onExistPolicy = resolveOnExistPolicy(process.argv.slice(2));
  log.info("On-exist policy: %s", onExistPolicy);
  console.log(`[main] On-exist policy: ${onExistPolicy}`);

  const dryRun = ["1", "true", "yes"].includes((process.env.DRY_RUN || "").trim().toLowerCase());
  if (dryRun) {
    log.info("DRY_RUN=1 -- clone and LLM calls will be skipped");
    console.log("[main] DRY_RUN=1 -- running in dry-run mode (no clone, no LLM)");
    dryRunPreview(reposFile);
    return;
  }

  const initialState: Partial<WorkflowState> = {
    repos_file: reposFile,
    on_exist_policy: onExistPolicy,
    repo_queue: [],
    current_repo: {},
    extracted_files: {},
    git_metadata: {},
    llm_analysis: {},
    error_logs: [],
    last_step: "start",
  };

  const graph = buildGraph();

  let finalState: WorkflowState;
  try {
    log.info("Invoking graph...");
    console.log("[main] Invoking graph...");
    // The graph loops back to clone_target_repo per repo; raise the recursion
    // limit well above the per-repo step count so large batches don't trip it.
    finalState = (await graph.invoke(initialState, { recursionLimit: 500 })) as WorkflowState;
  } catch (exc) {
    log.exception("Graph execution failed: %s", String(exc));
    process.stderr.write(`[main] FATAL: graph execution failed -- ${exc}\n`);
    await shutdownChat();
    process.exit(1);
    return;
  }

  const errorLogs = finalState.error_logs || [];
  banner("cross-repo-deep-analysis-engine -- COMPLETE");
  console.log(`[main] Last step: ${finalState.last_step || "unknown"}`);
  console.log(`[main] Errors logged: ${errorLogs.length}`);
  for (const err of errorLogs) {
    console.log(`  [main] ERROR: ${err}`);
  }

  // Stop the shared Copilot harness (terminates the spawned runtime) before exit.
  await shutdownChat();
  process.exit(errorLogs.length ? 1 : 0);
}

/** Preview mode: parse and display the queue without any side effects. */
function dryRunPreview(reposFile: string): void {
  const ext = path.extname(reposFile).toLowerCase();
  const text = readFileSync(reposFile, "utf-8");
  const raw: unknown = ext === ".yaml" || ext === ".yml" ? parseYaml(text) : JSON.parse(text);

  const repos: Array<Record<string, string>> = Array.isArray(raw)
    ? (raw as Array<Record<string, string>>)
    : (((raw as Record<string, unknown>)?.repos as Array<Record<string, string>>) ?? []);

  banner("DRY-RUN PREVIEW");
  console.log(`[dry-run] Would process ${repos.length} repo(s):`);
  repos.forEach((r, i) => {
    const owner = r.owner || "?";
    const name = r.name || "?";
    const url = r.url || `https://${GITHUB_BASE_HOST}/${owner}/${name}.git`;
    console.log(`[dry-run]   ${i + 1}. ${owner}/${name} -- ${url}`);
  });

  console.log("");
  console.log("[dry-run] No files cloned. No GitHub API calls (size fetch skipped).");
  console.log("[dry-run] No LLM calls made.");
  console.log("[dry-run] Re-run without DRY_RUN=1 to execute the full pipeline.");
}

main().catch(async (exc) => {
  log.exception("fatal: %s", String(exc));
  process.stderr.write(`\nFATAL: ${exc}\n`);
  await shutdownChat();
  process.exit(1);
});
