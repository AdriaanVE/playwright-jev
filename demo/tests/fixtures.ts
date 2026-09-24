// Both lanes run the same spec file. The standard lane uses Playwright's own `test` and `expect`; the JEV
// lane swaps in playwright-jev's, which only adds locator healing to the `page` fixture.
//
// For the race dashboard, each test's browser is streamed as a screencast, so viewers can watch the
// browsers of both lanes live. The stream is off unless DEMO_EVENTS_URL is set.
import { expect as playwrightExpect, test as playwrightTest } from "@playwright/test"
import { expect as jevExpect, test as jevTest } from "../../dist/test.js"

const jev = process.env.DEMO_LANE === "jev"
const base = (jev ? jevTest : playwrightTest) as typeof playwrightTest
const eventsUrl = process.env.DEMO_EVENTS_URL

export const test = base.extend<{ screencast: undefined }>({
  screencast: [
    async ({ page }, use, testInfo) => {
      if (!eventsUrl) {
        await use(undefined)
        return
      }
      const worker = testInfo.parallelIndex
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
          body: JSON.stringify({ lane: process.env.DEMO_LANE, worker, title: testInfo.title, data }),
        }).catch(() => undefined)
        sending = false
      })
      await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 560, maxHeight: 360 })
      await use(undefined)
      await session.send("Page.stopScreencast").catch(() => undefined)
    },
    { auto: true },
  ],
})
export const expect = jev ? jevExpect : playwrightExpect
