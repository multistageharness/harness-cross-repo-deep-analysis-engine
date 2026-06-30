/**
 * Node 4/7 — extract_repository_manifests (Code)
 *
 * Traverses the cloned repository directory and extracts:
 *
 *   1. Package manifests  -- package.json, requirements.txt, go.mod, pom.xml, *.lock, etc.
 *   2. CI/CD workflows    -- all files under .github/workflows/
 *   3. ONE random source file, selected by the dual guard:
 *        a. Extension allowlist: .py .ts .js .java .go .rs .md
 *        b. Size cap: files > MAX_RANDOM_FILE_BYTES are skipped (default 50 KB = 51200 bytes)
 *
 * Design decision record: logs/decisions.md
 *   "2026-06-30T15:43:54Z -- Random-file selection: extension allowlist + 50 KB size cap"
 *
 * Tunable constants:
 *   RANDOM_FILE_EXTENSIONS  -- set of allowed extensions
 *   MAX_RANDOM_FILE_BYTES   -- int read from MAX_RANDOM_FILE_BYTES env var (default 51200)
 *
 * State reads:  current_repo
 * State writes: extracted_files, last_step
 */

import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import * as path from "node:path";

import { banner, getLogger } from "../loggingSetup.js";
import type { WorkflowState } from "../state.js";

const log = getLogger("node-4");

// ── Tunable constants -- source of truth for the random-file selection rule ──
export const RANDOM_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".py",
  ".ts",
  ".js",
  ".java",
  ".go",
  ".rs",
  ".md",
]);

export const MAX_RANDOM_FILE_BYTES: number = parseInt(process.env.MAX_RANDOM_FILE_BYTES || "51200", 10); // 50 KB

// Manifest filenames to search for (exact match, case-sensitive).
export const MANIFEST_FILENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

// Directories to skip during traversal (hidden OS dirs, build artifacts, etc.)
const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  "target",
  ".idea",
  ".vscode",
]);

export async function extractRepositoryManifests(state: WorkflowState): Promise<Partial<WorkflowState>> {
  banner("Step 4/7 -- extract_repository_manifests");

  const currentRepo = state.current_repo || {};
  const cloneDir = currentRepo.clone_dir || "";
  if (!cloneDir) {
    throw new Error("state.current_repo.clone_dir is required but missing");
  }
  if (!safeIsDir(cloneDir)) {
    throw new Error(`Clone directory does not exist: ${cloneDir}`);
  }

  log.info(
    "Extracting manifests from %s (random-file cap=%d bytes, exts=%s)",
    cloneDir,
    MAX_RANDOM_FILE_BYTES,
    sortedExts().join(","),
  );
  console.log(`[node-4] Extracting from ${cloneDir} (random-file cap=${MAX_RANDOM_FILE_BYTES} bytes)`);

  const extractedFiles: Record<string, string> = {};
  const randomCandidates: string[] = [];

  const workflowParent = path.join(cloneDir, ".github", "workflows");

  for (const fpath of walk(cloneDir)) {
    const rel = path.relative(cloneDir, fpath);
    const base = path.basename(fpath);

    // ── Manifest detection ──────────────────────────────────────────────
    if (MANIFEST_FILENAMES.has(base)) {
      const content = safeRead(fpath);
      if (content !== null) {
        extractedFiles[rel] = content;
        log.info("  manifest: %s (%d bytes)", rel, content.length);
        console.log(`[node-4]   manifest: ${rel} (${content.length} bytes)`);
      }
      continue;
    }

    // ── Workflow detection ──────────────────────────────────────────────
    const isWorkflow = isInside(workflowParent, fpath);
    if (isWorkflow) {
      const content = safeRead(fpath);
      if (content !== null) {
        extractedFiles[rel] = content;
        log.info("  workflow: %s (%d bytes)", rel, content.length);
        console.log(`[node-4]   workflow: ${rel} (${content.length} bytes)`);
      }
      continue;
    }

    // ── Random-file candidate check (allowlist + size cap) ──────────────
    if (RANDOM_FILE_EXTENSIONS.has(path.extname(fpath).toLowerCase())) {
      let size: number;
      try {
        size = statSync(fpath).size;
      } catch {
        continue;
      }
      if (size <= MAX_RANDOM_FILE_BYTES) {
        randomCandidates.push(fpath);
      } else {
        log.debug("Skipping oversized random candidate: %s (%d bytes > %d)", rel, size, MAX_RANDOM_FILE_BYTES);
      }
    }
  }

  // ── Select one random source file ──────────────────────────────────────
  if (randomCandidates.length > 0) {
    const chosen = randomCandidates[Math.floor(Math.random() * randomCandidates.length)];
    const rel = path.relative(cloneDir, chosen);
    const content = safeRead(chosen);
    if (content !== null) {
      extractedFiles["__random__"] = content;
      extractedFiles["__random_path__"] = rel;
      log.info("Random file selected: %s (%d bytes, from %d candidates)", rel, content.length, randomCandidates.length);
      console.log(
        `[node-4] Random file selected: ${rel} (${content.length} bytes, ${randomCandidates.length} candidates)`,
      );
    }
  } else {
    log.info("No eligible random source file found (allowlist=%s, cap=%d bytes)", sortedExts().join(","), MAX_RANDOM_FILE_BYTES);
    console.log(
      `[node-4] No eligible random source file found (allowlist=${sortedExts().join(",")}, cap=${MAX_RANDOM_FILE_BYTES} bytes)`,
    );
  }

  const manifestCount = Object.keys(extractedFiles).filter((k) => !k.startsWith("__")).length;
  log.info("Extraction complete: %d files extracted", manifestCount);
  console.log(`[node-4] Extraction complete: ${manifestCount} files extracted`);

  return { extracted_files: extractedFiles, last_step: "extract_repository_manifests" };
}

function sortedExts(): string[] {
  return [...RANDOM_FILE_EXTENSIONS].sort();
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Yield all files under *root*, skipping SKIP_DIRS at any depth. */
function* walk(root: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** True if *child* is the workflow dir itself or any path beneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Read text from *fpath*, returning null on any error. */
function safeRead(fpath: string): string | null {
  try {
    return readFileSync(fpath, "utf-8");
  } catch (exc) {
    log.warning("Could not read %s: %s", fpath, String(exc));
    console.log(`[node-4] WARNING: could not read ${fpath}: ${exc}`);
    return null;
  }
}
