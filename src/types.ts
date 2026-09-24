export type QuestionType = "noul" | "choice" | "score"

/** One typed question. `criteria` is a key-to-description map for noul and choice, and an ordered legend for score. */
export type QuestionSpec = {
  type: QuestionType
  instructions: string | Record<string, unknown>
  criteria: Record<string, unknown> | unknown[]
}

export type DecisionRequest = {
  state: unknown
  questions: Record<string, QuestionSpec>
  /** Feature name and other context. Used for logging and tracing; excluded from the cache key. */
  metadata?: { feature: string; [key: string]: unknown }
}

export type NoulAnswer = { type: "noul"; noul: number }

export type ChoiceAnswer = {
  type: "choice"
  choice: string
  probabilities: Record<string, number>
  confidence?: number
}

export type ScoreAnswer = {
  type: "score"
  score: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
  confidence?: number
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type DecisionUsage = {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export type DecisionResponse = {
  answers: Record<string, DecisionAnswer>
  model?: string
  usage?: DecisionUsage
  cached?: boolean
}

/** Anything that turns a typed decision request into typed answers. Implement this to plug in another backend. */
export interface DecisionProvider {
  readonly name: string
  /** Settings that change answers for the same request, such as the endpoint and model. Part of the cache key. */
  readonly cacheScope?: unknown
  decide(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionResponse>
}
