import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig, resolveConfig } from "../src/config.js"
import { cachedProvider, stableStringify } from "../src/providers/cache.js"
import { DecisionHttpError, httpProvider } from "../src/providers/http.js"
import { openRouterProvider } from "../src/providers/openrouter.js"
import { noul } from "../src/questions.js"
import { fakeProvider } from "./helpers.js"

const request = { state: { a: 1 }, questions: { q: noul("Is it?", "yes", "no") } }
const okBody = { answers: { q: { type: "noul", noul: 0.9 } }, model: "m", usage: { input_tokens: 5, cost: 0.1 } }

function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>()
  for (const response of responses) fn.mockResolvedValueOnce(response)
  return fn
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("openRouterProvider", () => {
  it("posts the Decisions body with the default model and key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test")
    const fetch = mockFetch(Response.json(okBody))
    const response = await openRouterProvider({ fetch }).decide(request)

    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions")
    const headers = init?.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer sk-test")
    expect(JSON.parse(String(init?.body))).toEqual({ model: "typesafe/jev-1.13", ...request })
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 0, costUsd: 0.1 })
  })

  it("accepts a different endpoint, model, key variable, and extra body", async () => {
    vi.stubEnv("MY_KEY", "k")
    const fetch = mockFetch(Response.json(okBody))
    await openRouterProvider({
      fetch,
      baseUrl: "https://gateway.example/openrouter/",
      path: "/v1/systemone",
      model: "typesafe/jev-2",
      apiKeyEnv: "MY_KEY",
      extraBody: { session_id: "s1" },
    }).decide(request)

    const [url, init] = fetch.mock.calls[0] ?? []
    expect(url).toBe("https://gateway.example/openrouter/v1/systemone")
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "typesafe/jev-2", session_id: "s1" })
  })

  it("fails clearly when the key variable is missing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "")
    await expect(openRouterProvider({ fetch: mockFetch() }).decide(request)).rejects.toThrow("OPENROUTER_API_KEY")
  })
})

describe("httpProvider", () => {
  it("retries transient statuses and honors retry-after", async () => {
    const fetch = mockFetch(
      new Response("busy", { status: 529, headers: { "retry-after": "0" } }),
      Response.json(okBody),
    )
    const response = await httpProvider({ url: "https://x.test/d", fetch }).decide(request)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(response.answers.q).toEqual({ type: "noul", noul: 0.9 })
  })

  it("does not retry client errors", async () => {
    const fetch = mockFetch(new Response("bad", { status: 400 }))
    await expect(httpProvider({ url: "https://x.test/d", fetch }).decide(request)).rejects.toBeInstanceOf(
      DecisionHttpError,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("sends one authorization header when the user also sets one", async () => {
    const fetch = mockFetch(Response.json(okBody))
    await httpProvider({
      url: "https://x.test/d",
      apiKey: "k",
      headers: { Authorization: "Bearer other" },
      fetch,
    }).decide(request)
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "authorization")).toEqual(["authorization"])
    expect(headers.authorization).toBe("Bearer k")
  })

  it("stops waiting between retries when aborted", async () => {
    const fetch = mockFetch(new Response("busy", { status: 503, headers: { "retry-after": "30" } }))
    const controller = new AbortController()
    const pending = httpProvider({ url: "https://x.test/d", fetch }).decide(request, { signal: controller.signal })
    setTimeout(() => controller.abort(new Error("stop")), 10)
    await expect(pending).rejects.toThrow("stop")
  })

  it("supports custom headers, raw keys, and request and response mapping", async () => {
    const fetch = mockFetch(Response.json({ result: { q: { type: "noul", noul: 0.2 } } }))
    const response = await httpProvider({
      url: "https://x.test/d",
      apiKey: "raw",
      authHeader: "x-api-key",
      authScheme: "",
      fetch,
      mapRequest: (req) => ({ input: req.state, ask: req.questions }),
      mapResponse: (body) => ({ answers: (body as { result: never }).result }),
    }).decide(request)

    const init = fetch.mock.calls[0]?.[1]
    expect((init?.headers as Record<string, string> | undefined)?.["x-api-key"]).toBe("raw")
    expect(JSON.parse(String(init?.body))).toEqual({ input: request.state, ask: request.questions })
    expect(response.answers.q).toEqual({ type: "noul", noul: 0.2 })
  })
})

describe("cachedProvider", () => {
  it("serves repeated decisions from disk and ignores metadata and key order", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const inner = fakeProvider(() => ({ q: { type: "noul", noul: 0.5 } }))
    const cached = cachedProvider(inner, dir)

    const first = await cached.decide({ ...request, metadata: { feature: "a" } })
    const second = await cached.decide({ questions: request.questions, state: { a: 1 }, metadata: { feature: "b" } })
    expect(inner.requests).toHaveLength(1)
    expect(first.cached).toBeUndefined()
    expect(second.cached).toBe(true)
  })

  it("does not write in read-only mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const inner = fakeProvider(() => ({ q: { type: "noul", noul: 0.5 } }))
    const cached = cachedProvider(inner, dir, "read-only")
    await cached.decide(request)
    await cached.decide(request)
    expect(inner.requests).toHaveLength(2)
  })

  it("keys on the provider's scope, so a model change is a cache miss", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const answer = () => ({ q: { type: "noul" as const, noul: 0.5 } })
    const a = { ...fakeProvider(answer), cacheScope: { model: "a" } }
    const b = { ...fakeProvider(answer), cacheScope: { model: "b" } }
    await cachedProvider(a, dir).decide(request)
    expect((await cachedProvider(b, dir).decide(request)).cached).toBeUndefined()
    expect((await cachedProvider(a, dir).decide(request)).cached).toBe(true)
  })

  it("serializes objects independently of key order", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }))
  })
})

describe("config", () => {
  it("defaults to OpenRouter and lets environment variables point at another endpoint", async () => {
    vi.stubEnv("PLAYWRIGHT_JEV_URL", "https://decisions.internal/api")
    vi.stubEnv("PLAYWRIGHT_JEV_MODEL", "custom-model")
    const config = await resolveConfig({ cache: { mode: "off" } })
    expect(config.provider.name).toBe("http:decisions.internal")
  })

  it("never sends a literal key to an endpoint set by PLAYWRIGHT_JEV_URL", async () => {
    vi.stubEnv("PLAYWRIGHT_JEV_URL", "https://other.example/api")
    vi.stubEnv("OPENROUTER_API_KEY", "")
    const config = await resolveConfig({ cache: { mode: "off" }, provider: { type: "openrouter", apiKey: "secret" } })
    await expect(config.provider.decide(request)).rejects.toThrow("OPENROUTER_API_KEY is not set.")
  })

  it("loads a provider from a module", async () => {
    const config = await resolveConfig(
      {
        cache: { mode: "off" },
        provider: { type: "module", module: "./test/fixtures/provider.mjs", options: { p: 0.7 } },
      },
      path.resolve(import.meta.dirname, ".."),
    )
    const response = await config.provider.decide(request)
    expect(config.provider.name).toBe("fixture")
    expect(response.answers.q).toEqual({ type: "noul", noul: 0.7 })
  })

  it("returns an empty config when no file exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    expect(await loadConfig(dir)).toEqual({ config: {}, dir })
  })
})
