/**
 * Node 2/7 — clone_target_repo (Code)
 *
 * Pops the next repo from queue and shallow-clones it into .harness/<repo_name>.
 *
 * Credentials: GITHUB_TOKEN is injected into the HTTPS clone URL for private repos.
 * Constraint: no push-capable credentials are loaded; read-only token only.
 * Shell: NEVER spawned. All subprocess calls go through src/shell.ts run().
 *
 * On clone failure the node:
 *   1. appends a descriptive string to error_logs (delta)
 *   2. sets current_repo._clone_failed = true
 *   3. returns -- the graph's conditional edge routes back (or to END if queue empty)
 *
 * On-exist collision policy (state.on_exist_policy, default "prompt"):
 *   skip      -- mark current_repo._skipped=true, route to next repo (not an error)
 *   continue  -- reuse the existing clone as-is (no re-clone)
 *   overwrite -- rm -rf the existing dir, then clone fresh
 *   prompt    -- ask interactively; falls back to "skip" when stdin is not a TTY
 *
 * State reads:  repo_queue, on_exist_policy
 * State writes: current_repo, repo_queue, error_logs (delta), last_step
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import { banner, getLogger } from "../loggingSetup.js";
import { ShellError, requireBinary, run } from "../shell.js";
import type { RepoEntry, WorkflowState } from "../state.js";

const log = getLogger("node-2");

export const REPO_BASE_DIR = ".harness";

const VALID_POLICIES = new Set(["prompt", "skip", "continue", "overwrite"]);

/**
 * Interactively ask the user what to do about an existing clone dir.
 * Returns one of: "skip", "continue", "overwrite".
 * Falls back to "skip" (non-destructive) on EOF / closed stdin.
 */
async function promptOnExist(repoSlug: string, cloneDir: string): Promise<string> {
  console.log(`[node-2] Directory already exists: ${cloneDir}`);
  console.log(`[node-2] Repo ${repoSlug} -- choose an action:`);
  console.log("           [s] skip      -- do not process this repo");
  console.log("           [c] continue  -- reuse the existing clone as-is");
  console.log("           [o] overwrite -- delete the directory and re-clone");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      let choice: string;
      try {
        choice = (await rl.question("[node-2] [s/c/o]? ")).trim().toLowerCase();
      } catch {
        console.log("[node-2] No input available -- defaulting to 'skip'");
        return "skip";
      }
      if (choice === "s" || choice === "skip") {
        return "skip";
      }
      if (choice === "c" || choice === "continue") {
        return "continue";
      }
      if (choice === "o" || choice === "overwrite") {
        return "overwrite";
      }
      console.log("[node-2] Invalid choice. Enter s, c, or o.");
    }
  } finally {
    rl.close();
  }
}

export async function cloneTargetRepo(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 2/7 -- clone_target_repo");

  const repoQueue: RepoEntry[] = [...(state.repo_queue || [])];

  if (repoQueue.length === 0) {
    log.info("Queue is empty -- all repos have been processed");
    console.log("[node-2] Queue is empty. All repos processed.");
    return {
      repo_queue: repoQueue,
      current_repo: { _clone_failed: false, _queue_exhausted: true },
      last_step: "clone_target_repo",
    };
  }

  requireBinary("git");

  const repo = repoQueue.shift() as RepoEntry;
  const { owner, name, url } = repo;

  log.info("Next repo: %s/%s (size_kb=%s)", owner, name, String(repo.size_kb ?? "?"));
  console.log(`[node-2] Next repo: ${owner}/${name} (size_kb=${repo.size_kb ?? "?"})`);

  const cloneDir = path.join(REPO_BASE_DIR, name);
  const repoSlug = `${owner}/${name}`;

  // ── On-exist collision policy ───────────────────────────────────────────
  if (existsSync(cloneDir)) {
    let policy = state.on_exist_policy || "prompt";
    if (!VALID_POLICIES.has(policy)) {
      log.warning("Unknown on_exist_policy %s -- defaulting to 'prompt'", JSON.stringify(policy));
      policy = "prompt";
    }

    let action = policy;
    if (policy === "prompt") {
      if (process.stdin.isTTY) {
        action = await promptOnExist(repoSlug, cloneDir);
      } else {
        log.warning(
          "Existing dir %s but stdin is not a TTY -- defaulting to 'skip'. " +
            "Pass --skip/--continue/--overwrite (or ON_EXIST=...) to choose.",
          cloneDir,
        );
        console.log(`[node-2] Existing dir, non-interactive -> skip (${cloneDir})`);
        action = "skip";
      }
    }

    if (action === "skip") {
      const msg = `Skipped ${repoSlug} -- existing dir ${cloneDir} (policy=skip)`;
      log.info(msg);
      console.log(`[node-2] ${msg}`);
      return {
        repo_queue: repoQueue,
        current_repo: { ...repo, _clone_failed: false, _skipped: true, clone_dir: "" },
        last_step: "clone_target_repo",
      };
    }

    if (action === "continue") {
      const msg = `Reusing existing clone for ${repoSlug}: ${cloneDir} (policy=continue)`;
      log.info(msg);
      console.log(`[node-2] ${msg}`);
      return {
        repo_queue: repoQueue,
        current_repo: { ...repo, _clone_failed: false, _reused: true, clone_dir: cloneDir },
        last_step: "clone_target_repo",
      };
    }

    // action === "overwrite": delete and re-clone below.
    log.info("Removing existing clone dir (policy=overwrite): %s", cloneDir);
    console.log(`[node-2] Removing existing clone dir (overwrite): ${cloneDir}`);
    rmSync(cloneDir, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(cloneDir), { recursive: true });

  // Inject token into HTTPS URL for private repos.
  // Pattern: https://<token>@github.com/owner/name.git
  // This avoids interactive credential prompts in CI/CD environments.
  let cloneUrl = url;
  const githubToken = (process.env.GITHUB_TOKEN || "").trim();
  if (githubToken && cloneUrl.startsWith("https://github.com/")) {
    cloneUrl = cloneUrl.replace("https://github.com/", `https://${githubToken}@github.com/`);
  }

  log.info("Cloning %s -> %s", url, cloneDir);
  console.log(`[node-2] Cloning ${url} -> ${cloneDir}`);

  try {
    run(["git", "clone", "--depth", "1", cloneUrl, cloneDir], { timeout: 300 });
  } catch (exc) {
    if (exc instanceof ShellError) {
      const msg = `Clone failed for ${owner}/${name} (exit=${exc.returncode}): ${exc.stderr.slice(0, 200)}`;
      log.error(msg);
      console.log(`[node-2] ERROR: ${msg}`);
      return {
        repo_queue: repoQueue,
        current_repo: { ...repo, _clone_failed: true, clone_dir: "" },
        error_logs: [msg],
        last_step: "clone_target_repo",
      };
    }
    throw exc;
  }

  log.info("Clone successful: %s", cloneDir);
  console.log(`[node-2] Clone successful: ${cloneDir}`);

  return {
    repo_queue: repoQueue,
    current_repo: { ...repo, _clone_failed: false, clone_dir: cloneDir },
    last_step: "clone_target_repo",
  };
}
