import type { DecisionProvider } from "../types.js"
import { type HttpProviderOptions, httpProvider } from "./http.js"

export const defaultTypeSafeModel = "jev-latest"

export type TypeSafeOptions = Partial<Omit<HttpProviderOptions, "url">> & {
  /** API base. Defaults to `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`. */
  baseUrl?: string
  /** Endpoint path under the base. Defaults to the System One API, `/v1/systemone`. */
  path?: string
}

/**
 * TypeSafe's own JEV API. Uses the same environment variables as the TypeSafe SDKs: `TYPESAFE_API_KEY`,
 * `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL`. Explicit options win over the environment.
 */
export function typeSafeProvider(options: TypeSafeOptions = {}): DecisionProvider {
  const {
    baseUrl = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
    path = "/v1/systemone",
    ...rest
  } = options
  return httpProvider({
    name: "typesafe",
    model: process.env.TYPESAFE_DEFAULT_MODEL || defaultTypeSafeModel,
    apiKeyEnv: "TYPESAFE_API_KEY",
    // TypeSafe asks clients to back off on 429 and 529.
    retryStatuses: [429, 500, 502, 503, 504, 529],
    ...rest,
    url: `${baseUrl.replace(/\/$/, "")}${path}`,
  })
}
