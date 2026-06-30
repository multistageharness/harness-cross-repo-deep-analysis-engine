/**
 * cost-analysis.mjs — LLM cost analysis for a completed engine run.
 *
 * The engine itself does not persist token usage, so this tool RECONSTRUCTS each
 * repo's two LLM calls from the artifacts that ARE preserved:
 *   - the per-repo output JSON (.harness/<name>/.harness/analysis_*.json) holds the
 *     LLM outputs + the exact input file list (extracted_file_paths, random_file_path)
 *   - the shallow clone (.harness/<name>/...) still holds the input file contents
 *
 * It replays node 5 (analyzeStackAndDependencies) and node 6
 * (analyzeRandomContext) prompt construction byte-for-byte, then ESTIMATES the
 * token counts with the vendored `llm-sdk-github-copilot` token heuristic
 * (`estimateTokens`, ~4 chars/token with a word-count floor) and applies the
 * configured per-token pricing.
 *
 * Provider-SDK policy: this tool does NOT call any model-provider SDK directly
 * (no @anthropic-ai/sdk / @github/copilot-sdk). The previous version used the
 * live Anthropic count_tokens API for exact counts; the harness ships only a
 * heuristic estimator, so the numbers here are now ESTIMATES, not exact —
 * good enough for a cost ballpark, and dependency-free of any provider SDK.
 *
 * Skips that mirror the engine:
 *   - node 5 makes NO LLM call when there are no manifest/workflow files (empty
 *     extracted_file_paths) -> $0.00
 *   - node 6 makes NO LLM call when no random file was selected (random_file_path
 *     == "") -> $0.00
 *
 * Output-token note: every count here is a heuristic ESTIMATE (the harness
 * estimator), not an exact tokenizer count. Node 6's output (random_file_summary)
 * is the model's verbatim text; node 5's output is re-serialized from the 6
 * parsed keys in their documented order. Both input and output token figures are
 * estimates.
 *
 * Usage:  node cost-analysis.mjs        (from the project root; no API key needed)
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { estimateTokens } from "llm-sdk-github-copilot/tokens";

// ── Pricing (USD per token). Defaults are illustrative; override via env. ──────
// Token counts are heuristic estimates (see header), so the dollar figures are a
// ballpark cost model, not a billed amount. The two engine roles (analysis /
// context) are priced independently and keyed by ROLE, not by model id, so the
// table stays valid when the Copilot model ids change.
const PRICING = {
  analysis: {
    input: Number(process.env.ANALYSIS_PRICE_IN ?? 5.0) / 1e6,
    output: Number(process.env.ANALYSIS_PRICE_OUT ?? 25.0) / 1e6,
  },
  context: {
    input: Number(process.env.CONTEXT_PRICE_IN ?? 1.0) / 1e6,
    output: Number(process.env.CONTEXT_PRICE_OUT ?? 5.0) / 1e6,
  },
};

const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "claude-opus-4.8"; // node 5
const CONTEXT_MODEL = process.env.CONTEXT_MODEL || "claude-haiku-4.5"; // node 6
const PER_FILE_CHAR_LIMIT = 8_000; // node 5 cap

const HARNESS_DIR = path.resolve("./.harness");

// ── Node 5 system prompt (verbatim from src/nodes/analyzeStackAndDependencies.ts) ──
const SYSTEM_PROMPT_5 =
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

// ── Node 6 system prompt (verbatim from src/nodes/analyzeRandomContext.ts) ──
const SYSTEM_PROMPT_6 =
  "You are a senior software engineer reviewing a randomly-selected source file " +
  "from a repository. Provide a concise 2-4 sentence summary that describes:\n" +
  "1. What this file does.\n" +
  "2. How it likely fits into the broader codebase.\n" +
  "Respond in plain prose only -- no markdown, no bullet points, no headers.";

// Per-message framing overhead the harness's estimateMessagesTokens adds; we
// fold the system + user pair into one estimate plus a small fixed overhead.
const MESSAGE_OVERHEAD_TOKENS = 8;

/** Heuristic input-token estimate for a (system, userContent) pair. */
function countInput(system, userContent) {
  return (
    estimateTokens(system) + estimateTokens(userContent) + MESSAGE_OVERHEAD_TOKENS
  );
}

