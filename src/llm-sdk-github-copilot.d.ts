/**
 * Ambient type declaration for the vendored `llm-sdk-github-copilot` package.
 *
 * The package is authored in plain ESM (`.mjs`) and ships no `.d.ts`, so this
 * declares the narrow slice of its surface that this project consumes (the
 * `createHarness` factory + the harness methods used by `src/llm.ts`).
 *
 * Vendored via git subtree at ../../../vendors/llm-sdk-github-copilot and wired
 * as a `file:` dependency in package.json. Keep this in sync with the upstream
 * `src/index.mjs` exports if the consumed surface grows.
 */
declare module "llm-sdk-github-copilot" {
  export interface ReasoningEffort {}

  export interface ChatResult {
    /** User-facing answer (never the chain-of-thought). */
    content: string;
    /** Joined extended-thinking text, or null for non-thinking turns. */
    reasoning: string | null;
    thinking: { text: string; steps: string[] } | null;
    sessionId: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      durationMs: number;
    };
    /** Raw Copilot SDK sendAndWait result. */
    response: unknown;
  }

  export interface SessionOpts {
    systemPrompt?: string | null;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    streaming?: boolean;
    [key: string]: unknown;
  }

  export interface ChatOpts extends SessionOpts {
    timeout?: number;
    context?: Array<{ role: string; content: string }>;
  }

  /** Narrow slice of the underlying @github/copilot-sdk CopilotClient. */
  export interface CopilotClient {
    state?: string;
    start(): Promise<unknown>;
    listModels(): Promise<unknown>;
  }

  export class CopilotHarness {
    createSession(opts?: SessionOpts): Promise<unknown>;
    chat(prompt: string, opts?: ChatOpts): Promise<ChatResult>;
    stop(): Promise<unknown[]>;
    usageReport(): string;
    usageSummary(): Record<string, unknown>;
    get sessionId(): string | null;
    get client(): CopilotClient | null;
  }

  export interface CreateHarnessOptions {
    configFile?: string;
    config?: Record<string, unknown>;
    hooks?: Record<string, unknown>;
  }

  export function createHarness(
    options?: CreateHarnessOptions,
    deps?: Record<string, unknown>,
  ): Promise<CopilotHarness>;
}
