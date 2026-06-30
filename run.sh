#!/usr/bin/env bash
# run.sh — Bootstrap entrypoint for cross-repo-deep-analysis-engine (Node/TS).
# Uses relative paths; never hard-codes host-specific absolute paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

# --- Node version check (>= 18.17 for global fetch) ---
NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
    echo "ERROR: node not found on PATH." >&2
    exit 2
fi

NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 18 ]; then
    echo "ERROR: Node 18.17+ required. Found: $("${NODE_BIN}" -v)" >&2
    exit 2
fi

# --- git is required for the clone node ---
if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git not found on PATH." >&2
    exit 2
fi

# --- Install deps if needed ---
cd "${SCRIPT_DIR}"
if [ ! -d "${SCRIPT_DIR}/node_modules" ]; then
    echo "Installing npm dependencies ..."
    npm install --silent
fi

# --- Load .env if present ---
if [ -f "${ENV_FILE}" ]; then
    echo "Loading environment from ${ENV_FILE} ..."
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
fi

# --- LLM auth note ---
# LLM nodes 5/6 run through the vendored llm-sdk-github-copilot harness (GitHub
# Copilot runtime). There is no provider API key to validate here — auth is the
# Copilot CLI's own (a prior `copilot` login, or COPILOT_CLI_PATH). An
# unauthenticated runtime surfaces its own error at the first LLM call.

# --- Run (forwards any args, e.g. --overwrite / --on-exist=continue) ---
exec npx tsx src/main.ts "$@"
