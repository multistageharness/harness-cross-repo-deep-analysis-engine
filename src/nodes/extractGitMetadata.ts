/**
 * Node 3/7 — extract_git_metadata (Code)
 *
 * Queries the GitHub REST API to count branches, tags, and releases for the
 * current repo. Uses paginated list endpoints (100 items/page) to get accurate
 * counts for large repos.
 *
 * Falls back gracefully to 0 on any network or auth failure -- the failure is
 * logged but does NOT abort the pipeline (error_logs is NOT written here since
 * a metadata count failure is a warning, not a blocking error).
 *
 * State reads:  current_repo
 * State writes: git_metadata, last_step
 */

import { GIT_TOKEN } from "../../constant.mjs";
import { banner, getLogger } from "../loggingSetup.js";
import type { WorkflowState } from "../state.js";

const log = getLogger("node-3");

const GITHUB_API_BASE = process.env.GITHUB_API_URL || "https://api.github.com";

export async function extractGitMetadata(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 3/7 -- extract_git_metadata");

  const currentRepo = state.current_repo || {};
  const owner = currentRepo.owner || "";
  const name = currentRepo.name || "";

  if (!owner || !name) {
    throw new Error("state.current_repo must contain 'owner' and 'name'");
  }

  log.info("Fetching git metadata for %s/%s", owner, name);
  console.log(`[node-3] Fetching git metadata for ${owner}/${name}`);

  const headers = buildHeaders();

  const branches = await countPaginated(`${GITHUB_API_BASE}/repos/${owner}/${name}/branches`, headers);
  const tags = await countPaginated(`${GITHUB_API_BASE}/repos/${owner}/${name}/tags`, headers);
  const releases = await countPaginated(`${GITHUB_API_BASE}/repos/${owner}/${name}/releases`, headers);

  const gitMetadata = { branches, tags, releases };

  log.info("git_metadata for %s/%s: branches=%d tags=%d releases=%d", owner, name, branches, tags, releases);
  console.log(`[node-3] git_metadata: branches=${branches}, tags=${tags}, releases=${releases}`);

  return { git_metadata: gitMetadata, last_step: "extract_git_metadata" };
}

function buildHeaders(): Record<string, string> {
  const githubToken = GIT_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  }
  return headers;
}

/** Return the total item count across all pages of a GitHub list endpoint. */
async function countPaginated(url: string, headers: Record<string, string>): Promise<number> {
  let total = 0;
  let page = 1;
  for (;;) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let items: unknown;
      try {
        const fullUrl = `${url}?per_page=100&page=${page}`;
        const resp = await fetch(fullUrl, { headers, signal: controller.signal });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        items = await resp.json();
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(items) || items.length === 0) {
        break;
      }
      total += items.length;
      if (items.length < 100) {
        break;
      }
      page += 1;
    } catch (exc) {
      log.warning("Pagination error at %s page %d: %s", url, page, String(exc));
      console.log(`[node-3] WARNING: pagination error at ${url} page ${page}: ${exc}`);
      break;
    }
  }
  return total;
}