/** Heuristic token estimate for an output string. */
function countOutput(text) {
  if (!text) return 0;
  return estimateTokens(text);
}

/** Rebuild node 5's user message exactly as the node does. */
function buildNode5UserContent(repoSlug, cloneDir, extractedFilePaths) {
  const parts = [`Repository: ${repoSlug}`, "", "## Extracted Files", ""];
  // node 5 sorts by localeCompare on the path key
  const sorted = [...extractedFilePaths].sort((a, b) => a.localeCompare(b));
  for (const filePath of sorted) {
    const abs = path.join(cloneDir, filePath);
    let content = "";
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      content = ""; // file unreadable -> empty (engine would have skipped at extract time)
    }
    parts.push(`### ${filePath}`);
    parts.push("```");
    parts.push(content.slice(0, PER_FILE_CHAR_LIMIT));
    if (content.length > PER_FILE_CHAR_LIMIT) {
      parts.push(`[... truncated at ${PER_FILE_CHAR_LIMIT} chars ...]`);
    }
    parts.push("```");
    parts.push("");
  }
  return parts.join("\n");
}

/** Rebuild node 6's user message exactly as the node does. */
function buildNode6UserContent(repoSlug, cloneDir, randomPath) {
  const abs = path.join(cloneDir, randomPath);
  let randomContent = "";
  try {
    randomContent = readFileSync(abs, "utf-8");
  } catch {
    randomContent = "";
  }
  return `Repository: ${repoSlug}\nFile path: ${randomPath}\n\n\`\`\`\n${randomContent}\n\`\`\``;
}

/** Re-serialize node 5's structured output (6 keys, documented order). */
function buildNode5Output(a) {
  return JSON.stringify({
    primary_language: a.primary_language,
    package_managers: a.package_managers,
    installation_steps: a.installation_steps,
    build_process: a.build_process,
    testing_frameworks: a.testing_frameworks,
    ci_cd_notes: a.ci_cd_notes,
  });
}

function usd(n) {
  return `$${n.toFixed(6)}`;
}

function findOutputJson(repoDir) {
  const outDir = path.join(repoDir, ".harness");
  if (!existsSync(outDir)) return null;
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;
  return path.join(outDir, files.sort().at(-1)); // latest by name (ts-sortable)
}

