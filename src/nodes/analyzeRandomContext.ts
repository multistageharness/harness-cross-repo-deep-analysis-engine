/**
 * Node 6/7 — analyze_random_context (LLM, via the Copilot harness)
 *
 * Reads the randomly-selected source file from extracted_files and produces a
 * brief 2-4 sentence summary of its purpose and how it fits the broader repo.
 * Routed through the vendored `llm-sdk-github-copilot` harness (see src/llm.ts),
 * never a provider SDK.
 *
 * Model: Copilot model id "claude-haiku-4.5" (overridable via CONTEXT_MODEL env
 * var); reasoning effort "low" (overridable via CONTEXT_EFFORT). This is
 * intentionally the faster/cheaper model -- single-file summarization does not
 * need the deeper-reasoning model used by node 5.
 *
 * If no random file was selected by node 4 (empty __random__ key), this node
 * logs the absence and writes a placeholder summary -- the pipeline continues.
 *
 * State reads:  extracted_files, current_repo, llm_analysis
 * State writes: llm_analysis (adds random_file_summary + random_file_path), last_step
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { makeChat } from "../llm.js";
import { banner, getLogger } from "../loggingSetup.js";
import type { WorkflowState } from "../state.js";

const log = getLogger("node-6");

const MODEL_ID = process.env.CONTEXT_MODEL || "claude-haiku-4.5";
const MAX_TOKENS = parseInt(process.env.CONTEXT_MAX_TOKENS || "512", 10);
const REASONING_EFFORT = (process.env.CONTEXT_EFFORT || "low") as
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const SYSTEM_PROMPT =
  "You are a senior software engineer reviewing a randomly-selected source file " +
  "from a repository. Provide a concise 2-4 sentence summary that describes:\n" +
  "1. What this file does.\n" +
  "2. How it likely fits into the broader codebase.\n" +
  "Respond in plain prose only -- no markdown, no bullet points, no headers.";

export async function analyzeRandomContext(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 6/7 -- analyze_random_context (LLM)");

  const extractedFiles = state.extracted_files || {};
  const currentRepo = state.current_repo || {};
  const existingAnalysis = { ...(state.llm_analysis || {}) };

  const randomContent = extractedFiles["__random__"] || "";
  const randomPath = extractedFiles["__random_path__"] || "";

  if (!randomContent) {
    log.info("No random file available -- skipping context analysis");
    console.log("[node-6] No random file available; skipping context analysis");
    return {
      llm_analysis: {
        ...existingAnalysis,
        random_file_summary:
          "No eligible source file was found in this repository (extension allowlist + 50 KB cap applied).",
        random_file_path: "",
      },
      last_step: "analyze_random_context",
    };
  }

  const repoSlug = `${currentRepo.owner || ""}/${currentRepo.name || ""}`;
  const userContent = `Repository: ${repoSlug}\nFile path: ${randomPath}\n\n\`\`\`\n${randomContent}\n\`\`\``;

  log.info("Calling %s for random file context: %s (%d chars)", MODEL_ID, randomPath, userContent.length);
  console.log(`[node-6] Calling ${MODEL_ID} for: ${randomPath} (${userContent.length} chars)`);

  const llm = makeChat({ model: MODEL_ID, maxTokens: MAX_TOKENS, reasoningEffort: REASONING_EFFORT });

  const response = await llm.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(userContent)]);
  let summary = typeof response.content === "string" ? response.content : String(response.content);
  summary = summary.trim();

  log.info("Random file summary (%d chars): %s...", summary.length, summary.slice(0, 100));
  console.log(`[node-6] Summary (${summary.length} chars): ${summary.slice(0, 120)}...`);

  return {
    llm_analysis: {
      ...existingAnalysis,
      random_file_summary: summary,
      random_file_path: randomPath,
    },
    last_step: "analyze_random_context",
  };
}
