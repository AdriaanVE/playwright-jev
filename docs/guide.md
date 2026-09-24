# playwright-jev guide

This guide covers how `playwright-jev` fits into a project that already uses Playwright, how each part is
wired in, and how to roll it out safely. The [README](../README.md) is the short reference.

- [How it combines with Playwright](#how-it-combines-with-playwright)
- [Quick start](#quick-start)
- [Adopting it step by step](#adopting-it-step-by-step)
- [CI pipeline](#ci-pipeline)
- [Playwright agents and MCP](#playwright-agents-and-mcp)
- [Configuration reference](#configuration-reference)
- [Writing a custom provider](#writing-a-custom-provider)
- [What gets sent to the provider](#what-gets-sent-to-the-provider)
- [Troubleshooting](#troubleshooting)

## How it combines with Playwright

You keep Playwright as it is. `playwright-jev` is a dev dependency that plugs into four places Playwright
already exposes. Each part is opt-in and independent.

| You change | To get | Playwright extension point |
| --- | --- | --- |
| `reporter` in `playwright.config.ts` | Triage, smart retries, healer gate (1 to 3) | Custom reporter |
| `import { test, expect } from "playwright-jev/test"` in specs | Locator healing, `toSatisfy` (6, 7) | `test.extend` fixtures and `expect.extend` |
| The MCP server your agent starts | Snapshot pruning, step verification (4, 5) | MCP proxy in front of Playwright's server |
| The spec list you pass to `playwright test` | Impact ordering (8) | Command-line file arguments |

What stays the same:

- You still run `npx playwright test`. No wrapper command is required.
- Specs that keep importing from `@playwright/test` behave exactly as before. Only specs that import from
  `playwright-jev/test` get healing and `toSatisfy`, so you can migrate one file at a time.
- Playwright's own planner, generator, and healer agents still do the planning and code editing.
  `playwright-jev` decides which failures reach them and trims what they read.
- With `PLAYWRIGHT_JEV_DISABLED=1`, every part turns off, and the suite behaves like plain Playwright.

```
                      playwright.config.ts
                              │
   specs ── import ── playwright-jev/test ── page fixture (heal) + expect.toSatisfy
                              │                        │
                     npx playwright test               │ decisions
                              │                        ▼
                  playwright-jev/reporter ────────► DecisionProvider ◄──── playwright-jev mcp
                              │                (OpenRouter JEV, HTTP,      (agent's MCP server)
                              ▼                 or your module)
             .playwright-jev/triage.md, retry.json, heal.json
                              │
          playwright-jev retry          playwright-jev heal
      (--last-failed on transient)   (your healer on healable)
```

## Quick start

```sh
npm install -D playwright-jev
export OPENROUTER_API_KEY=...
```

Add the reporter, and let `playwright-jev` decide what to rerun:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test"

export default defineConfig({
  retries: 0,
  reporter: [["list"], ["playwright-jev/reporter"]],
})
```

Run your suite as usual. When tests fail, you get a triage table:

```sh
npx playwright test
cat .playwright-jev/triage.md
```

```
| Test | Cause | Confidence | Next step |
| --- | --- | --- | --- |
| checkout.spec.ts > applies coupon | locator_drift | 58% | healer |
| search.spec.ts > loads results | environment | 100% | rerun |
| cart.spec.ts > shows total | assertion_outdated | 81% | healer |
```

That run needs no config file. Add `playwright-jev.config.ts` next to `playwright.config.ts` once you want
to change the provider or thresholds.

## Adopting it step by step

Each step is useful on its own. The order goes from no effect on test results to the most effect.

### 1. Triage only

Add the reporter as in the quick start. It never changes test results. Read `triage.md` for a week and
check the categories against what you find when you debug. Adjust `triage.categories` if your suite
fails in ways the defaults do not name, for example a `feature_flag` category.

### 2. Smart retries

Replace blanket retries with a targeted rerun:

```sh
npx playwright test || npx playwright-jev retry
```

`retry.json` uses the same format as Playwright's `.last-run.json`, so `retry` runs
`npx playwright test --last-failed --last-failed-file .playwright-jev/retry.json`. Arguments after `--` are
passed through, for example `npx playwright-jev retry -- --project=chromium`.

A failure is rerun when the combined probability of the `transient` categories (default `timing` and
`environment`) reaches `retry.threshold` (default 0.8).

### 3. Healer gate

Send only healable failures to an LLM healer:

```ts
// playwright-jev.config.ts
import { defineConfig } from "playwright-jev"

export default defineConfig({
  healerGate: {
    threshold: 0.7,
    command: "claude -p --agent playwright-test-healer 'Fix these failing Playwright tests: {tests} in {files}'",
  },
})
```

```sh
npx playwright-jev heal --dry-run   # list what would be healed
npx playwright-jev heal             # run the command
```

`{tests}` expands to the test titles and `{files}` to the spec paths, each quoted as a shell word. The
command also receives `PLAYWRIGHT_JEV_HEAL_FILE`, the path to `heal.json`, for healers that read JSON.
Failures triaged as `app_bug` or `test_data` go to a person instead, with the triage attached.

To create the healer agent for Claude Code, run `npx playwright init-agents --loop=claude` once. It adds
`.claude/agents/playwright-test-healer.md` and an `.mcp.json` entry.

### 4. Semantic assertions

Import from `playwright-jev/test` in the specs where exact text matching is brittle:

```ts
import { expect, test } from "playwright-jev/test"

test("order summary", async ({ page }) => {
  await page.goto("/checkout")
  await expect(page).toSatisfy('The order summary lists 3 items and a total')
  await expect(page.getByRole("dialog")).not.toSatisfy("The dialog shows an error")
})
```

`toSatisfy` reads the accessibility tree, retries until `assertions.timeoutMs`, and passes when the
probability reaches `assertions.threshold` (default 0.9). Use it for claims about meaning, and keep
`toHaveText` for exact values such as prices.

### 5. Locator healing

Healing starts in `report` mode, which never changes a result:

```ts
export default defineConfig({ locatorHealing: { mode: "report" } })
```

When a locator in a `playwright-jev/test` spec matches nothing, the fixture records which current element
JEV thinks was meant. You can read it in the report annotations (`jev-heal`) and in the `jevHealEvents`
fixture. Once the suggestions look right, switch to enforce locally, and keep CI strict:

```ts
export default defineConfig({ locatorHealing: { mode: "enforce", threshold: 0.55, failInCI: true } })
```

With `failInCI`, a healed test still fails when `CI` is set, and the error lists each old and suggested
locator. Drift gets fixed in source instead of being hidden.

Scope and limits:

- Healing covers action methods (`click`, `fill`, `check`, `press`, `hover`, `selectOption`, and similar)
  on locators created from `page`, including chains such as `page.getByRole("main").getByLabel(...)`.
- It does not cover web-first assertions (`expect(locator).toHaveText(...)`), `frameLocator`, locators
  from `locator.all()`, or pages from events such as `popup`.
- Only a locator that matches nothing heals. Strict-mode violations and elements that exist but cannot
  be clicked fail as usual.
- If you pass `{ timeout }` to an action, healing stays within it.

### 6. Impact ordering

Run the specs most related to a pull request first:

```sh
npx playwright test $(npx playwright-jev impact --base origin/main --dir tests)
```

Every spec is still listed, so nothing is skipped. Combine it with `--max-failures` for fast feedback on
pull requests, and run the full suite unchanged on main.

## CI pipeline

A GitHub Actions job that uses triage, targeted retries, and the healer gate:

```yaml
- run: npx playwright test
  id: e2e
  continue-on-error: true
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}

- name: Rerun transient failures
  if: steps.e2e.outcome == 'failure'
  run: npx playwright-jev retry
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}

- name: Triage summary
  if: always()
  run: cat .playwright-jev/triage.md >> "$GITHUB_STEP_SUMMARY" || true
```

The job fails if the retry step fails. Run the healer gate in a separate, manually triggered job,
because it edits test files.

To make decisions reproducible across runs, commit `.playwright-jev/cache/` and set
`cache: { mode: "read-only" }` in CI. New decisions are still made, but not written, so CI never changes
the committed cache.

## Playwright agents and MCP

Playwright's agents (`npx playwright init-agents`) talk to `npx playwright run-test-mcp-server`. Coding
agents that drive a browser directly usually use `@playwright/mcp`. The proxy works in front of either.

For Playwright's agents, edit the `.mcp.json` that `init-agents` created:

```json
{
  "mcpServers": {
    "playwright-test": {
      "command": "npx",
      "args": ["playwright-jev", "mcp", "--", "npx", "playwright", "run-test-mcp-server"]
    }
  }
}
```

Keep the server name `playwright-test`, because the agent definitions list tools as
`mcp__playwright-test__…`.

For `@playwright/mcp` (the default upstream):

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["playwright-jev", "mcp"] }
  }
}
```

The proxy passes every tool through, and only rewrites snapshots in results:

- Call `jev_set_goal` with the current goal, or add `jev_goal` to any tool call. Snapshots larger than
  `snapshotPruning.minChars` are split into regions, and regions scored below `keepScore` collapse to one
  line that keeps their element refs.
- Add `jev_full_snapshot: true` to a call when the agent needs the whole tree.
- Call `jev_verify_step` with `step` and `expected` to check an outcome without reading the snapshot.
  Describe the outcome, for example "checkout page with a payment form", not a button label.

The agents do not know about these tools by default. Add a line to their instructions, or use the skill
in [`skills/playwright-jev`](../skills/playwright-jev/SKILL.md).

Pruning logs to stderr, for example `pruned browser_navigate: 14135 -> 251 chars`.

## Configuration reference

`playwright-jev.config.{ts,mjs,js,json}` is found in the working directory, or set
`PLAYWRIGHT_JEV_CONFIG`. Relative paths inside it resolve against the file's directory. A config passed
as reporter options (`["playwright-jev/reporter", { ... }]`) replaces the file for the reporter.

| Key | Default | Purpose |
| --- | --- | --- |
| `provider` | `{ type: "openrouter" }` | Decision backend, see below |
| `cache.mode` | `"read-write"` | `"read-write"`, `"read-only"`, or `"off"` |
| `cache.dir` | `.playwright-jev/cache` | Decision cache directory |
| `concurrency` | `4` | Maximum parallel decision calls per process |
| `outputDir` | `.playwright-jev` | Reports and handoff files |
| `triage.categories` | 6 defaults | Root-cause keys and descriptions |
| `triage.transient` | `timing`, `environment` | Categories a rerun can fix |
| `triage.healable` | `locator_drift`, `timing`, `assertion_outdated` | Categories a healer can fix |
| `triage.diffBase` | none | Git ref whose diff is added as context |
| `retry.threshold` | `0.8` | Minimum transient probability to rerun |
| `healerGate.threshold` | `0.7` | Minimum healable probability to heal |
| `healerGate.command` | none | Healer command with `{tests}` and `{files}` |
| `snapshotPruning.minChars` | `4000` | Smaller snapshots are left alone |
| `snapshotPruning.keepScore` | `2` | Minimum relevance (0 to 3) to keep a region |
| `stepVerification.enabled` | `true` | Expose `jev_verify_step` |
| `locatorHealing.mode` | `"report"` | `"off"`, `"report"`, or `"enforce"` |
| `locatorHealing.threshold` | `0.55` | Minimum probability to act on a heal |
| `locatorHealing.probeTimeoutMs` | `2000` | How long to wait before trying to heal |
| `locatorHealing.failInCI` | `false` | Fail healed tests when `CI` is set |
| `assertions.threshold` | `0.9` | Minimum probability for `toSatisfy` |
| `assertions.timeoutMs` | `5000` | How long `toSatisfy` retries |
| `impact.base` | `origin/main` | Diff base for `impact` |

### Providers

```ts
// OpenRouter with another model or gateway
provider: { type: "openrouter", model: "typesafe/jev-1.13", baseUrl: "https://gateway.example/openrouter" }

// Any endpoint with the Decisions wire format
provider: { type: "http", url: "https://decisions.internal/api", apiKeyEnv: "DECISIONS_KEY" }

// Another wire format
provider: {
  type: "http",
  url: "https://gateway.example/v1/classify",
  authHeader: "x-api-key",
  authScheme: "",
  apiKeyEnv: "GATEWAY_KEY",
  mapRequest: (request, model) => ({ model, input: request.state, tasks: request.questions }),
  mapResponse: (body) => ({ answers: (body as { results: never }).results }),
}

// Your own code
provider: { type: "module", module: "./decisions.mjs", options: { region: "eu" } }
```

Environment variables override the file, which is useful in CI:

| Variable | Effect |
| --- | --- |
| `PLAYWRIGHT_JEV_URL` | Use the `http` provider at this URL. A literal `apiKey` is never carried over. |
| `PLAYWRIGHT_JEV_MODEL` | Override the model |
| `PLAYWRIGHT_JEV_API_KEY_ENV` | Read the key from another variable |
| `PLAYWRIGHT_JEV_CONFIG` | Config file path |
| `PLAYWRIGHT_JEV_DISABLED=1` | Turn every feature off |

## Writing a custom provider

A provider is an object with a `name` and a `decide` method. Add `cacheScope` for any setting that changes
the answer, so the cache does not mix answers from different models.

```js
// decisions.mjs
export default function createProvider(options) {
  return {
    name: "my-decisions",
    cacheScope: { model: options.model },
    async decide({ state, questions }, { signal } = {}) {
      const response = await fetch("https://decisions.internal/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, state, questions }),
        signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { answers: (await response.json()).answers }
    },
  }
}
```

Each question has a `type`, `instructions`, and `criteria`. Answers must follow the JEV shapes:

| Type | Criteria | Answer |
| --- | --- | --- |
| `noul` | `{ true: "...", false: "..." }` | `{ type: "noul", noul: 0.93 }` |
| `choice` | `{ key: "description", ... }` | `{ type: "choice", choice: "key", probabilities: { key: 0.8, ... } }` |
| `score` | `["level 0", "level 1", ...]` | `{ type: "score", score: 2.4, probabilities?: {...} }` |

If `decide` throws, each feature falls back to the behavior without `playwright-jev`: triage recommends
rerun and heal, healing fails the test normally, `toSatisfy` fails with the error, and impact ranks the
spec first.

## What gets sent to the provider

| Feature | State sent |
| --- | --- |
| Triage | Test title and location, error messages, step titles, failing source lines, page snapshot at failure, retry history, optional changed file names |
| Locator healing | Action, original locator, test step title, URL path (no query or fragment), candidate element roles and names |
| `toSatisfy` | The claim and the accessibility snapshot |
| Pruning | The goal and snapshot regions |
| Step verification | Step, expected outcome, snapshot |
| Impact | Changed file names, commit subjects, a clipped diff, spec titles and `goto` lines |

Accessibility snapshots contain the text visible on the page. Run against test data, not production
accounts, or use a provider you host yourself. API keys are never written to the cache or reports.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `OPENROUTER_API_KEY is not set.` in `triage.json` | Export the key, or set `provider.apiKeyEnv` |
| Every failure says `unknown` and `rerun` | Decision calls are failing; see the `error` field in `triage.json` |
| `retry` reruns nothing | No failure reached `retry.threshold`; check `triage.md` |
| Healing never acts | Mode is `report`, or probabilities are below `locatorHealing.threshold`; read `jevHealEvents` |
| A test is slower when a locator is missing | The probe waits `probeTimeoutMs` before healing; lower it or pass `{ timeout }` |
| The MCP proxy returns full snapshots | No goal is set, or the snapshot is under `snapshotPruning.minChars` |
| Answers do not change after a model switch | Clear `.playwright-jev/cache`, or give custom providers a `cacheScope` |
