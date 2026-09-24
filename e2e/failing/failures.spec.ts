import { expect, test } from "../../dist/test.js"

// Run with FAILING=1 only. These tests fail on purpose to exercise triage, retry, and heal handoffs.
test.skip(!process.env.FAILING, "Set FAILING=1 to run the intentional failures.")

test("report mode suggests a heal but lets the test fail", async ({ page, jevHealEvents }) => {
  await page.setContent("<main><button>Go to checkout</button></main>")
  try {
    await page.getByRole("button", { name: "Checkout", exact: true }).click()
  } finally {
    expect(jevHealEvents[0]).toMatchObject({ outcome: "suggested" })
  }
})

test("backend unreachable", async ({ page }) => {
  await page.goto("http://127.0.0.1:9/")
})

test("wrong total", async ({ page }) => {
  await page.setContent("<p role=status>Total: 10</p>")
  await expect(page.getByRole("status")).toHaveText("Total: 12", { timeout: 300 })
})
