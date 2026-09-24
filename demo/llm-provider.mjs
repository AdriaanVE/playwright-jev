// The "before" lane: the same typed questions answered by a general LLM through OpenRouter chat
// completions, the way an LLM-based self-healing or triage step works today. It receives exactly the same
// state and questions as JEV, so any difference in the demo comes from the decision engine alone.
export const defaultLlmModel = "anthropic/claude-sonnet-4.6"

const system = `You are the decision step inside an automated Playwright test pipeline.
Read the application state and answer every question.
For a "choice" question, pick exactly one criteria key and give your confidence from 0 to 1.
For a "noul" question, give the probability from 0 to 1 that the answer is yes.
For a "score" question, pick one level index from the criteria list and give your confidence.
Reply with JSON only, shaped as {"answers": {"<question id>": {"answer": <key, probability, or level>, "confidence": <0 to 1>}}}.`

export default function createLlmProvider({ model = defaultLlmModel, apiKeyEnv = "OPENROUTER_API_KEY" } = {}) {
  return {
    name: `llm:${model}`,
    cacheScope: { model },
    async decide(request, options = {}) {
      const key = process.env[apiKeyEnv]
      if (!key) throw new Error(`${apiKeyEnv} is not set.`)
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-openrouter-title": "playwright-jev demo",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 600,
          response_format: { type: "json_object" },
          usage: { include: true },
          messages: [
            { role: "system", content: system },
            { role: "user", content: JSON.stringify({ state: request.state, questions: request.questions }) },
          ],
        }),
        signal: options.signal,
      })
      const body = await response.json()
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`)
      const text = body.choices?.[0]?.message?.content ?? ""
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1))
      return {
        answers: toJevAnswers(request.questions, parsed.answers ?? {}),
        model: body.model,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          costUsd: body.usage?.cost ?? null,
        },
      }
    },
  }
}

/** Convert the LLM's answers into JEV's answer shapes so the rest of the pipeline is unchanged. */
function toJevAnswers(questions, raw) {
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    const value = raw[id] ?? {}
    const confidence = clamp(Number(value.confidence ?? 0.5))
    if (question.type === "noul") {
      answers[id] = { type: "noul", noul: clamp(Number(value.answer ?? value.confidence ?? 0)) }
    } else if (question.type === "choice") {
      const keys = Object.keys(question.criteria)
      const choice = keys.includes(String(value.answer)) ? String(value.answer) : (keys.at(-1) ?? "")
      const rest = (1 - confidence) / Math.max(1, keys.length - 1)
      answers[id] = {
        type: "choice",
        choice,
        confidence,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? confidence : rest])),
      }
    } else {
      answers[id] = { type: "score", score: Number(value.answer ?? 0), confidence }
    }
  }
  return answers
}

function clamp(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}
