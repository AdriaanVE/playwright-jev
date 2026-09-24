// Deterministic stand-in for a decision API, loaded through the `module` provider type.
// Picks the candidate whose description shares the most words with the original locator.
export default function createStubProvider() {
  return {
    name: "stub",
    async decide(request) {
      const answers = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (id === "target") answers[id] = pickTarget(request.state, question.criteria)
        else if (id === "satisfied") answers[id] = { type: "noul", noul: claimHolds(request.state) ? 0.97 : 0.03 }
        else if (id === "root_cause") answers[id] = classify(request.state)
      }
      return { answers, usage: { inputTokens: JSON.stringify(request).length / 4, outputTokens: 0, costUsd: 0 } }
    },
  }
}

const words = (text) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  )

function pickTarget(state, criteria) {
  const wanted = words(state.original_locator.replace(/getBy\w+|name|exact|button|link|textbox/g, " "))
  let best = "none"
  let bestScore = 0
  for (const [key, description] of Object.entries(criteria)) {
    if (key === "none") continue
    const score = [...words(description)].filter((w) => wanted.has(w)).length
    if (score > bestScore) [best, bestScore] = [key, score]
  }
  const probabilities = Object.fromEntries(
    Object.keys(criteria).map((key) => [key, key === best ? 0.95 : 0.05 / (Object.keys(criteria).length - 1)]),
  )
  return { type: "choice", choice: best, probabilities }
}

function claimHolds(state) {
  const quoted = /"([^"]+)"/.exec(state.claim)?.[1]
  return quoted ? state.accessibility_snapshot.includes(quoted) : false
}

function classify(state) {
  const text = state.errors.join("\n")
  const choice = /ECONNREFUSED|net::ERR/.test(text)
    ? "environment"
    : /waiting for/.test(text)
      ? "locator_drift"
      : "app_bug"
  return { type: "choice", choice, probabilities: { [choice]: 0.9 } }
}

// Region relevance and step checks for the MCP proxy test.
export function createProxyStub() {
  return {
    name: "stub-proxy",
    async decide(request) {
      const answers = {}
      for (const id of Object.keys(request.questions)) {
        if (id === "achieved")
          answers[id] = {
            type: "noul",
            noul: [...words(request.state.expected_outcome)].every(
              (w) =>
                request.state.current_snapshot.toLowerCase().includes(w) ||
                ["shop", "page", "with", "button", "the"].includes(w),
            )
              ? 0.95
              : 0.05,
          }
        else {
          const text = request.state.regions[id] ?? ""
          const goal = words(request.state.goal)
          answers[id] = { type: "score", score: [...words(text)].some((w) => goal.has(w)) ? 3 : 0 }
        }
      }
      return { answers }
    },
  }
}
