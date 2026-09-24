import type { ResolvedConfig } from "../config.js"
import { choice, choiceAnswer, choiceProbability, probabilityOf } from "../questions.js"
import { clip, stripAnsi } from "../snapshot.js"
import type { DecisionUsage } from "../types.js"

export type FailureInput = {
  /** Playwright test id, as used in `.last-run.json`. */
  testId: string
  /** The test's own title, as passed to `test()`. */
  name: string
  /** Full title path, for example `chromium > cart.spec.ts > checkout > applies coupon`. */
  title: string
  file: string
  line?: number
  project?: string
  status: string
  retry: number
  durationMs?: number
  errors: string[]
  steps?: string[]
  /** Page snapshot from Playwright's `error-context` attachment. */
  pageSnapshot?: string
  /** Failing lines of test source from the same attachment. */
  source?: string
  /** Outcomes of earlier attempts in this run, oldest first. */
  previousAttempts?: string[]
  /** Files changed relative to the configured diff base. */
  changedFiles?: string[]
  healedLocators?: string[]
}

export type TriageResult = {
  testId: string
  name: string
  title: string
  file: string
  project?: string
  category: string
  confidence: number
  probabilities: Record<string, number>
  /** Feature 2: probability mass on transient categories, and whether a rerun is recommended. */
  retry: { probability: number; recommended: boolean }
  /** Feature 3: probability mass on healable categories, and whether the LLM healer should run. */
  heal: { probability: number; recommended: boolean }
  cached: boolean
  usage?: DecisionUsage
  error?: string
}

