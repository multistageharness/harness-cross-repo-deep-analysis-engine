# vendors/

Locally vendored third-party packages, used as `file:` npm dependencies so
projects under `projects/` consume them without hitting an external registry.

## llm-sdk-github-copilot

Production harness around the GitHub Copilot SDK (chat, streaming, structured
I/O, tool calling, token budgets, session persistence, observability).

**Policy:** projects in this repo do **not** call GitHub Copilot — or any model
provider SDK (`@github/copilot-sdk`, `@langchain/anthropic`, `@anthropic-ai/sdk`)
— directly. All LLM access goes through this harness.

### Vendored via git subtree

```bash
# initial add (already done)
git subtree add  --prefix vendors/llm-sdk-github-copilot <remote> main --squash

# pull upstream updates later
git subtree pull --prefix vendors/llm-sdk-github-copilot <remote> main --squash
```

`<remote>` is `git@github.com:multistageharness/llm-sdk-github-copilot.git`
(use the `multistageharness` SSH key).

### Consuming it from a project

1. Add the dependency (path is relative to the project, which sits two levels
   under the repo root):

   ```json
   "dependencies": {
     "llm-sdk-github-copilot": "file:../../vendors/llm-sdk-github-copilot/packages/ts"
   }
   ```

2. Install the **vendored package's own** dependencies once, in place:

   ```bash
   ( cd vendors/llm-sdk-github-copilot/packages/ts && npm install )
   ```

   Required because Node resolves a symlinked `file:` package's imports from its
   real location — a plain `npm install` in the consuming project does **not**
   supply the harness's `@github/copilot-sdk`. The vendored package's
   `.gitignore` excludes `node_modules/`, so this stays out of git.

3. Use the harness:

   ```js
   import { createHarness } from 'llm-sdk-github-copilot';
   const harness = await createHarness({ config: { model: 'gpt-5-mini' } });
   try {
     const { content } = await harness.chat('What is 2 + 2?');
   } finally {
     await harness.stop();
   }
   ```

See `packages/ts/README.md` and `packages/ts/examples/` for the full surface.

**Reference consumer:** `projects/cross-repo-deep-analysis-engine-20260630-154354-ts`
(`src/llm.ts` wraps the harness behind a LangChain-message-shaped `makeChat()`).
