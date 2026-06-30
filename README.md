# cross-repo-deep-analysis-engine (Node/TS)

A bulk-auditing workflow that extracts a list of target GitHub repos, clones
each one, extracts manifests and git metadata, runs LLM analysis, and writes
per-repo reports -- gracefully handling clone and extraction failures so the
loop continues.

This is the **Node/TypeScript port** of the sibling Python project
(`../cross-repo-deep-analysis-engine-20260630-154354-py`). Same 7-node graph,
same routing, same defensive guards — built on LangGraph.js instead of Python
LangGraph.

**Harness:** Agent + Helpers (see `CLAUDE.md` for architecture rationale).

---

## What it does

1. Reads a YAML or JSON list of target GitHub repositories.
2. Fetches each repo's disk size from the GitHub API and sorts the queue
   ascending (smallest first) to front-load fast repos.
3. For each repo -- shallow-clones it (`git clone --depth 1`), extracts package
   manifests and CI/CD workflows, selects one random source file, runs two LLM
   analysis passes (stack + random-file context), and writes a Markdown report.
4. On clone failure, appends the error to `error_logs` and moves to the next repo
   -- the batch never aborts on a single failure.
5. Writes all generated artifacts under the root `.harness/` directory:
   `.harness/<repo_name>/report/analysis.md` and
   `.harness/<repo_name>/.harness/analysis_<ts>.json` (the clone itself lives at
   `.harness/<repo_name>/`).

---

## Prerequisites

- Node.js 18.17+ (for global `fetch`)
- `git` on PATH
- GitHub Copilot access for nodes 5/6 — LLM calls go through the vendored
  `llm-sdk-github-copilot` harness (Copilot runtime). Auth is the Copilot CLI's
  own (a prior `copilot` login, or `COPILOT_CLI_PATH`); **no provider API key**.
- Optional: GitHub personal access token (avoids rate limits; enables private repos)

---

## Setup

```bash
cd projects/cross-repo-deep-analysis-engine-20260630-154354-ts

# 1. Install dependencies
make install            # or: npm install

# 2. Install the vendored LLM SDK's own deps (in place, one-time)
#    Node resolves the symlinked package's imports from its real location, so the
#    Copilot SDK must be installed under the vendored package, not this project.
( cd ../../vendors/llm-sdk-github-copilot/packages/ts && npm install )

# 3. Configure environment
cp .env.example .env
# Edit .env -- set GITHUB_TOKEN (recommended). No provider API key needed; LLM
# auth is the Copilot runtime's own (prior `copilot` login or COPILOT_CLI_PATH).
```

---

## Running

```bash
# Full run (clones repos, calls LLM, writes reports)
make run                # or: ./run.sh   |   npm start

# Dry-run preview (parses repos.yaml, prints list -- no clone, no LLM)
make dry-run            # or: npm run dry-run

# Unit tests (deterministic code nodes only -- no network, no LLM, no key)
make test

# Type-check
make typecheck

# Scaffold audit (verifies all required files and conventions)
make audit
```

To analyze a different set of repos, edit `repos.yaml` or point to another file:

```bash
REPOS_FILE=my-repos.json make run
```

### On-exist collision policy

When a clone directory already exists under `.harness/<name>/`, the engine
applies a collision policy. The default is **`prompt`** — it asks interactively:

```
[node-2] Directory already exists: .harness/PLAYGROUND_PYTHON
[node-2] Repo carlosmarte/PLAYGROUND_PYTHON -- choose an action:
           [s] skip      -- do not process this repo
           [c] continue  -- reuse the existing clone as-is
           [o] overwrite -- delete the directory and re-clone
[node-2] [s/c/o]?
```

To run non-interactively, pre-select the policy via a CLI flag or env var.
Precedence: **CLI flag > `ON_EXIST` env var > `prompt`**. In a non-TTY context
(CI, piped stdin) with no flag set, `prompt` falls back to `skip` (non-destructive).

```bash
make run ARGS="--overwrite"      # delete + re-clone existing dirs
make run ARGS="--continue"       # reuse existing clones (no re-clone)
make run ARGS="--skip"           # skip repos whose dir already exists
make run ARGS="--on-exist=overwrite"   # long form

# Convenience targets:
make run-overwrite
make run-continue
make run-skip

# Env-var equivalent:
ON_EXIST=overwrite make run
```

