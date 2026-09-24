import { expect, test } from "./fixtures.js"

test("home shows featured products", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("list", { name: "Featured products" }).getByRole("listitem")).toHaveCount(3)
})

test("header links to the cart", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("link", { name: /Cart/ }).click()
  await expect(page.getByRole("heading", { name: "Your cart" })).toBeVisible()
})

test("product page shows the price", async ({ page }) => {
  await page.goto("/product/apple")
  await expect(page.getByText("Price: €2.50")).toBeVisible()
})

test("add to cart updates the cart badge", async ({ page }) => {
  await page.goto("/product/pear")
  await page.getByRole("button", { name: "Add to cart" }).click()
  await expect(page.getByRole("link", { name: "Cart (1)" })).toBeVisible()
})

test("cart lists every line item", async ({ page }) => {
  await page.goto("/cart?items=apple:2,pear:1")
  await expect(page.getByRole("list", { name: "Line items" }).getByRole("listitem")).toHaveCount(2)
})

test("cart total adds up all line items", async ({ page }) => {
  await page.goto("/cart?items=apple:2,pear:1")
  await expect(page.getByRole("status", { name: "Order total" })).toHaveText("Total: €7.00")
})

test("coupon code can be applied", async ({ page }) => {
  await page.goto("/cart?items=apple:1")
  await page.getByLabel("Coupon code").fill("SAVE10")
  await page.getByRole("button", { name: "Apply" }).click()
  await expect(page.getByRole("alert")).toHaveText("Coupon applied")
})

test("checkout opens the payment page", async ({ page }) => {
  await page.goto("/cart?items=apple:1")
  await page.getByRole("button", { name: "Checkout", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Payment" })).toBeVisible()
})

test("search finds products", async ({ page }) => {
  await page.goto("/search")
  await page.getByRole("searchbox", { name: "Search products" }).fill("pe")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByRole("list", { name: "Results" }).getByRole("listitem")).toHaveText(["Pear"])
})

test("footer links to contact", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("link", { name: "Contact us" }).click()
  await expect(page.getByRole("heading", { name: "Contact us" })).toBeVisible()
})
