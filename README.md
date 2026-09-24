# playwright-jev

Structured decisions for Playwright. `playwright-jev` sends small typed questions to a decision model,
by default [JEV on OpenRouter](https://openrouter.ai/docs/guides/community/jev) or
[TypeSafe's own JEV API](https://docs.typesafe.ai/api), at points where a test
suite or a Playwright agent would otherwise rerun everything, wait on a human, or spend a full LLM turn.

It is an add-on to `@playwright/test`, not a fork. You keep running `npx playwright test`. Each feature
plugs into an extension point Playwright already has, and you can adopt them one at a time:

| You change | You get |
| --- | --- |
| Add `"playwright-jev/reporter"` to `reporter` in `playwright.config.ts` | Triage, then `retry` and `heal` commands |
| Import `test` and `expect` from `"playwright-jev/test"` in a spec | Locator healing and `toSatisfy` in that spec |
| Start `playwright-jev mcp` as your agent's MCP server | Smaller snapshots and `jev_verify_step` |
| Pass `$(playwright-jev impact)` to `playwright test` | Specs related to the diff run first |

Specs that still import from `@playwright/test` are unaffected, and `PLAYWRIGHT_JEV_DISABLED=1` turns
everything off.

**Documentation**

- [Guide](docs/guide.md): how it combines with Playwright, step-by-step adoption, CI, agents, full config
  reference, custom providers, data sent, troubleshooting
- [Agent skill](skills/playwright-jev/SKILL.md): instructions for coding agents (Claude Code and others)
  that fix tests or drive the browser in a project using playwright-jev
- [Example config](examples/playwright-jev.config.ts)
- [Demo](demo/README.md): a recordable side-by-side race of the same suite with an LLM and with JEV

| # | Feature | Where | Decision |
| --- | --- | --- | --- |
| 1 | Failure triage | Reporter | `choice`: root cause |
| 2 | Smart retries | `playwright-jev retry` | Transient probability from triage |
| 3 | Healer gate | `playwright-jev heal` | Healable probability from triage |
| 4 | Snapshot pruning | `playwright-jev mcp` | `score` per snapshot region |
| 5 | Step verification | `jev_verify_step` MCP tool | `noul` |
| 6 | Runtime locator healing | `playwright-jev/test` fixture | `choice` over live elements |
| 7 | Semantic assertions | `expect(page).toSatisfy()` | `noul` |
| 8 | Test impact ordering | `playwright-jev impact` | `score` per spec |

Features 1 to 3 share one decision per failure.

## Install

```sh
npm install -D playwright-jev
export OPENROUTER_API_KEY=...   # or TYPESAFE_API_KEY with provider type "typesafe"
```

Requires Node 22 and `@playwright/test` 1.63 or newer (the version this package is tested with).

## Configure the provider

Put `playwright-jev.config.ts` (or `.mjs`, `.js`, `.json`) in the directory you run Playwright from, or
point `PLAYWRIGHT_JEV_CONFIG` at it. Relative paths in the file resolve against its directory. See
[`examples/playwright-jev.config.ts`](examples/playwright-jev.config.ts) for every option.

The provider is open-ended:

| `provider.type` | Use |
| --- | --- |
| `openrouter` (default) | OpenRouter Decisions API, `typesafe/jev-1.13`, `OPENROUTER_API_KEY`. Override `model`, `baseUrl`, `path`, `apiKeyEnv`, `headers`, or `extraBody`. |
| `typesafe` | TypeSafe's JEV API at `api.typesafe.ai/v1/systemone`, `jev-latest`, `TYPESAFE_API_KEY`. Honors the TypeSafe SDK variables `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`. Same overrides as `openrouter`. |
| `http` | Any endpoint. Set `url` and auth, and add `mapRequest` and `mapResponse` when the wire format differs. |
| `module` | Your own module that exports a `DecisionProvider`, or a factory that returns one. |
| instance | Pass an object with `name` and `decide(request)` directly. |

A `DecisionProvider` receives `{ state, questions }`, where each question is `noul`, `choice`, or `score`,
and returns `{ answers }` in the JEV answer shape. CI can switch backends without editing the config file:

```sh
PLAYWRIGHT_JEV_URL=https://decisions.internal/api  # switch to the http provider at this URL
PLAYWRIGHT_JEV_MODEL=typesafe/jev-1.13
PLAYWRIGHT_JEV_API_KEY_ENV=MY_KEY                  # read the key from another variable
PLAYWRIGHT_JEV_DISABLED=1                          # turn off every feature
```

Decisions are cached on disk by a hash of the provider name, endpoint, model, state, and questions. Reruns are
deterministic and free. Use `cache.mode: "read-only"` in CI to replay committed decisions without
writing new ones.

## Failure triage, smart retries, and healer gate (1 to 3)

```ts
// playwright.config.ts
export default defineConfig({
  retries: 0, // playwright-jev decides what to rerun
  reporter: [["list"], ["playwright-jev/reporter"]],
})
```

After a run, `.playwright-jev/` contains:

- `triage.json` and `triage.md`: cause, confidence, and next step per failure, plus decision cost (ready for a PR
  comment). OpenRouter reports cost per call. TypeSafe's API reports tokens only, so the cost line then
  shows input tokens and says the provider did not report a cost.
- `retry.json`: failures triaged as transient, in Playwright's `.last-run.json` format
- `heal.json`: failures the LLM healer should attempt

```sh
npx playwright test || true
npx playwright-jev retry            # reruns only transient failures with --last-failed
npx playwright-jev heal             # runs healerGate.command for healable failures
```

Triage runs once per test, after retries, and only for unexpected results. Tests marked `test.fail()`,
skipped tests, and interrupted runs are left out. The handoff files are rewritten on every run, so a clean
run clears the previous list.

Categories, the transient and healable groupings, and both thresholds are configurable. If a decision
call fails, that failure falls back to rerun and heal, which matches the behavior without JEV.

## Runtime locator healing and semantic assertions (6, 7)

```ts
import { expect, test } from "playwright-jev/test"

test("checkout", async ({ page }) => {
  await page.getByRole("button", { name: "Checkout" }).click() // heals if the button was renamed
  await expect(page).toSatisfy('The order summary shows "3 items"')
})
```

When a locator matches nothing within `probeTimeoutMs`, the fixture offers the interactive elements from
the live accessibility tree, plus `none`, as a `choice`. For chained locators, only elements inside the
parent are offered. Strict-mode violations and actionability failures keep Playwright's normal behavior,
and an explicit `{ timeout }` on the action bounds the whole attempt. Web-first assertions, `frameLocator`,
and `locator.all()` are not healed.

- `mode: "report"` (default) records the suggested locator and lets the test fail.
- `mode: "enforce"` acts on the chosen element when its probability reaches `threshold`.
- `failInCI: true` fails healed tests when `CI` is set, so drift is fixed in source.

Each event is attached to the test as a `jev-heal` annotation and is available as the `jevHealEvents`
fixture.

`toSatisfy` retries until `assertions.timeoutMs` and supports `.not`. It reads the accessibility tree, not
pixels, because JEV accepts text only.

## MCP proxy for Playwright agents (4, 5)

Point your agent at the proxy instead of `@playwright/mcp`:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["playwright-jev", "mcp"] }
  }
}
```

By default the proxy starts `npx @playwright/mcp@latest --snapshot-mode full`. To use another upstream,
add `--` followed by its command. For Playwright's own agents from `npx playwright init-agents`, keep the
`playwright-test` server name and use
`["playwright-jev", "mcp", "--", "npx", "playwright", "run-test-mcp-server"]`. Snapshots that the upstream
saves to files are read, pruned, and returned inline. Every upstream tool gains optional `jev_goal` and `jev_full_snapshot`
arguments. The proxy adds two tools:

- `jev_set_goal`: sets the goal that snapshots are pruned against. Irrelevant regions collapse to a single
  line that keeps their element refs.
- `jev_verify_step`: checks whether an action achieved its expected outcome without returning the snapshot
  to the agent. Describe the outcome ("checkout page with a payment form"), not a label ("Checkout now");
  bare labels drop confidence to about 0.65.

## Test impact ordering (8)

```sh
npx playwright test $(npx playwright-jev impact --base origin/main --dir tests)
```

Every spec is still listed. Specs relevant to the diff come first, so failures surface sooner. Use it for
ordering, not for skipping tests on main.

## Calibration

Thresholds depend on the model and your suite. Live JEV 1.13 probabilities from the e2e fixtures and a
small probe set:

| Case | Probability |
| --- | --- |
| Renamed or restructured control (4 cases), correct element | 0.59 to 0.75 |
| Removed control with similar neighbors (4 cases), `none` | 0.88 to 0.98 |
| True `toSatisfy` claim | 0.98 |
| False `toSatisfy` claim | 0.01 to 0.03 |
| `jev_verify_step`, outcome achieved | 0.88 to 0.93 |
| `jev_verify_step`, outcome not achieved | 0.02 to 0.03 |
| Impact score, spec covering the changed flow versus unrelated specs | 2.7 versus 0.2 to 0.3 (scale 0 to 3) |

JEV reliably rejects wrong targets but is cautious about correct renames, so the default heal threshold is
0.55. Before you enable `enforce`, run `report` mode on your own suite and adjust the threshold.

## Development

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:e2e   # uses a stub provider; no API key needed
```

Set `PLAYWRIGHT_JEV_CONFIG` to a config file without the stub provider to run the e2e suite against live
JEV. `FAILING=1 npx playwright test -c e2e/playwright.failing.config.ts` runs intentional failures to
exercise triage, `retry`, and `heal`.
