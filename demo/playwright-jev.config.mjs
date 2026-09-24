// Live JEV with no decision cache, so every run pays real latency and cost.
export default {
  provider: {
    type: "module",
    module: "./metered-provider.mjs",
    options: { provider: process.env.DEMO_PROVIDER ?? "openrouter" },
  },
  cache: { mode: "off" },
  outputDir: "./output/jev/playwright-jev",
  locatorHealing: { mode: "enforce" },
}
