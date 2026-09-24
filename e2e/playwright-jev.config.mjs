export default {
  provider: { type: "module", module: "./stub-provider.mjs" },
  cache: { mode: "off" },
  outputDir: "../test-results/playwright-jev",
  locatorHealing: { mode: process.env.HEAL_MODE ?? "enforce", probeTimeoutMs: 500 },
  assertions: { timeoutMs: 1000, intervalMs: 100 },
}
