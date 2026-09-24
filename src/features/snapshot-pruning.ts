import type { ResolvedConfig } from "../config.js"
import { noul, noulAnswer, score, scoreAnswer } from "../questions.js"
import { clip, type SnapshotRegion, splitRegions, truncate } from "../snapshot.js"
import type { DecisionUsage } from "../types.js"

export type PruneResult = {
  text: string
  pruned: boolean
  originalChars: number
  keptChars: number
  keptRegions: number
  totalRegions: number
  usage?: DecisionUsage
}

const relevanceLegend = [
  "Irrelevant to the current goal",
  "Background context only",
  "Useful context for the goal",
  "Needed to act on the goal",
]

/**
 * Feature 4. Keep the snapshot regions relevant to the agent's goal and collapse the rest to a one-line
 * outline with their element refs, so the agent can still expand a region by snapshotting again.
 */
export async function pruneSnapshot(snapshot: string, goal: string, config: ResolvedConfig): Promise<PruneResult> {
  const settings = config.snapshotPruning
  const unchanged = { text: snapshot, pruned: false, originalChars: snapshot.length, keptChars: snapshot.length }
  if (!settings.enabled || snapshot.length < settings.minChars || !goal.trim()) {
    return { ...unchanged, keptRegions: 0, totalRegions: 0 }
  }
  const regions = splitRegions(snapshot, settings.maxRegionChars)
  const scored = regions.filter((region) => !region.structural)
  if (scored.length < 3) return { ...unchanged, keptRegions: regions.length, totalRegions: regions.length }

  const response = await config.provider.decide({
    state: { goal, regions: Object.fromEntries(scored.map((region) => [region.id, clip(region.text, 1_500)])) },
    questions: Object.fromEntries(
      scored.map((region) => [
        region.id,
        score(`How relevant is region ${region.id} to the agent's current goal?`, relevanceLegend),
      ]),
    ),
    metadata: { feature: "snapshot-pruning" },
  })

  const lines: string[] = []
  let kept = 0
  // Consecutive irrelevant siblings collapse into one outline line.
  let collapsed: SnapshotRegion[] = []
  const flush = () => {
    const first = collapsed[0]
    if (!first) return
    const indent = first.text.length - first.text.trimStart().length
    const refs = collapsed.flatMap((region) => region.refs)
    const refText = refs.length ? ` refs ${refs.slice(0, 6).join(",")}${refs.length > 6 ? ",…" : ""}` : ""
    const more = collapsed.length > 1 ? ` and ${collapsed.length - 1} more` : ""
    lines.push(`${" ".repeat(indent)}- [collapsed: ${truncate(first.header.replace(/^- /, ""), 60)}${more}${refText}]`)
    collapsed = []
  }
  for (const region of regions) {
    // Structural container lines are always kept so the tree keeps its shape.
    if (region.structural || scoreAnswer(response, region.id).score >= settings.keepScore) {
      flush()
      lines.push(region.text)
      if (!region.structural) kept++
    } else {
      collapsed.push(region)
    }
  }
  flush()
  const text = lines.join("\n")
  return {
    text,
    pruned: true,
    originalChars: snapshot.length,
    keptChars: text.length,
    keptRegions: kept,
    totalRegions: scored.length,
    usage: response.usage,
  }
}

export type StepVerification = { achieved: boolean; probability: number; usage?: DecisionUsage }

/** Feature 5. Decide whether the page now shows that a step's expected outcome happened. */
export async function verifyStep(
  input: { step: string; expected: string; snapshot: string; threshold?: number },
  config: ResolvedConfig,
): Promise<StepVerification> {
  const response = await config.provider.decide({
    state: {
      step: input.step,
      expected_outcome: input.expected,
      current_snapshot: clip(input.snapshot, config.stepVerification.snapshotChars),
    },
    questions: {
      achieved: noul(
        "Does the current page show that the step's expected outcome happened?",
        "The snapshot shows the expected outcome",
        "The outcome is missing, contradicted, or the page shows an error",
      ),
    },
    metadata: { feature: "step-verification" },
  })
  const probability = noulAnswer(response, "achieved").noul
  return { achieved: probability >= (input.threshold ?? 0.8), probability, usage: response.usage }
}

/**
 * Find the YAML snapshot block in a tool result from `@playwright/mcp` (`### Snapshot`) or from
 * `playwright run-test-mcp-server`, which Playwright's own agents use (`- Page Snapshot:`).
 */
export function extractSnapshot(text: string): { before: string; snapshot: string; after: string } | undefined {
  const match = /((?:### (?:Page )?[Ss]napshot|- Page Snapshot:)\n```yaml\n)([\s\S]*?)(\n```)/.exec(text)
  if (!match || match.index === undefined) return undefined
  const start = match.index + (match[1]?.length ?? 0)
  const end = start + (match[2]?.length ?? 0)
  return { before: text.slice(0, start), snapshot: match[2] ?? "", after: text.slice(end) }
}

/**
 * Find a snapshot that the upstream server saved to a file and linked instead of inlining, as in
 * `### Snapshot\n- [Snapshot](.playwright-mcp/page-….yml)`. Returns the link line and the file path.
 */
export function extractSnapshotLink(text: string): { line: string; file: string } | undefined {
  const match = /^- \[Snapshot\]\(([^)]+\.ya?ml)\)$/m.exec(text)
  return match?.[1] ? { line: match[0], file: match[1] } : undefined
}
