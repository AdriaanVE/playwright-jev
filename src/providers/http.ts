import type { DecisionProvider, DecisionRequest, DecisionResponse, DecisionUsage } from "../types.js"

export type HttpProviderOptions = {
  /** Full endpoint URL that accepts a Decisions-style body. */
  url: string
  name?: string
  model?: string
  /** Literal API key. Prefer `apiKeyEnv` so keys stay out of config files. */
  apiKey?: string
  /** Environment variable holding the API key. */
  apiKeyEnv?: string
  /** Header that carries the key. Defaults to `authorization`. */
  authHeader?: string
  /** Prefix for the key value. Defaults to `Bearer`; use an empty string for raw keys. */
  authScheme?: string
  headers?: Record<string, string>
  /** Extra top-level body fields, for example `session_id` or `trace`. */
  extraBody?: Record<string, unknown>
  timeoutMs?: number
  maxAttempts?: number
  retryStatuses?: number[]
  /** Build a custom body when the backend does not accept the Decisions wire format. */
  mapRequest?: (request: DecisionRequest, model: string | undefined) => unknown
  /** Parse a custom response body into typed answers. */
  mapResponse?: (body: unknown) => DecisionResponse
  fetch?: typeof fetch
}

const defaultRetryStatuses = [429, 500, 502, 503, 504, 529]

export class DecisionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Decision endpoint returned HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = "DecisionHttpError"
  }
}

export function httpProvider(options: HttpProviderOptions): DecisionProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const maxAttempts = options.maxAttempts ?? 4
  const retryStatuses = new Set(options.retryStatuses ?? defaultRetryStatuses)

  function headers(): Record<string, string> {
    const result: Record<string, string> = { "content-type": "application/json" }
    // Normalize case so a user `Authorization` header and the generated one never both get sent.
    for (const [name, value] of Object.entries(options.headers ?? {})) result[name.toLowerCase()] = value
    const key = options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined)
    if (options.apiKeyEnv && !key) throw new Error(`${options.apiKeyEnv} is not set.`)
    if (key) {
      const scheme = options.authScheme ?? "Bearer"
      result[(options.authHeader ?? "authorization").toLowerCase()] = scheme ? `${scheme} ${key}` : key
    }
    return result
  }

  function body(request: DecisionRequest): unknown {
    if (options.mapRequest) return options.mapRequest(request, options.model)
    return {
      ...(options.model ? { model: options.model } : {}),
      state: request.state,
      questions: request.questions,
      ...options.extraBody,
    }
  }

  return {
    name: options.name ?? `http:${new URL(options.url).host}`,
    // Everything that changes the answer for the same request. Keys and headers stay out of the cache.
    cacheScope: { url: options.url, model: options.model, extraBody: options.extraBody, custom: !!options.mapRequest },
    async decide(request, callOptions) {
      const init = { method: "POST", headers: headers(), body: JSON.stringify(body(request)) }
      for (let attempt = 1; ; attempt++) {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
        const signal = callOptions?.signal ? AbortSignal.any([callOptions.signal, timeout]) : timeout
        let response: Response
        try {
          response = await fetchImpl(options.url, { ...init, signal })
        } catch (error) {
          if (attempt >= maxAttempts || callOptions?.signal?.aborted) throw error
          await sleep(backoff(attempt), callOptions?.signal)
          continue
        }
        const text = await response.text()
        if (response.ok) {
          const parsed: unknown = JSON.parse(text)
          return options.mapResponse ? options.mapResponse(parsed) : parseDecisionResponse(parsed)
        }
        if (!retryStatuses.has(response.status) || attempt >= maxAttempts) {
          throw new DecisionHttpError(response.status, text)
        }
        await sleep(retryAfter(response.headers.get("retry-after")) ?? backoff(attempt), callOptions?.signal)
      }
    },
  }
}

/** Parse the Decisions response shape: `{ answers, model?, usage? }`. */
export function parseDecisionResponse(body: unknown): DecisionResponse {
  if (!body || typeof body !== "object") throw new Error("Decision response is not an object.")
  const value = body as {
    answers?: unknown
    model?: string
    usage?: { input_tokens?: number; output_tokens?: number; cost?: number }
  }
  if (!value.answers || typeof value.answers !== "object") throw new Error("Decision response is missing answers.")
  const usage: DecisionUsage | undefined = value.usage
    ? {
        inputTokens: value.usage.input_tokens ?? 0,
        outputTokens: value.usage.output_tokens ?? 0,
        costUsd: value.usage.cost ?? null,
      }
    : undefined
  return { answers: value.answers as DecisionResponse["answers"], model: value.model, usage }
}

function backoff(attempt: number): number {
  return Math.min(2 ** (attempt - 1), 8) * 1000
}

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(seconds, 30) * 1000
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), 30_000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
