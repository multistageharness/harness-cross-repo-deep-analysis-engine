---
name: cross-repo-deep-analysis-engine
description: Drive this repo's LangGraph.js bulk repo-audit engine — ingest a target repo list (from repos.yaml, a JSON/YAML file via REPOS_FILE, an inline array, or generated from another source like a GitHub org), then clone, extract manifests + git metadata, run LLM stack/context analysis, and read the per-repo reports under .harness/. Use when the user asks to analyze/audit a set of GitHub repos, configure or ingest the repo list, run the engine, change the on-exist policy, or interpret its output.
---

# cross-repo-deep-analysis-engine

A LangGraph.js 7-node pipeline that bulk-audits GitHub repos: it ingests a list
of target repos, clones each, extracts manifests + git metadata, runs two LLM
analysis passes, and writes a per-repo Markdown + JSON report — never aborting the
batch on a single clone failure.

**Harness style:** Agent + Helpers. LLM nodes (5/6) reason; code nodes (1–4, 7)
do the deterministic, fragile work (clone, parse, file IO).

This skill is about *driving* the engine. The single most common task is
**ingesting the repo list** — everything downstream is automatic once the list is
in place. Start there.

---

## 1. Ingest the repo list (the primary input)

Node 1 (`src/nodes/initializeAndSortQueue.ts`) reads one input file, resolves
each entry, fetches each repo's disk size from the GitHub API, and sorts the
queue ascending (smallest first). Pick whichever source fits:

### a. Edit the default `repos.yaml`
The keyed-map form. `url` is optional and defaults to
`https://github.com/<owner>/<name>.git`.
```yaml
repos:
  - owner: thinkeloquent
    name: sandbox-langchain-langgraph
  - owner: carlosmarte
    name: PLAYGROUND_PYTHON
    url: https://github.com/carlosmarte/PLAYGROUND_PYTHON.git   # optional
```

### b. Point at another file via `REPOS_FILE`
Any `.yaml`, `.yml`, or `.json` path. Other extensions throw.
```bash
REPOS_FILE=./my-repos.json make run
```

### c. JSON, in either of two shapes
Node 1 accepts a top-level `{ "repos": [...] }` **or** a bare top-level array:
```json
[
  { "owner": "carlosmarte", "name": "app-Clipboard2MD" },
  { "owner": "carlosmarte", "name": "examples-llamaIndex" }
]
```

### d. Generate the list from another source
To audit an entire GitHub org/user instead of a hand-written list, generate the
input file first, then feed it via `REPOS_FILE`. Example — all repos for a user:
```bash
gh repo list <owner> --limit 200 --json owner,name \
  --jq '{repos: [.[] | {owner: .owner.login, name: .name}]}' \
  > generated-repos.json
REPOS_FILE=./generated-repos.json make run
```
Any source works (a CSV, a Jira export, another agent skill's output) as long as
the final artifact is YAML/JSON in one of the shapes above. Each entry needs only
`owner` + `name`; entries missing either are skipped with a warning, not fatal.

> **Sizing:** Node 1 calls `GET /repos/<owner>/<name>` for each entry. Without
> `GITHUB_TOKEN` you get 60 req/hr unauthenticated — set a token for any list of
> real size. A failed size lookup defaults to `0 KB` (sorted first), not an error.

---

## 2. Setup (one-time)

```bash
make install                                                   # project deps
( cd vendors/llm-sdk-github-copilot/packages/ts && npm install )  # vendored SDK deps
cp .env.example .env                                           # then edit .env
```
LLM auth is the **GitHub Copilot runtime's own** (a prior `copilot` login or
`COPILOT_CLI_PATH`) — there is **no provider API key**. Set `GITHUB_TOKEN` in
`.env` to lift API rate limits and reach private repos.

---

## 3. Run

