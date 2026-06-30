/**
 * constant.mjs — root configuration constants for git / GitHub access.
 *
 * Single source of truth for the credential and host the git clone node uses.
 * Set the values directly in this file (the DEFAULT_* below), or override them
 * at runtime with the matching environment variables — env wins, so existing
 * .env / CI-secret workflows keep working unchanged.
 *
 *   GIT_TOKEN         env GIT_TOKEN  >  env GITHUB_TOKEN  >  DEFAULT_GIT_TOKEN
 *   GITHUB_BASE_HOST  env GITHUB_BASE_HOST  >  DEFAULT_GITHUB_BASE_HOST
 *
 * Consumed by:
 *   - src/nodes/cloneTargetRepo.ts        (token injection + clone host)
 *   - src/nodes/initializeAndSortQueue.ts (default clone URL host)
 */

import { config as loadDotenv } from "dotenv";

// Load .env up front so values set there are visible regardless of where in the
// module import graph this file is first evaluated — it runs before main.ts's
// own dotenv call. dotenv never overrides an already-set process.env entry, so
// the later call in main.ts is a harmless no-op.
loadDotenv();

// ── Edit these to set values directly in the file ───────────────────────────
const DEFAULT_GIT_TOKEN = "";                   // e.g. "ghp_..."; "" → rely on env
const DEFAULT_GITHUB_BASE_HOST = "github.com";  // e.g. "github.mycorp.com" (GHES)

// ── Effective values: env override > file default ───────────────────────────

/**
 * Read-only GitHub token injected into HTTPS clone URLs for private repos.
 * Empty string means "no token" (public-repo clones still work).
 */
export const GIT_TOKEN = (
  process.env.GIT_TOKEN ||
  process.env.GITHUB_TOKEN ||
  DEFAULT_GIT_TOKEN
).trim();

/**
 * Hostname used to build/inject clone URLs (no scheme, no trailing slash).
 * Defaults to github.com; set to a GitHub Enterprise Server host to clone there.
 */
export const GITHUB_BASE_HOST = (
  process.env.GITHUB_BASE_HOST ||
  DEFAULT_GITHUB_BASE_HOST
).trim();
