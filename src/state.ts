/**
 * state.ts — WorkflowState channels threaded through the entire StateGraph.
 *
 * Built with LangGraph.js `Annotation.Root`. Every channel carries a default so
 * a node can read a value that an earlier node never wrote — the equivalent of
 * the Python `TypedDict(total=False)` + `state.get(key, default)` pattern.
 *
 * One channel uses a reducer instead of last-value semantics:
 *   - `error_logs` — concat. Nodes return ONLY the new errors they want to
 *     append (the delta), never the full list. The reducer accumulates errors
 *     across every repo in the batch. This differs from the Python original,
 *     which returned the full list each time; see logs/decisions.md.
 *
 * Sections
 * --------
 * inputs      Keys populated before the graph runs (repos_file, repo_queue,
 *             on_exist_policy).
 * derived     Keys written by nodes as the graph executes.
 * diagnostics Runtime bookkeeping (error_logs, last_step).
 */

import { Annotation } from "@langchain/langgraph";

/** A last-value channel with an explicit default (mirrors TypedDict total=False). */
function lastValue<T>(def: () => T) {
  return Annotation<T>({ reducer: (_left: T, right: T) => right, default: def });
}

/** A repo entry queued for processing (populated by node 1). */
export interface RepoEntry {
  owner: string;
  name: string;
  url: string;
  size_kb: number;
}

/**
 * The repo currently being processed. Extends RepoEntry with per-iteration
 * routing flags written by node 2 (clone_target_repo):
 *   clone_dir        — set on successful clone (or reused dir)
 *   _clone_failed    — set on a genuine clone failure (counted as an error)
 *   _skipped         — set when the on-exist policy skips it (NOT an error)
 *   _reused          — set when an existing clone is reused (continue policy)
 *   _queue_exhausted — defensive guard set when the queue is empty
 */
export interface CurrentRepo extends Partial<RepoEntry> {
  clone_dir?: string;
  _clone_failed?: boolean;
  _skipped?: boolean;
  _reused?: boolean;
  _queue_exhausted?: boolean;
}

export const WorkflowStateAnnotation = Annotation.Root({
  // ── inputs ──────────────────────────────────────────────────────────────

  // Full path to the input repos YAML/JSON file.
  repos_file: lastValue<string>(() => ""),

  // Sorted list of repos to process. Populated by node 1; popped by node 2 on
  // each loop iteration.
  repo_queue: lastValue<RepoEntry[]>(() => []),

  // Collision policy when a clone directory already exists under .harness/.
  // One of: "prompt" (interactive, default), "skip", "continue", "overwrite".
  // Resolved in main.ts from CLI flags / ON_EXIST env var.
  on_exist_policy: lastValue<string>(() => "prompt"),

  // ── derived ─────────────────────────────────────────────────────────────

  current_repo: lastValue<CurrentRepo>(() => ({})),

  // Mapping of relative file path -> raw text content.
  // Keys include manifest paths ("package.json", "requirements.txt", ...),
  // workflow paths (".github/workflows/ci.yml"), and the sentinels:
  //   "__random__"       -- content of the randomly selected source file
  //   "__random_path__"  -- its path relative to the clone root
  extracted_files: lastValue<Record<string, string>>(() => ({})),

  // Counts fetched from the GitHub API: { branches, tags, releases }.
  git_metadata: lastValue<Record<string, number>>(() => ({})),

  // Compiled LLM insights from nodes 5 and 6.
  // Node 5 sets: primary_language, package_managers, installation_steps,
  //   build_process, testing_frameworks, ci_cd_notes (or raw_analysis on
  //   parse failure).
  // Node 6 adds: random_file_summary, random_file_path.
  llm_analysis: lastValue<Record<string, unknown>>(() => ({})),

  // ── diagnostics ─────────────────────────────────────────────────────────

  // Human-readable failure strings (clone errors, auth failures, etc.).
  // Nodes return ONLY new errors (the delta); the reducer concatenates so the
  // list accumulates across all repos. Shown in the final banner and per-repo
  // report.
  error_logs: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  // Name of the last node that completed successfully (useful in dry-run).
  last_step: lastValue<string>(() => "start"),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