async function main() {
  if (!existsSync(HARNESS_DIR)) {
    console.error(`No .harness/ directory found at ${HARNESS_DIR}`);
    process.exit(1);
  }

  // Collect (repoName, jsonPath, payload) and sort by run_timestamp (processing order).
  const repos = [];
  for (const name of readdirSync(HARNESS_DIR)) {
    const repoDir = path.join(HARNESS_DIR, name);
    const jsonPath = findOutputJson(repoDir);
    if (!jsonPath) continue;
    const payload = JSON.parse(readFileSync(jsonPath, "utf-8"));
    repos.push({ name, repoDir, payload });
  }
  repos.sort((a, b) =>
    String(a.payload.run_timestamp).localeCompare(String(b.payload.run_timestamp)),
  );

  console.log("=".repeat(78));
  console.log("CROSS-REPO DEEP ANALYSIS ENGINE — LLM COST ANALYSIS");
  console.log("=".repeat(78));
  const per1M = (p) => `$${(p.input * 1e6).toFixed(2)}/$${(p.output * 1e6).toFixed(2)} per 1M in/out`;
  console.log(`Models:  node 5 = ${ANALYSIS_MODEL} (${per1M(PRICING.analysis)})`);
  console.log(`         node 6 = ${CONTEXT_MODEL} (${per1M(PRICING.context)})`);
  console.log(`Token counts: heuristic ESTIMATES (harness estimator; no provider SDK)`);
  console.log(`Repos analyzed: ${repos.length}`);
  console.log("");

  const totals = {
    n5_in: 0, n5_out: 0, n5_cost: 0,
    n6_in: 0, n6_out: 0, n6_cost: 0,
  };

  for (let i = 0; i < repos.length; i++) {
    const { name, repoDir, payload } = repos[i];
    const repoSlug = payload.repo || name;
    const a = payload.llm_analysis || {};
    const extractedFilePaths = payload.extracted_file_paths || [];
    const randomPath = a.random_file_path || "";

    // ── Node 5 (Opus) ────────────────────────────────────────────────────
    let n5_in = 0, n5_out = 0, n5_cost = 0, n5_called = false;
    if (extractedFilePaths.length > 0) {
      n5_called = true;
      const user5 = buildNode5UserContent(repoSlug, repoDir, extractedFilePaths);
      const out5 = buildNode5Output(a);
      n5_in = countInput(SYSTEM_PROMPT_5, user5);
      n5_out = countOutput(out5);
      const p = PRICING.analysis;
      n5_cost = n5_in * p.input + n5_out * p.output;
    }

    // ── Node 6 (context summary) ─────────────────────────────────────────
    let n6_in = 0, n6_out = 0, n6_cost = 0, n6_called = false;
    if (randomPath) {
      n6_called = true;
      const user6 = buildNode6UserContent(repoSlug, repoDir, randomPath);
      n6_in = countInput(SYSTEM_PROMPT_6, user6);
      n6_out = countOutput(a.random_file_summary || "");
      const p = PRICING.context;
      n6_cost = n6_in * p.input + n6_out * p.output;
    }

    const repoCost = n5_cost + n6_cost;

    totals.n5_in += n5_in; totals.n5_out += n5_out; totals.n5_cost += n5_cost;
    totals.n6_in += n6_in; totals.n6_out += n6_out; totals.n6_cost += n6_cost;

    // ── Per-repo cost block ──────────────────────────────────────────────
    console.log("-".repeat(78));
    console.log(`[${i + 1}/${repos.length}] ${repoSlug}`);
    console.log(`        files in stack analysis: ${extractedFilePaths.length} | random file: ${randomPath || "(none)"}`);
    if (n5_called) {
      console.log(`  node 5  ${ANALYSIS_MODEL.padEnd(18)} in=${String(n5_in).padStart(6)}  out=${String(n5_out).padStart(5)}  cost=${usd(n5_cost)}`);
    } else {
      console.log(`  node 5  ${ANALYSIS_MODEL.padEnd(18)} SKIPPED (no manifests/workflows) cost=${usd(0)}`);
    }
    if (n6_called) {
      console.log(`  node 6  ${CONTEXT_MODEL.padEnd(18)} in=${String(n6_in).padStart(6)}  out=${String(n6_out).padStart(5)}  cost=${usd(n6_cost)}`);
    } else {
      console.log(`  node 6  ${CONTEXT_MODEL.padEnd(18)} SKIPPED (no random file)         cost=${usd(0)}`);
    }
    console.log(`  REPO TOTAL: ${usd(repoCost)}`);
  }

  // ── Grand total ────────────────────────────────────────────────────────
  const grand = totals.n5_cost + totals.n6_cost;
  console.log("");
  console.log("=".repeat(78));
  console.log("FULL COST TOTAL (all repos)");
  console.log("=".repeat(78));
  console.log(`  node 5 (${ANALYSIS_MODEL}):`);
  console.log(`     input tokens : ${totals.n5_in.toLocaleString()}`);
  console.log(`     output tokens: ${totals.n5_out.toLocaleString()}`);
  console.log(`     subtotal     : ${usd(totals.n5_cost)}`);
  console.log(`  node 6 (${CONTEXT_MODEL}):`);
  console.log(`     input tokens : ${totals.n6_in.toLocaleString()}`);
  console.log(`     output tokens: ${totals.n6_out.toLocaleString()}`);
  console.log(`     subtotal     : ${usd(totals.n6_cost)}`);
  console.log("  " + "-".repeat(40));
  console.log(`  TOTAL INPUT TOKENS : ${(totals.n5_in + totals.n6_in).toLocaleString()}`);
  console.log(`  TOTAL OUTPUT TOKENS: ${(totals.n5_out + totals.n6_out).toLocaleString()}`);
  console.log(`  GRAND TOTAL COST   : ${usd(grand)}  (≈ $${grand.toFixed(4)})`);
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error("Cost analysis failed:", e?.message || e);
  process.exit(1);
});
