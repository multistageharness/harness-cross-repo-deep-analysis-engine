/**
 * graph.ts — StateGraph topology for cross-repo-deep-analysis-engine (Node/TS).
 *
 * 7 nodes with two conditional edges:
 *
 *   (a) Skip-to-next-repo on clone failure
 *       clone_target_repo --[_clone_failed=true, queue non-empty]--> clone_target_repo
 *       clone_target_repo --[_clone_failed=true, queue empty]------> END
 *
 *   (b) Loop-back-until-queue-empty
 *       generate_and_save_report --[queue non-empty]--> clone_target_repo
 *       generate_and_save_report --[queue empty]------> END
 *
 * Graph topology ASCII (also in CLAUDE.md):
 *
 *   initialize_and_sort_queue
 *            |
 *            v
 *     clone_target_repo <--------------------------------------------+
 *            |                                                        |
 *            +--[clone failed, queue non-empty]---------------------->+
 *            |
 *            +--[clone failed, queue empty]--> END
 *            |
 *            v  [clone succeeded]
 *     extract_git_metadata
 *            |
 *            v
 *     extract_repository_manifests
 *            |
 *            v
 *     analyze_stack_and_dependencies  (LLM -- Copilot harness, claude-opus-4.8)
 *            |
 *            v
 *     analyze_random_context          (LLM -- Copilot harness, claude-haiku-4.5)
 *            |
 *            v
 *     generate_and_save_report
 *            |
 *            +--[queue non-empty]--> clone_target_repo
 *            |
 *            +--[queue empty]------> END
 */

import { END, START, StateGraph } from "@langchain/langgraph";

import { analyzeRandomContext } from "./nodes/analyzeRandomContext.js";
import { analyzeStackAndDependencies } from "./nodes/analyzeStackAndDependencies.js";
import { cloneTargetRepo } from "./nodes/cloneTargetRepo.js";
import { extractGitMetadata } from "./nodes/extractGitMetadata.js";
import { extractRepositoryManifests } from "./nodes/extractRepositoryManifests.js";
import { generateAndSaveReport } from "./nodes/generateAndSaveReport.js";
import { initializeAndSortQueue } from "./nodes/initializeAndSortQueue.js";
import { WorkflowStateAnnotation, type WorkflowState } from "./state.js";

// ── Routing functions ───────────────────────────────────────────────────────

/**
 * Conditional edge after clone_target_repo.
 *   "extract_git_metadata" -- clone succeeded (or was reused), proceed
 *   "clone_target_repo"    -- clone failed or skipped, queue has more repos to try
 *   END                    -- clone failed/skipped and queue is empty (or exhausted)
 */
function routeAfterClone(state: WorkflowState): string {
  const current = state.current_repo || {};
  const queue = state.repo_queue || [];

  // Both a genuine clone failure and an intentional on-exist skip route to the
  // next repo (or END). _clone_failed is an error; _skipped is not.
  if (current._clone_failed || current._skipped) {
    return queue.length ? "clone_target_repo" : END;
  }

  // Queue exhausted (empty queue with no clone failure) -- defensive guard.
  if (current._queue_exhausted) {
    return END;
  }

  return "extract_git_metadata";
}

/**
 * Conditional edge after generate_and_save_report.
 *   "clone_target_repo" -- queue has more repos to process
 *   END                 -- queue is empty; pipeline complete
 */
function routeAfterReport(state: WorkflowState): string {
  return (state.repo_queue || []).length ? "clone_target_repo" : END;
}

// ── Graph construction ──────────────────────────────────────────────────────

/** Build and compile the StateGraph. Returns a compiled LangGraph runnable. */
export function buildGraph() {
  // The StateGraph generic node-name typing fights the dynamic loop wiring; we
  // keep the builder loosely typed (the topology is verified by the smoke run).
  // Node functions and the state schema remain fully typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = new StateGraph(WorkflowStateAnnotation);

  builder.addNode("initialize_and_sort_queue", initializeAndSortQueue);
  builder.addNode("clone_target_repo", cloneTargetRepo);
  builder.addNode("extract_git_metadata", extractGitMetadata);
  builder.addNode("extract_repository_manifests", extractRepositoryManifests);
  builder.addNode("analyze_stack_and_dependencies", analyzeStackAndDependencies);
  builder.addNode("analyze_random_context", analyzeRandomContext);
  builder.addNode("generate_and_save_report", generateAndSaveReport);

  // Entry point.
  builder.addEdge(START, "initialize_and_sort_queue");

  // Linear edge: node 1 -> node 2.
  builder.addEdge("initialize_and_sort_queue", "clone_target_repo");

  // Conditional edge (a): skip-on-failure or proceed.
  builder.addConditionalEdges("clone_target_repo", routeAfterClone, {
    extract_git_metadata: "extract_git_metadata",
    clone_target_repo: "clone_target_repo",
    [END]: END,
  });

  // Linear pipeline: nodes 3 -> 4 -> 5 -> 6 -> 7.
  builder.addEdge("extract_git_metadata", "extract_repository_manifests");
  builder.addEdge("extract_repository_manifests", "analyze_stack_and_dependencies");
  builder.addEdge("analyze_stack_and_dependencies", "analyze_random_context");
  builder.addEdge("analyze_random_context", "generate_and_save_report");

  // Conditional edge (b): loop or end.
  builder.addConditionalEdges("generate_and_save_report", routeAfterReport, {
    clone_target_repo: "clone_target_repo",
    [END]: END,
  });

  return builder.compile();
}
