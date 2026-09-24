import { type PlaywrightJevConfig, type ResolvedConfig, resolveConfig } from "../src/config.js"
import type { DecisionProvider, DecisionRequest, DecisionResponse } from "../src/types.js"

/** Provider that records requests and answers with a function. */
export function fakeProvider(answer: (request: DecisionRequest) => DecisionResponse["answers"]) {
  const requests: DecisionRequest[] = []
  const provider: DecisionProvider & { requests: DecisionRequest[] } = {
    name: "fake",
    requests,
    async decide(request) {
      requests.push(request)
      return { answers: answer(request), usage: { inputTokens: 100, outputTokens: 0, costUsd: 0.000001 } }
    },
  }
  return provider
}

export function testConfig(provider: DecisionProvider, config: PlaywrightJevConfig = {}): Promise<ResolvedConfig> {
  return resolveConfig({ cache: { mode: "off" }, ...config, provider })
}

export const cartSnapshot = `- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - navigation "Main" [ref=e3]:
      - link "Home" [ref=e4]
      - link "Help" [ref=e5]
  - main [ref=e6]:
    - heading "Cart" [level=1] [ref=e7]
    - list [ref=e8]:
      - listitem [ref=e9]: Apple
      - listitem [ref=e10]: Pear
    - button "Go to checkout" [ref=e11]
    - textbox "Coupon" [ref=e12]
  - contentinfo [ref=e13]:
    - link "Privacy" [ref=e14]`
