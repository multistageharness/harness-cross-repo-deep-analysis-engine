/**
 * Node 5/7 — analyze_stack_and_dependencies (LLM, via the Copilot harness)
 *
 * Passes manifest files and CI/CD workflow definitions to an LLM for deep stack
 * analysis. No tool bindings are used -- this is a raw, deterministic inference
 * call that returns structured JSON. The call is routed through the vendored
 * `llm-sdk-github-copilot` harness (see src/llm.ts), never a provider SDK.
 *
 * Model: Copilot model id "claude-opus-4.8" (overridable via ANALYSIS_MODEL env
 * var); reasoning effort "medium" (overridable via ANALYSIS_EFFORT).
 *
 * The LLM is instructed to return a JSON object with these keys:
 *   primary_language, package_managers, installation_steps, build_process,
 *   testing_frameworks, ci_cd_notes
 *
 * On JSON parse failure the raw text is stored under "raw_analysis" so no data
 * is lost and the pipeline continues.
 *
 * State reads:  extracted_files, current_repo, llm_analysis
 * State writes: llm_analysis (merged), last_step
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { makeChat } from "../llm.js";
import { banner, getLogger } from "../loggingSetup.js";
import type { WorkflowState } from "../state.js";

const log = getLogger("node-5");

const MODEL_ID = process.env.ANALYSIS_MODEL || "claude-opus-4.8";
const MAX_TOKENS = parseInt(process.env.ANALYSIS_MAX_TOKENS || "2048", 10);
const REASONING_EFFORT = (process.env.ANALYSIS_EFFORT || "medium") as
  | "low"
  | "medium"
  | "high"
  | "xhigh";

// Hard limit on per-file content sent to the LLM (avoids context overflow).
const PER_FILE_CHAR_LIMIT = 8_000;

const SYSTEM_PROMPT =
  "You are a senior software engineer performing a thorough repository audit.\n" +
  "You will be given the contents of package manifest files and CI/CD workflow definitions.\n" +
  "Analyze them and respond with a JSON object containing exactly these keys:\n" +
  '- "primary_language": the dominant programming language (string)\n' +
  '- "package_managers": list of package managers detected (list of strings)\n' +
  '- "installation_steps": concise description of how to install the project (string)\n' +
  '- "build_process": description of the build pipeline (string)\n' +
  '- "testing_frameworks": list of testing libraries/frameworks detected (list of strings)\n' +
  '- "ci_cd_notes": brief description of the CI/CD pipeline (string)\n' +
  "Respond ONLY with valid JSON. No markdown fences, no preamble, no trailing commentary.";

export async function analyzeStackAndDependencies(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 5/7 -- analyze_stack_and_dependencies (LLM)");

  const extractedFiles = state.extracted_files || {};
  const currentRepo = state.current_repo || {};
  const existingAnalysis = { ...(state.llm_analysis || {}) };

  // Collect manifests and workflows; exclude __random__ sentinels.
  const relevant: Record<string, string> = {};
  for (const [k, v] of Object.entries(extractedFiles)) {
    if (!k.startsWith("__")) {
      relevant[k] = v;
    }
  }

  if (Object.keys(relevant).length === 0) {
    log.warning("No manifest/workflow files found -- returning empty analysis");
    console.log("[node-5] WARNING: no manifest/workflow files; skipping LLM call");
    const empty = {
      primary_language: "unknown",
      package_managers: [] as string[],
      installation_steps: "No manifests found in this repository.",
      build_process: "No manifests found in this repository.",
      testing_frameworks: [] as string[],
      ci_cd_notes: "No CI/CD workflows found in this repository.",
    };
    return {
      llm_analysis: { ...existingAnalysis, ...empty },
      last_step: "analyze_stack_and_dependencies",
    };
  }

  // Build user message -- include all manifest/workflow contents (capped per file).
  const repoSlug = `${currentRepo.owner || ""}/${currentRepo.name || ""}`;
  const parts: string[] = [`Repository: ${repoSlug}`, "", "## Extracted Files", ""];
  for (const [filePath, content] of Object.entries(relevant).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`### ${filePath}`);
    parts.push("```");
    parts.push(content.slice(0, PER_FILE_CHAR_LIMIT));
    if (content.length > PER_FILE_CHAR_LIMIT) {
      parts.push(`[... truncated at ${PER_FILE_CHAR_LIMIT} chars ...]`);
    }
    parts.push("```");
    parts.push("");
  }
  const userContent = parts.join("\n");

  log.info("Calling %s for stack analysis -- %d files, %d chars total", MODEL_ID, Object.keys(relevant).length, userContent.length);
  console.log(`[node-5] Calling ${MODEL_ID} -- ${Object.keys(relevant).length} files, ${userContent.length} chars`);

  const llm = makeChat({ model: MODEL_ID, maxTokens: MAX_TOKENS, reasoningEffort: REASONING_EFFORT });

  const response = await llm.invoke([new SystemMessage(SYSTEM_PROMPT), new HumanMessage(userContent)]);
  const rawText = typeof response.content === "string" ? response.content : String(response.content);

  log.info("LLM response: %d chars", rawText.length);
  console.log(`[node-5] LLM response: ${rawText.length} chars`);

  let analysisResult: Record<string, unknown>;
  try {
    analysisResult = JSON.parse(rawText.trim()) as Record<string, unknown>;
    log.info("Stack analysis parsed: language=%s", String(analysisResult.primary_language));
    console.log(`[node-5] Stack analysis: language=${analysisResult.primary_language}`);
  } catch (exc) {
    log.warning("LLM returned non-JSON; storing raw text: %s", String(exc));
    console.log(`[node-5] WARNING: JSON parse failed (${exc}); storing raw text`);
    analysisResult = { raw_analysis: rawText };
  }

  return {
    llm_analysis: { ...existingAnalysis, ...analysisResult },
    last_step: "analyze_stack_and_dependencies",
  };
}
