// The decision engine for one lane: JEV, or an LLM answering the same typed questions. It reports every
// decision to the dashboard with its latency and cost, and circles the element a heal decision picked in
// the live page, so viewers see what the engine did and how long it took.
import { openRouterProvider, typeSafeProvider } from "../dist/index.js"
import createLlmProvider from "./llm-provider.mjs"

export default function createEngineProvider({ engine = "jev", jevProvider = "openrouter", llmModel } = {}) {
  const inner =
    engine === "llm"
      ? createLlmProvider(llmModel ? { model: llmModel } : {})
      : jevProvider === "typesafe"
        ? typeSafeProvider()
        : openRouterProvider()
  return {
    name: inner.name,
    cacheScope: inner.cacheScope,
    async decide(request, options) {
      const demo = globalThis.__demo
      const feature = request.metadata?.feature ?? "decision"
      const id = `${process.env.DEMO_LANE}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      await report({
        type: "decision-start",
        id,
        feature,
        title: demo?.title,
        worker: demo?.worker,
        question: summary(request),
      })
      const started = performance.now()
      const response = await inner.decide(request, options)
      const latencyMs = Math.round(performance.now() - started)
      const target = response.answers.target
      if (feature === "locator-healing" && target?.type === "choice" && target.choice !== "none" && demo?.page) {
        const probability = target.probabilities?.[target.choice] ?? target.confidence ?? 0
        await circle(demo.page, target.choice, `Found in ${(latencyMs / 1000).toFixed(1)} s`).catch(() => undefined)
        await report({
          type: "decision-end",
          id,
          feature,
          latencyMs,
          choice: target.choice,
          probability,
          ...usage(response),
        })
      } else {
        await report({ type: "decision-end", id, feature, latencyMs, ...usage(response) })
      }
      return response
    },
  }
}

function summary(request) {
  const state = request.state ?? {}
  const feature = request.metadata?.feature
  if (feature === "locator-healing") return { original: state.intended_element ?? {} }
  if (feature === "assertion") return { claim: state.claim }
  if (feature === "triage") return { test: state.test?.title }
  return {}
}

function usage(response) {
  return {
    costUsd: response.usage?.costUsd ?? null,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
  }
}

/** Draw a labelled ring around the chosen element in the live page; the screencast carries it to the dashboard. */
async function circle(page, ref, label) {
  await page
    .locator(`aria-ref=${ref}`)
    .evaluate((element, text) => window.__demoMark?.(element, text, "#3e63dd"), label)
  // Hold the ring on screen for a moment before the action continues. Both lanes wait the same time.
  await page.waitForTimeout(400)
}

async function report(event) {
  const url = process.env.DEMO_EVENTS_URL
  if (!url) return
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: process.env.DEMO_LANE, ...event }),
  }).catch(() => undefined)
}
