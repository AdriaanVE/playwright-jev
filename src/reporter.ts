import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter"
import { getConfig, isDisabled, type PlaywrightJevConfig, type ResolvedConfig, setConfig } from "./config.js"
import { healAnnotation } from "./features/locator-healing.js"
import { type FailureInput, parseErrorContext, renderMarkdown, summarize, triageFailure } from "./features/triage.js"
import { stripAnsi } from "./snapshot.js"

export type ReporterOptions = PlaywrightJevConfig

/**
 * Reporter for features 1 to 3. Each test's final unexpected failure is triaged once, after retries, and
 * results are written to `<outputDir>/triage.json`, `triage.md`, `retry.json`, and `heal.json`.
 */
export default class JevReporter implements Reporter {
  private config!: ResolvedConfig
  private readonly attempts = new Map<string, string[]>()
  /** Latest unexpected failure per test. Triage runs once per test in onEnd, after all retries. */
  private readonly failures = new Map<string, FailureInput>()
  private changedFiles: string[] | undefined

  constructor(private readonly options: ReporterOptions = {}) {}

  printsToStdio(): boolean {
    return false
  }

  async onBegin(_config: FullConfig): Promise<void> {
    // Playwright adds `configDir`, `_mode`, and similar keys to reporter options; only our keys count.
    const { configDir: _dir, ...rest } = this.options as ReporterOptions & { configDir?: string }
    const own = Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith("_")))
    if (Object.keys(own).length) setConfig(own)
    this.config = await getConfig()
    const base = this.config.triage.diffBase
    if (base) {
      try {
        this.changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
      } catch {
        this.changedFiles = undefined
      }
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const history = this.attempts.get(test.id) ?? []
    history.push(result.status)
    this.attempts.set(test.id, history)
    if (isDisabled() || !this.config.triage.enabled) return
    // Expected outcomes (including `test.fail()`), skips, and interrupted runs are not failures to triage.
    const unexpected =
      result.status !== test.expectedStatus && result.status !== "skipped" && result.status !== "interrupted"
    if (unexpected) this.failures.set(test.id, this.toFailure(test, result, history.slice(0, -1)))
    else this.failures.delete(test.id)
  }

  async onEnd(): Promise<void> {
    if (isDisabled() || !this.config?.triage.enabled) return
    // Always write the handoff files, so a clean run never leaves a previous run's reruns behind.
    const results = await Promise.all([...this.failures.values()].map((failure) => triageFailure(failure, this.config)))
    const summary = summarize(results, this.config)
    const dir = this.config.outputDir
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "triage.json"), JSON.stringify(summary, null, 2))
    writeFileSync(path.join(dir, "triage.md"), renderMarkdown(summary))
    // Handoff for feature 2: failed test ids in Playwright's own `.last-run.json` shape, filtered to reruns.
    const rerun = results.filter((result) => result.retry.recommended)
    writeFileSync(
      path.join(dir, "retry.json"),
      JSON.stringify({ status: "failed", failedTests: rerun.map((result) => result.testId) }, null, 2),
    )
    // Handoff for feature 3: failures the LLM healer should attempt.
    const heal = results.filter((result) => !result.retry.recommended && result.heal.recommended)
    writeFileSync(
      path.join(dir, "heal.json"),
      JSON.stringify(
        heal.map(({ testId, name, title, file, category, confidence }) => ({
          testId,
          name,
          title,
          file,
          category,
          confidence,
        })),
        null,
        2,
      ),
    )
    const { totals } = summary
    if (totals.failures === 0) return
    process.stdout.write(
      `\n[playwright-jev] ${totals.failures} failure(s) triaged: ${totals.retry} rerun, ${totals.heal} heal, ` +
        `${totals.human} review. Details: ${path.relative(process.cwd(), path.join(dir, "triage.md"))}\n`,
    )
  }

  private toFailure(test: TestCase, result: TestResult, previousAttempts: string[]): FailureInput {
    const context = result.attachments.find((attachment) => attachment.name === "error-context")
    let parsed: ReturnType<typeof parseErrorContext> = {}
    try {
      const markdown = context?.path ? readFileSync(context.path, "utf8") : context?.body?.toString()
      if (markdown) parsed = parseErrorContext(markdown)
    } catch {
      parsed = {}
    }
    const healed = result.annotations
      .filter((annotation) => annotation.type === healAnnotation && annotation.description)
      .map((annotation) => annotation.description ?? "")
    return {
      testId: test.id,
      name: test.title,
      title: test.titlePath().filter(Boolean).join(" > "),
      file: path.relative(process.cwd(), test.location.file),
      line: test.location.line,
      project: test.parent.project()?.name || undefined,
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      errors: result.errors.map((error) => stripAnsi(error.message ?? error.value ?? "")),
      steps: result.steps
        .map((step) => step.title)
        .filter((title) => !/^(Before|After) Hooks$|^Worker Cleanup$/.test(title)),
      pageSnapshot: parsed.pageSnapshot,
      source: parsed.source,
      previousAttempts: previousAttempts.length ? previousAttempts : undefined,
      changedFiles: this.changedFiles,
      healedLocators: healed.length ? healed : undefined,
    }
  }
}
