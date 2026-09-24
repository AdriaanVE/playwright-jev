import type { Locator, Page } from "@playwright/test"
import type { ResolvedConfig } from "../config.js"
import { noul, noulAnswer } from "../questions.js"
import { clip } from "../snapshot.js"

export type SemanticCheck = { pass: boolean; probability: number; snapshot: string; cached: boolean }

/** Ask whether the page or locator's current accessibility tree satisfies a plain-language claim. */
export async function checkClaim(
  target: Page | Locator,
  claim: string,
  config: ResolvedConfig,
  threshold = config.assertions.threshold,
): Promise<SemanticCheck> {
  const locator = "goto" in target ? target.locator("body") : target
  const snapshot = clip(
    await locator.ariaSnapshot({ timeout: config.assertions.timeoutMs }),
    config.assertions.snapshotChars,
  )
  const response = await config.provider.decide({
    state: { claim, accessibility_snapshot: snapshot },
    questions: {
      satisfied: noul(
        "Does the accessibility snapshot show that the claim is true right now?",
        "The snapshot clearly shows the claim holds",
        "The snapshot contradicts the claim or lacks evidence for it",
      ),
    },
    metadata: { feature: "assertion" },
  })
  const probability = noulAnswer(response, "satisfied").noul
  return { pass: probability >= threshold, probability, snapshot, cached: response.cached ?? false }
}
