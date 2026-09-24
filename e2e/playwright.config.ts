import path from "node:path"
import { defineConfig } from "@playwright/test"

process.env.PLAYWRIGHT_JEV_CONFIG ??= path.join(import.meta.dirname, "playwright-jev.config.mjs")

export default defineConfig({
  testDir: "./tests",
  outputDir: "../test-results/e2e",
  timeout: 15_000,
  use: { actionTimeout: 2_000 },
  reporter: [["list"], [path.join(import.meta.dirname, "../dist/reporter.js")]],
})
