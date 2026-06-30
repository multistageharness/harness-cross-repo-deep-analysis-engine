/**
 * llm.ts — shared LLM client for the analysis nodes (5 + 6), backed by the
 * vendored **llm-sdk-github-copilot** harness instead of any provider SDK.
 *
 * Why the harness (not @langchain/anthropic / @github/copilot-sdk directly)
 * -----------------------------------------------------------------------
 * Project policy: do NOT call GitHub Copilot (or any model provider) SDK
 * directly — all LLM access goes through the `llm-sdk-github-copilot` harness,
 * which is vendored in-project under `vendors/llm-sdk-github-copilot`
 * and wired as the `file:`-installed npm package `llm-sdk-github-copilot`.
 * The harness wraps `@github/copilot-sdk` with config-driven model/effort
 * selection, token budgeting, usage tracking, and lifecycle management.
 *
 * Compatibility seam
 * ------------------
 * The LLM nodes were written against a LangChain-style `makeChat().invoke(msgs)`
 * call that returns `{ content }`. To keep those nodes essentially unchanged,
 * `makeChat()` here returns a thin adapter exposing the same `invoke()` shape:
 * it pulls the system + human text out of the LangChain message array, drives
 * one Copilot harness turn (a fresh session per call so each node's distinct
 * system prompt + model apply), and returns `{ content }`.
 *
 * Lifecycle
 * ---------
 * A single harness (one spawned Copilot runtime) is created lazily and reused
 * across all calls. `shutdownChat()` stops it; `main.ts` calls that before exit.
 */

import type { BaseMessage } from "@langchain/core/messages";
import { createHarness, type CopilotHarness } from "llm-sdk-github-copilot";

export interface ChatOptions {
  /** Copilot model id (e.g. "claude-opus-4.8", "claude-haiku-4.5"). */
  model: string;
  /**
   * Advisory output-size hint. The Copilot harness does not expose a hard
   * max-output-tokens knob, so this is informational only — the system prompts
   * (JSON-only / "2-4 sentences") are what actually constrain output length.
   */
  maxTokens: number;
  /** Reasoning effort for this turn. Defaults to "low". */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

/** A minimal, LangChain-`invoke`-compatible response. */
export interface ChatResponse {
  content: string;
}

// ── Lazy, process-wide singleton harness (one spawned Copilot runtime) ────────
let harnessPromise: Promise<CopilotHarness> | null = null;

function getHarness(): Promise<CopilotHarness> {
  if (!harnessPromise) {
    harnessPromise = createHarness({
      config: {
        // Keep the harness on the bare SDK surface — no built-in MCP servers.
        cliArgs: ["--disable-builtin-mcps"],
        // Floor the reasoning effort at null so the harness does NOT inject its
        // 'low' default into every session.create. Models that reject any effort
        // (e.g. claude-haiku-4.5) then get the field omitted; models that accept
        // it receive an explicit per-call override (see makeChat + the
        // effort-capability gate below).
        reasoningEffort: null,
        // No hard token ceiling: this is a batch audit tool. Track usage but
        // never block a run on the budget gate.
        tokenBudget: { maxTokens: null, enforcement: "warn" },
      },
    });
  }
  return harnessPromise;
}

/** Stop the shared harness (no-op if it was never created). Idempotent. */
export async function shutdownChat(): Promise<void> {
  if (!harnessPromise) return;
  const harness = await harnessPromise.catch(() => null);
  harnessPromise = null;
  effortCapableModelsPromise = null;
  if (harness) await harness.stop();
}

// ── Reasoning-effort capability gate ──────────────────────────────────────────
// Not every Copilot model accepts a reasoningEffort: passing it to one that does
// not (e.g. claude-haiku-4.5) makes session.create fail outright. We query the
// runtime's model list ONCE and remember which model ids advertise
// `capabilities.supports.reasoningEffort`, so we only send the field when it is
// actually supported.
let effortCapableModelsPromise: Promise<Set<string>> | null = null;

function effortCapableModels(harness: CopilotHarness): Promise<Set<string>> {
  if (!effortCapableModelsPromise) {
    effortCapableModelsPromise = (async () => {
      const supported = new Set<string>();
      try {
        const client = harness.client;
        if (client?.state !== "connected") await client?.start();
        const res: any = await client?.listModels();
        const list: Array<Record<string, any>> = Array.isArray(res)
          ? res
          : (res?.models ?? res?.data ?? []);
        for (const m of list) {
          const id = m?.id ?? m?.name;
          if (id && m?.capabilities?.supports?.reasoningEffort) supported.add(id);
        }
      } catch {
        // If the model list is unavailable, fall back to NOT sending effort
        // (the universally-safe choice — every model accepts its own default).
      }
      return supported;
    })();
  }
  return effortCapableModelsPromise;
}

/** Pull the text content out of a LangChain message (string or block array). */
function messageText(message: BaseMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  return typeof content === "string" ? content : String(content);
}

/**
 * Construct a chat client over the Copilot harness.
 *
 * The returned object mirrors the slice of the LangChain chat-model API the
 * nodes use: `await client.invoke([SystemMessage, HumanMessage])` → `{ content }`.
 */
export function makeChat({ model, reasoningEffort = "low" }: ChatOptions) {
  return {
    async invoke(messages: BaseMessage[]): Promise<ChatResponse> {
      const systemPrompt = messageText(
        messages.find((m) => m.getType() === "system"),
      );
      const userContent = messageText(
        messages.find((m) => m.getType() === "human"),
      );

      const harness = await getHarness();
      // Only attach reasoningEffort for models that advertise support for it —
      // sending it to a model that doesn't (e.g. claude-haiku-4.5) fails
      // session.create. See effortCapableModels().
      const supportsEffort = (await effortCapableModels(harness)).has(model);
      // Fresh session per call so this node's system prompt + model take effect
      // (createSession disconnects any prior session). chat() then reuses it.
      await harness.createSession({
        systemPrompt: systemPrompt || null,
        model,
        ...(reasoningEffort && supportsEffort ? { reasoningEffort } : {}),
      });
      const { content } = await harness.chat(userContent);
      return { content };
    },
  };
}
