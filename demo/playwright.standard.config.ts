import { defineConfig } from "@playwright/test"

// Standard lane: Playwright's defaults, with the retries `npm init playwright` generates for CI.
export default defineConfig({
  testDir: "./tests",
  outputDir: "./output/standard/test-results",
  fullyParallel: true,
  workers: 4,
  retries: 2,
  reporter: [["./race-reporter.mjs"]],
  // A small viewport keeps the live browser tiles legible in the dashboard. Both lanes use the same one.
  use: { baseURL: process.env.DEMO_BASE_URL, viewport: { width: 560, height: 360 } },
})
