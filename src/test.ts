import { test as base, expect as baseExpect, type Locator, type Page } from "@playwright/test"
import { getConfig, isDisabled } from "./config.js"
import { checkClaim } from "./features/assertions.js"
import { type HealEvent, healAnnotation, healingPage } from "./features/locator-healing.js"

/**
 * Drop-in replacement for `@playwright/test`'s `test`. The `page` fixture heals missing locators
 * (feature 6) according to `locatorHealing.mode`, and heal events are attached as annotations.
 */
export const test = base.extend<{ jevHealEvents: HealEvent[] }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures require an object pattern.
  jevHealEvents: async ({}, use) => {
    await use([])
  },
  page: async ({ page, jevHealEvents }, use, testInfo) => {
    const config = await getConfig()
    if (isDisabled() || config.locatorHealing.mode === "off") {
      await use(page)
      return
    }
    await use(
      healingPage(page, {
        config,
        // Innermost running `test.step` title when available, otherwise the test title.
        step: () => currentStep(testInfo) ?? testInfo.title,
        record: (event) => {
          jevHealEvents.push(event)
          testInfo.annotations.push({ type: healAnnotation, description: JSON.stringify(event) })
        },
      }),
    )
    const healed = jevHealEvents.filter((event) => event.outcome === "healed")
    if (healed.length && config.locatorHealing.failInCI && process.env.CI) {
      throw new Error(
        `JEV healed ${healed.length} locator(s); update the test:\n` +
          healed.map((event) => `  ${event.original} -> ${event.healedLocator}`).join("\n"),
      )
    }
  },
})

type StepNode = { title: string; category?: string; steps?: StepNode[]; endWallTime?: number }

/** Best-effort read of the innermost open `test.step` from Playwright internals; undefined if unavailable. */
function currentStep(testInfo: unknown): string | undefined {
  const find = (steps: StepNode[] | undefined): string | undefined => {
    if (!Array.isArray(steps)) return undefined
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      if (!step || step.endWallTime !== undefined) continue
      const inner = find(step.steps)
      if (inner) return inner
      if (step.category === "test.step") return step.title
    }
    return undefined
  }
  return find((testInfo as { _steps?: StepNode[] })._steps)
}

/** `expect` with `toSatisfy(claim)`, a probabilistic assertion over the accessibility tree (feature 7). */
export const expect = baseExpect.extend({
  async toSatisfy(target: Page | Locator, claim: string, options: { threshold?: number; timeout?: number } = {}) {
    const config = await getConfig()
    const name = "toSatisfy"
    const deadline = Date.now() + (options.timeout ?? config.assertions.timeoutMs)
    let last: Awaited<ReturnType<typeof checkClaim>> | undefined
    let error: unknown
    do {
      try {
        last = await checkClaim(target, claim, config, options.threshold)
        error = undefined
        if (last.pass !== this.isNot) break
      } catch (caught) {
        error = caught
      }
      await new Promise((resolve) => setTimeout(resolve, config.assertions.intervalMs))
    } while (Date.now() < deadline)
    if (!last) throw error instanceof Error ? error : new Error(String(error))
    const lastError = error ? `\nLast check failed: ${error instanceof Error ? error.message : String(error)}` : ""

    const threshold = options.threshold ?? config.assertions.threshold
    return {
      name,
      pass: last.pass,
      expected: claim,
      actual: last.snapshot,
      message: () =>
        `${this.utils.matcherHint(name, undefined, undefined, { isNot: this.isNot })}\n\n` +
        `Claim: ${claim}\nProbability: ${last.probability.toFixed(3)} (threshold ${threshold})\n\n` +
        `Accessibility snapshot:\n${last.snapshot}${lastError}`,
    }
  },
})

export type { HealEvent } from "./features/locator-healing.js"
