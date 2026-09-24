// Both lanes run this suite with playwright-jev's healing `page` and `toSatisfy`. Only the decision engine
// behind them differs: an LLM in one lane, JEV in the other (see ../engine-provider.mjs).
//
// For the dashboard, each test's browser is streamed as a screencast, and the current page is shared with
// the engine provider so it can circle the element a decision picked. Both are off without DEMO_EVENTS_URL.

import { readFileSync } from "node:fs"
import path from "node:path"
import { expect as jevExpect, test as jevTest } from "../../dist/test.js"

const highlightScript = path.join(import.meta.dirname, "..", "app", "highlight.js")

const eventsUrl = process.env.DEMO_EVENTS_URL
const lane = process.env.DEMO_LANE

export type DemoContext = { page: unknown; title: string; worker: number }
const shared = globalThis as { __demo?: DemoContext }

type Change = { test: string; kind: string; highlight?: string; what: string }
const scenario = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "app", "scenario.json"), "utf8")) as {
  releases: Record<string, { changes: Change[] }>
}
const bugs = scenario.releases[process.env.DEMO_RELEASE ?? "v2"]?.changes.filter((change) => change.kind === "bug")

export const test = jevTest.extend<{ screencast: undefined }>({
  screencast: [
    async ({ page }, use, testInfo) => {
      shared.__demo = { page, title: testInfo.title, worker: testInfo.parallelIndex }
      await page.addInitScript({ path: highlightScript })
      if (!eventsUrl) {
        await use(undefined)
        return
      }
      const session = await page.context().newCDPSession(page)
      let sending = false
      session.on("Page.screencastFrame", async ({ data, sessionId }) => {
        session.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
        // Drop frames while one is in flight, so a slow dashboard never backs up the test.
        if (sending) return
        sending = true
        await fetch(`${eventsUrl}/frame`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lane, worker: testInfo.parallelIndex, title: testInfo.title, data }),
        }).catch(() => undefined)
        sending = false
      })
      await session.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 560, maxHeight: 300 })
      await use(undefined)
      // Circle the wrong value when a test fails on a real bug, so the frame shows what broke.
      const bug = bugs?.find((item) => item.test === testInfo.title)
      if (bug?.highlight && testInfo.status !== testInfo.expectedStatus) {
        // Runs in the page, where app/highlight.js defines __demoMark.
        await page
          .getByText(bug.highlight)
          .first()
          .evaluate((element, label) => {
            const scope = globalThis as unknown as { __demoMark?: (el: unknown, text: string, color: string) => void }
            scope.__demoMark?.(element, label, "#e5484d")
          }, bug.what)
          .catch(() => undefined)
        await page.waitForTimeout(400)
      }
      await session.send("Page.stopScreencast").catch(() => undefined)
    },
    { auto: true },
  ],
})
export const expect = jevExpect
