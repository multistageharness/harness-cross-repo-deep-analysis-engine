# cross-repo-deep-analysis-engine (Node/TS) Makefile
# Targets: help  install  run  dry-run  run-overwrite/continue/skip  test  typecheck  audit  clean

SRC  := src
ARGS ?=

.DEFAULT_GOAL := help

.PHONY: help install run dry-run run-overwrite run-continue run-skip test typecheck audit clean

help:
	@echo ""
	@echo "cross-repo-deep-analysis-engine (Node/TS)"
	@echo ""
	@echo "Targets:"
	@echo "  install        Install npm dependencies"
	@echo "  run            Run the full analysis pipeline (requires .env)"
	@echo "  dry-run        Preview repos list without cloning or LLM calls"
	@echo "  run-overwrite  Run, overwriting any existing .harness/<name> dir"
	@echo "  run-continue   Run, reusing any existing .harness/<name> clone"
	@echo "  run-skip       Run, skipping repos whose dir already exists"
	@echo "  test           Run the vitest unit suite (no network, no LLM)"
	@echo "  typecheck      Type-check the project with tsc --noEmit"
	@echo "  audit          Validate scaffold layout and conventions"
	@echo "  clean          Remove node_modules, .harness/, and dist/"
	@echo ""
	@echo "On-exist policy (existing .harness/<name>/ dir):"
	@echo "  make run ARGS=\"--overwrite\"   (or --continue / --skip / --on-exist=...)"
	@echo "  ON_EXIST=overwrite make run    (env-var equivalent; default: prompt)"
	@echo ""
	@echo "LLM auth: GitHub Copilot runtime (via vendored llm-sdk-github-copilot); no API key"
	@echo "Optional env vars: GITHUB_TOKEN, COPILOT_CLI_PATH, REPOS_FILE, DRY_RUN, ON_EXIST, LOG_LEVEL"
	@echo "See .env.example for full list."
	@echo ""

install:
	npm install
	@echo "Dependencies installed."

# ARGS is forwarded to the entrypoint, e.g.:
#   make run ARGS="--overwrite"
#   make run ARGS="--on-exist=continue"
# Equivalently: ON_EXIST=overwrite make run
run: install
	npx tsx src/main.ts $(ARGS)

dry-run: install
	DRY_RUN=1 npx tsx src/main.ts $(ARGS)

run-overwrite: install
	npx tsx src/main.ts --overwrite

run-continue: install
	npx tsx src/main.ts --continue

run-skip: install
	npx tsx src/main.ts --skip

test: install
	npm test

typecheck: install
	npm run typecheck

audit:
	@echo ""
	@echo "=== Scaffold audit: cross-repo-deep-analysis-engine (Node/TS) ==="
	@echo ""
	@test -f package.json          && echo "PASS  package.json"          || echo "FAIL  package.json missing"
	@test -f tsconfig.json         && echo "PASS  tsconfig.json"         || echo "FAIL  tsconfig.json missing"
	@test -f .env.example          && echo "PASS  .env.example"          || echo "FAIL  .env.example missing"
	@test -f .gitignore            && echo "PASS  .gitignore"            || echo "FAIL  .gitignore missing"
	@test -f Makefile              && echo "PASS  Makefile"              || echo "FAIL  Makefile missing"
	@test -f run.sh                && echo "PASS  run.sh"                || echo "FAIL  run.sh missing"
	@test -f README.md             && echo "PASS  README.md"             || echo "FAIL  README.md missing"
	@test -f CLAUDE.md             && echo "PASS  CLAUDE.md"             || echo "FAIL  CLAUDE.md missing"
	@test -f repos.yaml            && echo "PASS  repos.yaml"            || echo "FAIL  repos.yaml missing"
	@test -f src/main.ts           && echo "PASS  src/main.ts"           || echo "FAIL  src/main.ts missing"
	@test -f src/graph.ts          && echo "PASS  src/graph.ts"          || echo "FAIL  src/graph.ts missing"
	@test -f src/state.ts          && echo "PASS  src/state.ts"          || echo "FAIL  src/state.ts missing"
	@test -f src/shell.ts          && echo "PASS  src/shell.ts"          || echo "FAIL  src/shell.ts missing"
	@test -f src/loggingSetup.ts   && echo "PASS  src/loggingSetup.ts"   || echo "FAIL  src/loggingSetup.ts missing"
	@test -f src/nodes/initializeAndSortQueue.ts     && echo "PASS  node 1" || echo "FAIL  node 1 missing"
	@test -f src/nodes/cloneTargetRepo.ts            && echo "PASS  node 2" || echo "FAIL  node 2 missing"
	@test -f src/nodes/extractGitMetadata.ts         && echo "PASS  node 3" || echo "FAIL  node 3 missing"
	@test -f src/nodes/extractRepositoryManifests.ts && echo "PASS  node 4" || echo "FAIL  node 4 missing"
	@test -f src/nodes/analyzeStackAndDependencies.ts && echo "PASS  node 5" || echo "FAIL  node 5 missing"
	@test -f src/nodes/analyzeRandomContext.ts       && echo "PASS  node 6" || echo "FAIL  node 6 missing"
	@test -f src/nodes/generateAndSaveReport.ts      && echo "PASS  node 7" || echo "FAIL  node 7 missing"
	@test -f logs/decisions.md     && echo "PASS  logs/decisions.md"     || echo "FAIL  logs/decisions.md missing"
	@test -f logs/plan.md          && echo "PASS  logs/plan.md"          || echo "FAIL  logs/plan.md missing"
	@test -f logs/gaps.md          && echo "PASS  logs/gaps.md"          || echo "FAIL  logs/gaps.md missing"
	@test -f logs/enhancements.md  && echo "PASS  logs/enhancements.md"  || echo "FAIL  logs/enhancements.md missing"
	@grep -rn 'getLogger' $(SRC)/ > /dev/null 2>&1 \
		&& echo "PASS  dual-logging (structured logger)" \
		|| echo "FAIL  structured logger missing in src/"
	@grep -rn 'console.log(' $(SRC)/ > /dev/null 2>&1 \
		&& echo "PASS  dual-logging (console.log calls)" \
		|| echo "FAIL  console.log() calls missing in src/"
	@grep -rn 'shell: true' $(SRC)/ > /dev/null 2>&1 \
		&& echo "FAIL  shell:true found in src/ -- remove immediately" \
		|| echo "PASS  no shell:true"
	@grep -n 'Annotation.Root' $(SRC)/state.ts > /dev/null 2>&1 \
		&& echo "PASS  Annotation.Root state defined" \
		|| echo "FAIL  Annotation.Root missing in src/state.ts"
	@echo ""
	@echo "=== Audit complete ==="
	@echo ""

clean:
	rm -rf node_modules
	rm -rf .harness/
	rm -rf dist/
	@echo "Clean complete."
