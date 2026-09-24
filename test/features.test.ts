import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { scoreSpecs, summarizeSpec } from "../src/features/impact.js"
import { describeIntent, rankCandidates, suggestLocator } from "../src/features/locator-healing.js"
import { extractSnapshot, extractSnapshotLink, pruneSnapshot, verifyStep } from "../src/features/snapshot-pruning.js"
import { describeCost, parseErrorContext, renderMarkdown, summarize, triageFailure } from "../src/features/triage.js"
import { describeNode, parseSnapshot, splitRegions } from "../src/snapshot.js"
import type { QuestionSpec } from "../src/types.js"
import { cartSnapshot, fakeProvider, testConfig } from "./helpers.js"

const failure = {
  testId: "t1",
  name: "checkout",
  title: "cart > checkout",
  file: "tests/cart.spec.ts",
  status: "failed",
  retry: 0,
  errors: ["\u001b[2mTimeoutError: locator.click: Timeout 1000ms exceeded.\u001b[22m"],
}

describe("snapshot parsing", () => {
  it("reads roles, names, refs, and landmark context", () => {
    const button = parseSnapshot(cartSnapshot).find((node) => node.ref === "e11")
    expect(button).toMatchObject({ role: "button", name: "Go to checkout" })
    expect(describeNode(button ?? never())).toBe('button "Go to checkout" in main')
    expect(parseSnapshot(cartSnapshot).find((node) => node.ref === "e10")?.name).toBe("Pear")
  })

  it("splits large snapshots into regions and keeps every line", () => {
    const regions = splitRegions(cartSnapshot, 120)
    expect(regions.length).toBeGreaterThan(3)
    expect(regions.map((region) => region.text).join("\n")).toBe(cartSnapshot)
    expect(regions.find((region) => region.refs.includes("e11"))).toBeDefined()
  })
})

describe("triage (features 1-3)", () => {
  it("classifies a failure and derives retry and heal decisions from one call", async () => {
    const provider = fakeProvider(() => ({
      root_cause: {
        type: "choice",
        choice: "locator_drift",
        probabilities: { locator_drift: 0.85, timing: 0.1, app_bug: 0.05 },
      },
    }))
    const config = await testConfig(provider)
    const result = await triageFailure(failure, config)

    expect(provider.requests).toHaveLength(1)
    const state = provider.requests[0]?.state as { errors: string[] }
    expect(state.errors[0]).toBe("TimeoutError: locator.click: Timeout 1000ms exceeded.")
    expect(result).toMatchObject({ category: "locator_drift", confidence: 0.85 })
    expect(result.retry).toEqual({ probability: 0.1, recommended: false })
    expect(result.heal).toEqual({ probability: 0.95, recommended: true })
  })

  it("uses configured categories and groupings", async () => {
    const provider = fakeProvider(() => ({
      root_cause: { type: "choice", choice: "flaky_backend", probabilities: { flaky_backend: 0.9, ui: 0.1 } },
    }))
    const config = await testConfig(provider, {
      triage: { categories: { flaky_backend: "Backend flake", ui: "UI change" }, transient: ["flaky_backend"] },
    })
    const result = await triageFailure(failure, config)
    const question = provider.requests[0]?.questions.root_cause as QuestionSpec
    expect(Object.keys(question.criteria)).toEqual(["flaky_backend", "ui"])
    expect(result.retry.recommended).toBe(true)
  })

  it("fails open when the provider errors", async () => {
    const config = await testConfig({
      name: "down",
      decide: () => Promise.reject(new Error("503")),
    })
    const result = await triageFailure(failure, config)
    expect(result).toMatchObject({ category: "unknown", error: "503" })
    expect(result.retry.recommended).toBe(true)
    expect(result.heal.recommended).toBe(true)
  })

  it("summarizes and renders a report", async () => {
    const config = await testConfig(fakeProvider(() => ({})))
    const base = {
      name: "b",
      title: "a | b",
      file: "f",
      category: "app_bug",
      confidence: 0.9,
      probabilities: {},
      cached: false,
    }
    const summary = summarize(
      [
        {
          ...base,
          testId: "1",
          retry: { probability: 0, recommended: false },
          heal: { probability: 0, recommended: false },
        },
        {
          ...base,
          testId: "2",
          retry: { probability: 0.9, recommended: true },
          heal: { probability: 0, recommended: false },
        },
      ],
      config,
    )
    expect(summary.totals).toMatchObject({ failures: 2, retry: 1, heal: 0, human: 1 })
    expect(renderMarkdown(summary)).toContain("| a \\| b | app_bug | 90% | review |")
  })

  it("reports cost only when the provider does", async () => {
    const config = await testConfig(fakeProvider(() => ({})))
    const base = {
      testId: "1",
      name: "b",
      title: "b",
      file: "f",
      category: "timing",
      confidence: 0.9,
      probabilities: {},
      retry: { probability: 0.9, recommended: true },
      heal: { probability: 0, recommended: false },
      cached: false,
    }
    const priced = { ...base, usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.00002 } }
    const unpriced = { ...base, usage: { inputTokens: 80, outputTokens: 0, costUsd: null } }
    const cached = { ...priced, cached: true }

    expect(describeCost(summarize([unpriced], config).totals)).toBe(
      "Decision cost: not reported by the provider (80 input tokens).",
    )
    expect(describeCost(summarize([priced, cached], config).totals)).toBe(
      "Decision cost: $0.000020 (100 input tokens).",
    )
    expect(describeCost(summarize([priced, unpriced], config).totals)).toBe(
      "Decision cost: $0.000020 (180 input tokens, plus 1 call(s) without a reported cost).",
    )
    expect(describeCost(summarize([cached], config).totals)).toBe("Decision cost: none.")
  })

  it("parses Playwright's error-context attachment", () => {
    const markdown = [
      "# Error details",
      "",
      "```",
      "boom",
      "```",
      "",
      "# Page snapshot",
      "",
      "```yaml",
      '- button "Go"',
      "```",
      "",
      "# Test source",
      "",
      "```ts",
      "> 5 |   await click()",
      "```",
    ].join("\n")
    expect(parseErrorContext(markdown)).toEqual({ pageSnapshot: '- button "Go"', source: "> 5 |   await click()" })
  })
})

