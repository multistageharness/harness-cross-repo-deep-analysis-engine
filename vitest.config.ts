import { defineConfig } from "vitest/config";

// Unit tests exercise pure deterministic code only — no network, no LLM, no
// git clone, no API key required. They mirror the code-node guards from the
// Python original (shell wrapper, manifest walk + random-file dual guard).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
