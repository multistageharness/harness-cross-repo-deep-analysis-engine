/**
 * Type declaration for the root `constant.mjs` config module.
 *
 * `constant.mjs` is plain ESM and ships no inline types; this sibling `.d.mts`
 * lets `tsc --noEmit` type-check the `../../constant.mjs` imports in src/nodes/.
 * Mirrors the project's existing vendored-JS declaration pattern
 * (src/llm-sdk-github-copilot.d.ts). Keep in sync with constant.mjs's exports.
 */

/** Read-only GitHub token injected into HTTPS clone URLs (empty = none). */
export const GIT_TOKEN: string;

/** Clone host (no scheme / trailing slash), e.g. "github.com" or a GHES host. */
export const GITHUB_BASE_HOST: string;
