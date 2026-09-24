// A real JEV provider that also reports each decision's latency and cost to the race dashboard. It is
// loaded through playwright-jev's `module` provider type, the same hook teams use for their own backends.
import { openRouterProvider, typeSafeProvider } from "../dist/index.js"

export default function createMeteredProvider({ provider = "openrouter" } = {}) {
  const inner = provider === "typesafe" ? typeSafeProvider() : openRouterProvider()
  return {
    name: inner.name,
    cacheScope: inner.cacheScope,
    async decide(request, options) {
      const started = performance.now()
      const response = await inner.decide(request, options)
      await report({
        feature: request.metadata?.feature,
        latencyMs: Math.round(performance.now() - started),
        costUsd: response.usage?.costUsd ?? null,
        inputTokens: response.usage?.inputTokens ?? 0,
      })
      return response
    },
  }
}

async function report(decision) {
  const url = process.env.DEMO_EVENTS_URL
  if (!url) return
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "decision", lane: "jev", ...decision }),
  }).catch(() => undefined)
}
