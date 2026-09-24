import { defineConfig } from "playwright-jev"

export default defineConfig({
  // Default: OpenRouter Decisions API with typesafe/jev-1.13 and OPENROUTER_API_KEY.
  provider: { type: "openrouter", model: "typesafe/jev-1.13" },

  // Any endpoint that accepts { model, state, questions } and returns { answers }:
  // provider: { type: "http", url: "https://decisions.internal.example/api/decide", apiKeyEnv: "DECISIONS_KEY" },

  // A backend with a different wire format:
  // provider: {
  //   type: "http",
  //   url: "https://gateway.example/v1/classify",
  //   authHeader: "x-api-key",
  //   authScheme: "",
  //   apiKeyEnv: "GATEWAY_KEY",
  //   mapRequest: (request, model) => ({ model, input: request.state, tasks: request.questions }),
  //   mapResponse: (body) => ({ answers: (body as { results: never }).results }),
  // },

  // Your own implementation of DecisionProvider:
  // provider: { type: "module", module: "./my-provider.mjs", options: { region: "eu" } },

  // Commit this directory, or use read-only in CI, to pin decisions that affect test results.
  cache: { mode: "read-write", dir: ".playwright-jev/cache" },

  triage: { diffBase: "origin/main" },
  retry: { threshold: 0.8 },
  healerGate: {
    threshold: 0.7,
    command: "claude -p --agent playwright-test-healer 'Fix these failing Playwright tests: {tests} in {files}'",
  },
  locatorHealing: { mode: "report", threshold: 0.55, failInCI: true },
  assertions: { threshold: 0.9 },
  impact: { base: "origin/main" },
})