```bash
make dry-run            # parse + sort the list, print it — no clone, no LLM
make run                # full pipeline
make test               # vitest unit suite (deterministic nodes; no net/LLM)
make typecheck          # tsc --noEmit
make audit              # scaffold/convention check
```
`make run` forwards `ARGS`; `./run.sh` and `npm start` are equivalent entrypoints.

### On-exist policy (existing `.harness/<name>/` clone)
Precedence: **CLI flag > `ON_EXIST` env > `prompt` (default)**. In a non-TTY
context with no flag, `prompt` falls back to `skip` (non-destructive).
```bash
make run ARGS="--overwrite"        # delete + re-clone   (also --continue / --skip)
make run ARGS="--on-exist=skip"    # long form
make run-overwrite                 # convenience target  (run-continue / run-skip)
ON_EXIST=continue make run         # env-var form
```
| Policy | Behavior |
|---|---|
| `skip` | Don't process the repo; next |
| `continue` | Reuse the existing clone as-is |
| `overwrite` | Delete the dir, clone fresh |
| `prompt` (default) | Ask; non-TTY → `skip` |

---

## 4. Read the output

Everything lands under the root `.harness/` directory:
```
.harness/<repo_name>/                     # shallow clone (git clone --depth 1)
  report/analysis.md                      # human-readable report
  .harness/analysis_<ts>.json             # raw git_metadata + llm_analysis
```
Reports are written atomically (tmp file + `renameSync`), so a present file is
always complete. Clone/extraction failures are appended to `error_logs` and the
graph routes to the next repo — check the run's tail for the per-repo error list.

---

## 5. Key env vars

Full list in `.env.example` / README. Most-used:

| Variable | Default | Purpose |
|---|---|---|
| `REPOS_FILE` | `repos.yaml` | Input list path (`.yaml`/`.yml`/`.json`) |
| `GITHUB_TOKEN` | — | PAT; lifts rate limits, enables private repos |
| `COPILOT_CLI_PATH` | — | Copilot CLI entry for the LLM runtime |
| `ON_EXIST` | `prompt` | `prompt`/`skip`/`continue`/`overwrite` |
| `DRY_RUN` | — | `1` = parse + preview only |
| `ANALYSIS_MODEL` | `claude-opus-4.8` | Node 5 (stack) model |
| `CONTEXT_MODEL` | `claude-haiku-4.5` | Node 6 (random-file) model |
| `MAX_RANDOM_FILE_BYTES` | `51200` | Node 4 random-file size cap (50 KB) |
| `GITHUB_API_URL` | `https://api.github.com` | REST base (nodes 1 + 3) |
| `LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARNING`/`ERROR` |

---

## 6. The 7-node graph (orientation)

1. **initialize_and_sort_queue** (code) — ingest list, fetch sizes, sort asc.
2. **clone_target_repo** (code) — `git clone --depth 1`; on-exist policy; failure → next repo.
3. **extract_git_metadata** (code) — git + GitHub API metadata.
4. **extract_repository_manifests** (code) — package manifests + CI workflows; pick one random source file (extension allowlist + 50 KB cap).
5. **analyze_stack_and_dependencies** (LLM) — stack/deps pass.
6. **analyze_random_context** (LLM) — random-file context pass.
7. **generate_and_save_report** (code) — atomic Markdown + JSON write, then loop to next repo.

All subprocess calls go through `src/shell.ts` (`spawnSync`, `shell: false`) — no
shell interpolation. Topology is in `src/graph.ts`; state in `src/state.ts`.

---

## Gotchas

- **Vendored SDK deps install separately** — `node_modules` for the Copilot SDK
  live under `vendors/llm-sdk-github-copilot/packages/ts`, not the project root.
- **No retry** on transient GitHub errors (403/502/timeout) — re-run for those.
- **HTTPS-only clone auth** — SSH deploy keys and GHES clone hosts are not
  supported (`GITHUB_API_URL` is parameterized; the clone host is not). See
  `logs/gaps.md`.
