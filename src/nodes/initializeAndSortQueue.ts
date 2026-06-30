/**
 * Node 1/7 — initialize_and_sort_queue (Code)
 *
 * Reads the input YAML/JSON of target repos, makes a lightweight GitHub API call
 * to fetch each repo's disk size in KB, then sorts repo_queue ascending
 * (smallest -> largest) so the pipeline processes the fastest repos first.
 *
 * State reads:  repos_file
 * State writes: repo_queue, last_step
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { GITHUB_BASE_HOST, GIT_TOKEN } from "../../constant.mjs";
import { banner, getLogger } from "../loggingSetup.js";
import type { RepoEntry, WorkflowState } from "../state.js";

const log = getLogger("node-1");

const GITHUB_API_BASE = process.env.GITHUB_API_URL || "https://api.github.com";

interface RawRepoEntry {
  owner?: string;
  name?: string;
  url?: string;
}

export async function initializeAndSortQueue(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 1/7 -- initialize_and_sort_queue");

  const reposFile = state.repos_file || "";
  if (!reposFile) {
    throw new Error("state.repos_file is required but missing");
  }

  log.info("Loading repo list from %s", reposFile);
  console.log(`[node-1] Loading repos from ${reposFile}`);

  const ext = path.extname(reposFile).toLowerCase();
  const text = readFileSync(reposFile, "utf-8");
  let raw: unknown;
  if (ext === ".yaml" || ext === ".yml") {
    raw = parseYaml(text);
  } else if (ext === ".json") {
    raw = JSON.parse(text);
  } else {
    throw new Error(`Unsupported repos file format: ${JSON.stringify(ext)}. Use .yaml or .json.`);
  }

  const reposRaw: RawRepoEntry[] = Array.isArray(raw)
    ? (raw as RawRepoEntry[])
    : (((raw as Record<string, unknown>)?.repos as RawRepoEntry[]) ?? []);

  if (!Array.isArray(reposRaw) || reposRaw.length === 0) {
    throw new Error("repos file must contain a non-empty list of repo entries");
  }

  // Build request headers -- GitHub token is optional but recommended.
  // GIT_TOKEN resolves from constant.mjs (env GIT_TOKEN > GITHUB_TOKEN > file).
  const githubToken = GIT_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    headers.Authorization = `Bearer ${githubToken}`;
  } else {
    log.warning("GITHUB_TOKEN not set -- GitHub API rate limits apply (60 req/hr unauthenticated)");
    console.log("[node-1] WARNING: GITHUB_TOKEN not set; unauthenticated API rate limits apply");
  }

  const repoQueue: RepoEntry[] = [];
  for (const entry of reposRaw) {
    const owner = (entry.owner || "").trim();
    const name = (entry.name || "").trim();
    const url = entry.url || `https://${GITHUB_BASE_HOST}/${owner}/${name}.git`;

    if (!owner || !name) {
      log.warning("Skipping entry with missing owner/name: %s", JSON.stringify(entry));
      console.log(`[node-1] WARNING: skipping entry missing owner/name: ${JSON.stringify(entry)}`);
      continue;
    }

    const sizeKb = await fetchRepoSize(owner, name, headers);
    repoQueue.push({ owner, name, url, size_kb: sizeKb });
    log.info("  queued %s/%s -- %d KB", owner, name, sizeKb);
    console.log(`[node-1]   queued ${owner}/${name} -- ${sizeKb} KB`);
  }

  if (repoQueue.length === 0) {
    throw new Error("No valid repos found after parsing the repos file");
  }

  repoQueue.sort((a, b) => a.size_kb - b.size_kb);

  log.info("Queue sorted: %d repos (smallest first)", repoQueue.length);
  console.log(`[node-1] Queue sorted: ${repoQueue.length} repos (smallest first)`);
  repoQueue.forEach((r, i) => {
    console.log(`[node-1]   ${i + 1}. ${r.owner}/${r.name} (${r.size_kb} KB)`);
  });

  return { repo_queue: repoQueue, last_step: "initialize_and_sort_queue" };
}

/** Return the GitHub-reported size in KB, or 0 on any failure. */
async function fetchRepoSize(owner: string, name: string, headers: Record<string, string>): Promise<number> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${name}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const body = (await resp.json()) as { size?: number };
      return Math.trunc(body.size ?? 0);
    } finally {
      clearTimeout(timer);
    }
  } catch (exc) {
    log.warning("Could not fetch size for %s/%s: %s -- defaulting to 0", owner, name, String(exc));
    console.log(`[node-1] WARNING: could not fetch size for ${owner}/${name}: ${exc}`);
    return 0;
  }
}
