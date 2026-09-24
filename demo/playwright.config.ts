import { defineConfig } from "@playwright/test"

// One config for both lanes. They differ only in the decision engine, set in playwright-jev.config.mjs.
const lane = process.env.DEMO_LANE ?? "jev"

export default defineConfig({
  testDir: "./tests",
  outputDir: `./output/${lane}/test-results`,
  // One test at a time, so each lane is one browser viewers can follow step by step.
  workers: 1,
  retries: 0,
  expect: { timeout: 2_000 },
  reporter: [["./race-reporter.mjs"], ["../dist/reporter.js"]],
  use: {
    baseURL: process.env.DEMO_BASE_URL,
    viewport: { width: 560, height: 300 },
  },
})