describe("snapshot pruning and step verification (features 4-5)", () => {
  const big = `${cartSnapshot}\n${Array.from({ length: 80 }, (_, i) => `  - link "Footer link ${i}" [ref=e${100 + i}]`).join("\n")}`

  it("keeps relevant regions and collapses the rest with their refs", async () => {
    const provider = fakeProvider((request) =>
      Object.fromEntries(
        Object.keys(request.questions).map((id) => {
          const regions = (request.state as { regions: Record<string, string> }).regions
          return [id, { type: "score", score: regions[id]?.includes("checkout") ? 3 : 0 }]
        }),
      ),
    )
    const config = await testConfig(provider, { snapshotPruning: { minChars: 100, maxRegionChars: 300 } })
    const result = await pruneSnapshot(big, "go to checkout", config)

    expect(result.pruned).toBe(true)
    expect(result.keptChars).toBeLessThan(result.originalChars)
    expect(result.text).toContain('button "Go to checkout" [ref=e11]')
    expect(result.text).toContain("[collapsed:")
    expect(result.text).not.toContain('link "Footer link 41" [ref=e141]\n')
  })

  it("leaves small snapshots untouched without a call", async () => {
    const provider = fakeProvider(() => ({}))
    const config = await testConfig(provider)
    const result = await pruneSnapshot(cartSnapshot, "checkout", config)
    expect(result.pruned).toBe(false)
    expect(provider.requests).toHaveLength(0)
  })

  it("finds the snapshot in an MCP tool result", () => {
    const text = '### Page\n- Page URL: x\n### Snapshot\n```yaml\n- button "Go" [ref=e3]\n```\n### Events'
    expect(extractSnapshot(text)).toEqual({
      before: "### Page\n- Page URL: x\n### Snapshot\n```yaml\n",
      snapshot: '- button "Go" [ref=e3]',
      after: "\n```\n### Events",
    })
  })

  it("finds the snapshot in a Playwright test MCP server result", () => {
    const text = '### Page state\n- Page URL: x\n- Page Snapshot:\n```yaml\n- button "Go" [ref=e3]\n```\n'
    expect(extractSnapshot(text)?.snapshot).toBe('- button "Go" [ref=e3]')
  })

  it("finds a snapshot that the upstream saved to a file", () => {
    const text = "### Page\n- Page URL: x\n### Snapshot\n- [Snapshot](.playwright-mcp/page-1.yml)\n"
    expect(extractSnapshotLink(text)).toEqual({
      line: "- [Snapshot](.playwright-mcp/page-1.yml)",
      file: ".playwright-mcp/page-1.yml",
    })
  })

  it("verifies a step against a threshold", async () => {
    const config = await testConfig(fakeProvider(() => ({ achieved: { type: "noul", noul: 0.75 } })))
    const input = { step: "click checkout", expected: "payment form", snapshot: cartSnapshot }
    expect((await verifyStep(input, config)).achieved).toBe(false)
    expect((await verifyStep({ ...input, threshold: 0.7 }, config)).achieved).toBe(true)
  })
})