export async function triageFailure(failure: FailureInput, config: ResolvedConfig): Promise<TriageResult> {
  const { categories, transient, healable, instructions, snapshotChars } = config.triage
  const base = {
    testId: failure.testId,
    name: failure.name,
    title: failure.title,
    file: failure.file,
    project: failure.project,
  }
  try {
    const response = await config.provider.decide({
      state: buildTriageState(failure, snapshotChars),
      questions: { root_cause: choice(instructions, categories) },
      metadata: { feature: "triage", testId: failure.testId },
    })
    const answer = choiceAnswer(response, "root_cause")
    const retryProbability = probabilityOf(answer, transient)
    const healProbability = probabilityOf(answer, healable)
    return {
      ...base,
      category: answer.choice,
      confidence: choiceProbability(answer),
      probabilities: answer.probabilities,
      retry: { probability: retryProbability, recommended: retryProbability >= config.retry.threshold },
      heal: { probability: healProbability, recommended: healProbability >= config.healerGate.threshold },
      cached: response.cached ?? false,
      usage: response.usage,
    }
  } catch (error) {
    // Fail open to the behavior teams have without JEV: rerun and heal everything.
    return {
      ...base,
      category: "unknown",
      confidence: 0,
      probabilities: {},
      retry: { probability: 0, recommended: true },
      heal: { probability: 0, recommended: true },
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function buildTriageState(failure: FailureInput, snapshotChars: number): Record<string, unknown> {
  return {
    test: { title: failure.title, file: failure.file, line: failure.line, project: failure.project },
    status: failure.status,
    attempt: failure.retry + 1,
    duration_ms: failure.durationMs,
    errors: failure.errors.map((error) => clip(stripAnsi(error), 3_000)),
    steps: failure.steps?.slice(-20),
    test_source: failure.source ? clip(failure.source, 3_000) : undefined,
    page_snapshot_at_failure: failure.pageSnapshot ? clip(failure.pageSnapshot, snapshotChars) : undefined,
    previous_attempts: failure.previousAttempts,
    changed_files: failure.changedFiles?.slice(0, 100),
    healed_locators: failure.healedLocators,
  }
}

/** Split Playwright's `error-context.md` into the page snapshot and the test source excerpt. */
export function parseErrorContext(markdown: string): { pageSnapshot?: string; source?: string } {
  return {
    pageSnapshot: section(markdown, "Page snapshot", "yaml"),
    source: section(markdown, "Test source", "ts") ?? section(markdown, "Test source", "js"),
  }
}

function section(markdown: string, heading: string, language: string): string | undefined {
  const start = markdown.indexOf(`# ${heading}`)
  if (start === -1) return undefined
  const fence = markdown.indexOf(`\`\`\`${language}\n`, start)
  if (fence === -1) return undefined
  const end = markdown.indexOf("\n```", fence + language.length + 4)
  return markdown.slice(fence + language.length + 4, end === -1 ? undefined : end)
}

export type TriageSummary = {
  generatedAt: string
  provider: string
  thresholds: { retry: number; healerGate: number }
  totals: {
    failures: number
    retry: number
    heal: number
    human: number
    errors: number
    /** Sum of reported costs, or null when no call reported one. */
    costUsd: number | null
    /** Calls that were made but did not report a cost, for example on TypeSafe's own API. */
    unpricedCalls: number
    inputTokens: number
  }
  byCategory: Record<string, number>
  results: TriageResult[]
}

export function summarize(results: TriageResult[], config: ResolvedConfig): TriageSummary {
  const byCategory: Record<string, number> = {}
  for (const result of results) byCategory[result.category] = (byCategory[result.category] ?? 0) + 1
  return {
    generatedAt: new Date().toISOString(),
    provider: config.provider.name,
    thresholds: { retry: config.retry.threshold, healerGate: config.healerGate.threshold },
    totals: {
      failures: results.length,
      retry: results.filter((result) => result.retry.recommended).length,
      heal: results.filter((result) => !result.retry.recommended && result.heal.recommended).length,
      human: results.filter((result) => !result.retry.recommended && !result.heal.recommended).length,
      errors: results.filter((result) => result.error).length,
      ...costTotals(results),
    },
    byCategory,
    results,
  }
}

/** Only calls that reached the provider count; cache hits and failed calls cost nothing. */
function costTotals(results: TriageResult[]): { costUsd: number | null; unpricedCalls: number; inputTokens: number } {
  const billed = results.filter((result) => result.usage && !result.cached)
  const priced = billed.filter((result) => typeof result.usage?.costUsd === "number")
  return {
    costUsd: priced.length ? priced.reduce((sum, result) => sum + (result.usage?.costUsd ?? 0), 0) : null,
    unpricedCalls: billed.length - priced.length,
    inputTokens: billed.reduce((sum, result) => sum + (result.usage?.inputTokens ?? 0), 0),
  }
}

export function describeCost(totals: TriageSummary["totals"]): string {
  const tokens = `${totals.inputTokens} input tokens`
  if (totals.costUsd === null) {
    return totals.unpricedCalls ? `Decision cost: not reported by the provider (${tokens}).` : "Decision cost: none."
  }
  const partial = totals.unpricedCalls ? `, plus ${totals.unpricedCalls} call(s) without a reported cost` : ""
  return `Decision cost: $${totals.costUsd.toFixed(6)} (${tokens}${partial}).`
}

export function renderMarkdown(summary: TriageSummary): string {
  const { totals } = summary
  const lines = [
    "## Playwright JEV triage",
    "",
    `${totals.failures} failure(s): ${totals.retry} to rerun, ${totals.heal} to heal, ${totals.human} for review.` +
      (totals.errors ? ` ${totals.errors} triage call(s) failed and default to rerun and heal.` : ""),
    "",
    "| Test | Cause | Confidence | Next step |",
    "| --- | --- | --- | --- |",
  ]
  for (const result of summary.results) {
    const next = result.retry.recommended ? "rerun" : result.heal.recommended ? "healer" : "review"
    const title = result.title.replace(/\|/g, "\\|")
    lines.push(`| ${title} | ${result.category} | ${Math.round(result.confidence * 100)}% | ${next} |`)
  }
  lines.push("", `Provider: ${summary.provider}. ${describeCost(totals)}`)
  return `${lines.join("\n")}\n`
}
