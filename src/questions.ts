import type { ChoiceAnswer, DecisionResponse, NoulAnswer, QuestionSpec, ScoreAnswer } from "./types.js"

export function noul(instructions: string, yes: string, no: string): QuestionSpec {
  return { type: "noul", instructions, criteria: { true: yes, false: no } }
}

export function choice(instructions: string, options: Record<string, string>): QuestionSpec {
  return { type: "choice", instructions, criteria: options }
}

export function score(instructions: string, legend: string[]): QuestionSpec {
  return { type: "score", instructions, criteria: legend }
}

export function noulAnswer(response: DecisionResponse, id: string): NoulAnswer {
  const answer = response.answers[id]
  if (answer?.type !== "noul") throw new Error(`Decision response has no noul answer for "${id}".`)
  return answer
}

export function choiceAnswer(response: DecisionResponse, id: string): ChoiceAnswer {
  const answer = response.answers[id]
  if (answer?.type !== "choice") throw new Error(`Decision response has no choice answer for "${id}".`)
  return answer
}

export function scoreAnswer(response: DecisionResponse, id: string): ScoreAnswer {
  const answer = response.answers[id]
  if (answer?.type !== "score") throw new Error(`Decision response has no score answer for "${id}".`)
  return answer
}

/** Probability of the chosen option, falling back to `confidence` when probabilities are absent. */
export function choiceProbability(answer: ChoiceAnswer): number {
  return answer.probabilities[answer.choice] ?? answer.confidence ?? 0
}

/** Total probability across a set of options. */
export function probabilityOf(answer: ChoiceAnswer, keys: readonly string[]): number {
  if (Object.keys(answer.probabilities).length === 0) return keys.includes(answer.choice) ? (answer.confidence ?? 1) : 0
  return keys.reduce((sum, key) => sum + (answer.probabilities[key] ?? 0), 0)
}