describe("locator healing helpers (feature 6)", () => {
  it("offers only interactive elements, and only fillable ones for fill", () => {
    const click = rankCandidates(cartSnapshot, "getByRole('button', { name: 'Checkout' })", "click", 40)
    expect(click.map((node) => node.ref)).toEqual(["e4", "e5", "e11", "e12", "e14"])
    const fill = rankCandidates(cartSnapshot, "getByLabel('Coupon code')", "fill", 40)
    expect(fill.map((node) => node.ref)).toEqual(["e12"])
  })

  it("keeps the best lexical matches when there are too many candidates", () => {
    const ranked = rankCandidates(cartSnapshot, "getByRole('button', { name: 'Checkout' })", "click", 1)
    expect(ranked.map((node) => node.ref)).toEqual(["e11"])
  })

  it("reads the target of a chained locator, not its container", () => {
    expect(describeIntent("getByRole('main').getByLabel('Coupon', { exact: true })")).toEqual({
      inside: "getByRole('main')",
      label: "Coupon",
    })
    expect(describeIntent("getByRole('button', { name: 'Check \\'out', exact: true })")).toEqual({
      role: "button",
      name: "Check \\'out",
    })
  })

  it("suggests a role locator", () => {
    expect(suggestLocator("button", 'Go "now"')).toBe('getByRole("button", { name: "Go \\"now\\"" })')
  })
})

describe("impact ordering (feature 8)", () => {
  it("orders specs by score and ranks failures first", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    for (const name of ["a.spec.ts", "b.spec.ts", "c.spec.ts"]) {
      writeFileSync(path.join(dir, name), `import { test } from "x"\ntest("${name}", async () => {})\nconst x = 1\n`)
    }
    const provider = fakeProvider((request) => {
      const specs = Object.keys((request.state as { specs: Record<string, string> }).specs)
      return Object.fromEntries(
        specs.map((file, index) => [`spec_${index}`, { type: "score", score: file === "b.spec.ts" ? 3 : 0 }]),
      )
    })
    const config = await testConfig(provider)
    const diff = { files: ["src/b.ts"], patch: "+b", commits: "change b" }
    const result = await scoreSpecs({ config, specs: ["a.spec.ts", "b.spec.ts", "c.spec.ts"], diff, cwd: dir })
    expect(result.map((item) => item.file)).toEqual(["b.spec.ts", "a.spec.ts", "c.spec.ts"])

    const failing = await testConfig({ name: "down", decide: () => Promise.reject(new Error("x")) })
    const fallback = await scoreSpecs({ config: failing, specs: ["a.spec.ts"], diff, cwd: dir })
    expect(fallback[0]).toMatchObject({ score: 3, error: "x" })
  })

  it("summarizes a spec to titles and imports", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const file = path.join(dir, "s.spec.ts")
    writeFileSync(
      file,
      'import { test } from "x"\nconst noise = 1\ntest("buys", async ({ page }) => {\n  await page.goto("/cart")\n})\n',
    )
    expect(summarizeSpec(file)).toBe(
      'import { test } from "x"\ntest("buys", async ({ page }) => {\nawait page.goto("/cart")',
    )
  })
})

function never(): never {
  throw new Error("unreachable")
}