| Policy | Behavior | Counted as error? |
|---|---|---|
| `skip` | Don't process the repo; move to the next | No |
| `continue` | Reuse the existing clone as-is (no re-clone) | No |
| `overwrite` | Delete the directory, then clone fresh | No |
| `prompt` (default) | Ask interactively; non-TTY → `skip` | No |

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `COPILOT_CLI_PATH` | No | -- | Path to a Copilot CLI entry for the harness runtime (else bundled runtime + ambient auth) |
| `GITHUB_TOKEN` | No | -- | GitHub PAT; avoids rate limits + enables private repos |
| `REPOS_FILE` | No | `repos.yaml` | Path to repos YAML or JSON input file |
| `ANALYSIS_MODEL` | No | `claude-opus-4.8` | Copilot model id for stack analysis (node 5) |
| `ANALYSIS_EFFORT` | No | `medium` | Reasoning effort for node 5 (low/medium/high/xhigh) |
| `ANALYSIS_MAX_TOKENS` | No | `2048` | Advisory output-size hint for node 5 (no hard cap) |
| `CONTEXT_MODEL` | No | `claude-haiku-4.5` | Copilot model id for random-file context (node 6) |
| `CONTEXT_EFFORT` | No | `low` | Reasoning effort for node 6 (low/medium/high/xhigh) |
| `CONTEXT_MAX_TOKENS` | No | `512` | Advisory output-size hint for node 6 (no hard cap) |
| `MAX_RANDOM_FILE_BYTES` | No | `51200` | Max source file size for random selection (50 KB) |
| `GITHUB_API_URL` | No | `https://api.github.com` | GitHub REST API base (nodes 1 + 3) |
| `LOG_LEVEL` | No | `INFO` | `DEBUG`, `INFO`, `WARNING`, or `ERROR` |
| `DRY_RUN` | No | -- | Set to `1` to skip clone + LLM (preview only) |
| `ON_EXIST` | No | `prompt` | `prompt` \| `skip` \| `continue` \| `overwrite` for existing dirs |

---

## Input format (`repos.yaml`)

```yaml
repos:
  - owner: thinkeloquent
    name: sandbox-langchain-langgraph
    url: https://github.com/thinkeloquent/sandbox-langchain-langgraph.git
```

`url` is optional and defaults to `https://github.com/<owner>/<name>.git`.

---

## Output layout

All generated files live under the root `.harness/` directory:

```
.harness/
  <repo_name>/             # Shallow clone of the repo
    report/
      analysis.md          # Human-readable Markdown report
    .harness/
      analysis_<ts>.json   # Raw structured data (git_metadata + llm_analysis)
```

---

## Project layout

```
cross-repo-deep-analysis-engine-20260630-154354-ts/
├── CLAUDE.md              # Harness architecture declaration
├── Makefile               # help / install / run / dry-run / test / typecheck / audit / clean
├── README.md
├── run.sh                 # Bootstrap entrypoint (node version + env checks)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example           # All env vars documented
├── .gitignore
├── repos.yaml             # Sample input
├── logs/
│   ├── decisions.md       # Irreversible design choices
│   ├── plan.md            # Implementation plan
│   ├── gaps.md            # Known limitations
│   └── enhancements.md    # Future improvement ideas
├── tests/
│   ├── shell.test.ts                # Defensive subprocess wrapper
│   └── extractManifests.test.ts     # Manifest hunt + random-file dual guard
└── src/
    ├── main.ts            # Entrypoint
    ├── graph.ts           # StateGraph topology (7 nodes, conditional edges)
    ├── state.ts           # WorkflowState (Annotation.Root)
    ├── shell.ts           # Defensive subprocess wrapper (no shell)
    ├── llm.ts             # makeChat() — adapter over the vendored Copilot harness
    ├── loggingSetup.ts    # configureLogging(), getLogger(), banner()
    └── nodes/
        ├── initializeAndSortQueue.ts      # Node 1 (Code)
        ├── cloneTargetRepo.ts             # Node 2 (Code)
        ├── extractGitMetadata.ts          # Node 3 (Code)
        ├── extractRepositoryManifests.ts  # Node 4 (Code)
        ├── analyzeStackAndDependencies.ts # Node 5 (LLM)
        ├── analyzeRandomContext.ts        # Node 6 (LLM)
        └── generateAndSaveReport.ts       # Node 7 (Code)
```

---

## Defensive behaviour

- **No shell:** All subprocess calls go through `src/shell.ts:run()`, which uses
  `spawnSync` with `shell: false` and an explicit argv array. The function
  validates `cwd`, captures stdout/stderr, and throws `ShellError` on non-zero
  exits.
- **Clone failure isolation:** A failed clone appends to `error_logs` and the
  graph routes to the next repo -- the batch never aborts.
- **Random-file dual guard:** Node 4 restricts random file selection to a
  source-code extension allowlist (`.py .ts .js .java .go .rs .md`) AND a 50 KB
  size cap (`MAX_RANDOM_FILE_BYTES`). Files exceeding the cap are skipped, not
  truncated.
- **Atomic report writes:** Node 7 writes to a tmp file then `renameSync()` --
  readers never see a partial analysis.md or JSON file.
- **LLM via vendored harness:** nodes 5/6 call the `llm-sdk-github-copilot`
  harness (`src/llm.ts`), never a provider SDK; auth is the Copilot runtime's
  own, so there is no API-key precheck. The harness is stopped cleanly on exit.
- **Dual logging:** Every node boundary is announced by `banner()` (structured
  log + `console.log`) so the pipeline is traceable in both log files and live
  terminal output.

---

## Known limits

See `logs/gaps.md` for the full list. Key gaps:

- GitHub Enterprise Server (GHES) clone-host support requires code changes
  (`GITHUB_API_URL` is parameterized; the clone host `github.com` is not yet).
- No retry on transient network errors (403 rate-limit, 502, timeout).
- No batch summary report across all repos after the queue is exhausted.
- SSH-based clone auth (deploy keys) is not supported -- only HTTPS token injection.
