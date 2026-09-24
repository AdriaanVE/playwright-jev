// Each lane runs the same healing and triage; only the engine answering the questions differs.
// No decision cache, so every run pays real latency and cost.
const lane = process.env.DEMO_LANE ?? "jev"

export default {
  provider: {
    type: "module",
    module: "./engine-provider.mjs",
    options: {
      engine: lane === "llm" ? "llm" : "jev",
      jevProvider: process.env.DEMO_JEV_PROVIDER ?? "openrouter",
      llmModel: process.env.DEMO_LLM_MODEL,
    },
  },
  cache: { mode: "off" },
  outputDir: `./output/${lane}/playwright-jev`,
  // Same thresholds and waits in both lanes. The probe wait is shortened so the demo stays brief.
  locatorHealing: { mode: "enforce", probeTimeoutMs: 800 },
  assertions: { threshold: 0.75, timeoutMs: 4_000, intervalMs: 300 },
}
