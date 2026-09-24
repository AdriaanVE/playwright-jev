import type { DecisionProvider } from "../types.js"
import { type HttpProviderOptions, httpProvider } from "./http.js"

export const defaultOpenRouterModel = "typesafe/jev-1.13"

export type OpenRouterOptions = Partial<Omit<HttpProviderOptions, "url">> & {
  /** API base. Defaults to `https://openrouter.ai/api`. */
  baseUrl?: string
  /** Endpoint path under the base. Defaults to the Decisions API, `/alpha/decisions`. */
  path?: string
}

/** OpenRouter Decisions API. Every field can be overridden, including the endpoint and the key variable. */
export function openRouterProvider(options: OpenRouterOptions = {}): DecisionProvider {
  const { baseUrl = "https://openrouter.ai/api", path = "/alpha/decisions", ...rest } = options
  return httpProvider({
    name: "openrouter",
    model: defaultOpenRouterModel,
    apiKeyEnv: "OPENROUTER_API_KEY",
    ...rest,
    url: `${baseUrl.replace(/\/$/, "")}${path}`,
    headers: { "x-openrouter-title": "playwright-jev", ...rest.headers },
  })
}
