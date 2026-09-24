---
name: playwright-jev
description: Run, triage, retry, and heal Playwright tests with playwright-jev, and use its MCP tools to keep browser snapshots small. Use when a project has playwright-jev installed and the task involves failing Playwright tests, flaky tests, CI failures, healing locators, or driving a browser through the playwright-jev MCP proxy.
---

# playwright-jev

`playwright-jev` adds typed JEV decisions to Playwright. Use its outputs instead of reading every failure
or full page snapshot yourself.

## Check the setup

1. Confirm `playwright-jev` is in `package.json` devDependencies.
2. Confirm `playwright.config.ts` lists `"playwright-jev/reporter"` in `reporter`. If it does not, add it
   only when the user asked you to set up playwright-jev.
3. Decisions need a provider key: `OPENROUTER_API_KEY` by default, or `TYPESAFE_API_KEY` when the config
   uses `provider: { type: "typesafe" }`. If triage results show
   `error: "... is not set."`, tell the user which variable is missing. Never print or ask for the value.

## Fix failing tests

Follow this order. Each step narrows what needs your attention.

1. Run the suite: `npx playwright test`.
2. Read `.playwright-jev/triage.md`. Each failure has a cause, a confidence, and a next step.
3. Rerun transient failures: `npx playwright-jev retry`. Failures that pass on rerun need no edits.
   Mention them to the user as flaky.
4. Get the healable failures: `npx playwright-jev heal --dry-run`. Only these are test-code problems.
   Fix each one:
   - `locator_drift`: find the element in the failure's page snapshot (the `error-context.md` next to
     the test result) and update the locator. Prefer `getByRole` with a name.
   - `timing`: replace fixed waits with web-first assertions such as `await expect(locator).toBeVisible()`.
   - `assertion_outdated`: update the expected value only when the new value is clearly intended. If
     unsure, ask the user.
5. Do not edit tests for `app_bug`, `test_data`, or `environment` failures. Report them to the user with
   the triage line, because they point at the application or the environment.
6. Rerun the fixed specs to confirm.

If `triage.md` shows `unknown` for everything, decision calls failed. Fall back to reading each failure's
`error-context.md`, and tell the user why.

## Healed locators

When a spec imports from `playwright-jev/test`, missing locators may be healed at runtime. Heal events
appear as `jev-heal` annotations in the report, with `original` and `healedLocator`. Replace each original
locator in the source with the suggested one, and do not leave healing to cover drift.

## Browser work through the MCP proxy

When your MCP server is `playwright-jev mcp`, you have two extra tools, and every tool accepts `jev_goal`
and `jev_full_snapshot`:

- At the start of each task, and when the goal changes, call `jev_set_goal` with a short goal, for
  example "add the first product to the cart". Snapshots then show only the regions relevant to it.
  Collapsed regions keep their refs, and you can click those refs directly.
- If you need a collapsed region, repeat the call with `jev_full_snapshot: true`.
- After an action, call `jev_verify_step` with `step` and an `expected` outcome instead of taking a new
  snapshot. Describe the outcome ("cart page lists one item"), not a label. If `achieved` is false, take a
  snapshot and investigate.

## Impact ordering

For quick feedback on a branch, run the specs related to the change first:

```sh
npx playwright test $(npx playwright-jev impact --base origin/main --dir tests) --max-failures=1
```

Always run the full suite before you report that a change passes.

## Configuration

Settings live in `playwright-jev.config.ts`. Read `node_modules/playwright-jev/docs/guide.md` for every
option, provider setup, and troubleshooting. Do not change thresholds or turn on
`locatorHealing.mode: "enforce"` unless the user asks.
