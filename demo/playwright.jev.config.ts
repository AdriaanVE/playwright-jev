import { defineConfig } from "@playwright/test"

// JEV lane: the same suite and workers, with blanket retries replaced by playwright-jev's triage.
export default defineConfig({
  testDir: "./tests",
  outputDir: "./output/jev/test-results",
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [["./race-reporter.mjs"], ["../dist/reporter.js"]],
  // A small viewport keeps the live browser tiles legible in the dashboard. Both lanes use the same one.
  use: { baseURL: process.env.DEMO_BASE_URL, viewport: { width: 560, height: 360 } },
})
