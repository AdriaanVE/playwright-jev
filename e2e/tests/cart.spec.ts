import { expect, test } from "../../dist/test.js"

const cart = `
  <nav><a href="#">Help</a></nav>
  <main>
    <h1>Cart</h1>
    <ul><li>Apple</li><li>Pear</li></ul>
    <p role="status">2 items</p>
    <button onclick="document.querySelector('[role=status]').textContent='Order placed'">Go to checkout</button>
    <input aria-label="Coupon code">
  </main>`

test("heals a renamed button at runtime", async ({ page, jevHealEvents }) => {
  await page.setContent(cart)
  await page.getByRole("button", { name: "Checkout", exact: true }).click()
  await expect(page.getByRole("status")).toHaveText("Order placed")
  expect(jevHealEvents).toHaveLength(1)
  expect(jevHealEvents[0]).toMatchObject({
    outcome: "healed",
    healedLocator: 'getByRole("button", { name: "Go to checkout" })',
  })
})

test("heals through chained locators and only offers fillable fields for fill", async ({ page, jevHealEvents }) => {
  await page.setContent(cart)
  await page.getByRole("main").getByLabel("Coupon", { exact: true }).fill("SAVE10")
  await expect(page.getByRole("textbox", { name: "Coupon code" })).toHaveValue("SAVE10")
  expect(jevHealEvents[0]?.outcome).toBe("healed")
})

test("leaves working locators alone", async ({ page, jevHealEvents }) => {
  await page.setContent(cart)
  await page.getByRole("button", { name: "Go to checkout" }).click()
  expect(jevHealEvents).toEqual([])
})

test("semantic assertions pass and fail on the accessibility tree", async ({ page }) => {
  await page.setContent(cart)
  await expect(page).toSatisfy('The status shows "2 items"')
  await expect(page.getByRole("main")).not.toSatisfy('The cart lists "Banana"')
  await expect(expect(page).toSatisfy('The status shows "Refunded"', { timeout: 300 })).rejects.toThrow(
    /Probability: 0\.0\d\d/,
  )
})

test("records the running test.step and respects an explicit action timeout", async ({ page, jevHealEvents }) => {
  await page.setContent(cart)
  await test.step("apply coupon", async () => {
    await page.getByLabel("Coupon", { exact: true }).fill("SAVE10")
  })
  expect(jevHealEvents[0]?.step).toBe("apply coupon")

  const started = Date.now()
  await expect(page.getByRole("button", { name: "Unsubscribe" }).click({ timeout: 300 })).rejects.toThrow(
    /locator\.click: Timeout 300ms exceeded|Timeout/,
  )
  expect(Date.now() - started).toBeLessThan(1_500)
})
