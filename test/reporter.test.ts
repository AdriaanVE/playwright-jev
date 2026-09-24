import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { FullConfig, TestCase, TestResult } from "@playwright/test/reporter"
import { describe, expect, it } from "vitest"
import JevReporter from "../src/reporter.js"
import { fakeProvider } from "./helpers.js"

function testCase(id: string, expectedStatus: TestCase["expectedStatus"] = "passed"): TestCase {
  return {
    id,
    title: id,
    expectedStatus,
    titlePath: () => ["", "chromium", "a.spec.ts", id],
    location: { file: path.join(process.cwd(), "a.spec.ts"), line: 1, column: 1 },
    parent: { project: () => ({ name: "chromium" }) },
  } as unknown as TestCase
}

function result(status: TestResult["status"], retry = 0): TestResult {
  return {
    status,
    retry,
    duration: 1,
    errors: [{ message: "boom" }],
    steps: [],
    attachments: [],
    annotations: [],
  } as unknown as TestResult
}

async function run(outputDir: string, events: [TestCase, TestResult][]) {
  const provider = fakeProvider(() => ({
    root_cause: { type: "choice", choice: "timing", probabilities: { timing: 0.9, app_bug: 0.1 } },
  }))
  const reporter = new JevReporter({ provider, cache: { mode: "off" }, outputDir })
  await reporter.onBegin({} as FullConfig)
  for (const [test, res] of events) reporter.onTestEnd(test, res)
  await reporter.onEnd()
  return provider
}

describe("JevReporter", () => {
  it("triages only the final unexpected failure of each test, once", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const flaky = testCase("flaky")
    const broken = testCase("broken")
    const expectedFail = testCase("known", "failed")
    const provider = await run(dir, [
      [flaky, result("failed", 0)],
      [flaky, result("passed", 1)],
      [broken, result("failed", 0)],
      [broken, result("timedOut", 1)],
      [expectedFail, result("failed", 0)],
      [testCase("stopped"), result("interrupted", 0)],
    ])

    expect(provider.requests).toHaveLength(1)
    const retry = JSON.parse(readFileSync(path.join(dir, "retry.json"), "utf8"))
    expect(retry.failedTests).toEqual(["broken"])
    const state = provider.requests[0]?.state as { previous_attempts: string[]; status: string }
    expect(state).toMatchObject({ status: "timedOut", previous_attempts: ["failed"] })
  })

  it("clears handoff files from an earlier run when everything passes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    writeFileSync(path.join(dir, "retry.json"), JSON.stringify({ status: "failed", failedTests: ["old"] }))
    writeFileSync(path.join(dir, "heal.json"), JSON.stringify([{ testId: "old" }]))
    const provider = await run(dir, [[testCase("ok"), result("passed")]])

    expect(provider.requests).toHaveLength(0)
    expect(JSON.parse(readFileSync(path.join(dir, "retry.json"), "utf8")).failedTests).toEqual([])
    expect(JSON.parse(readFileSync(path.join(dir, "heal.json"), "utf8"))).toEqual([])
    expect(existsSync(path.join(dir, "triage.md"))).toBe(true)
  })
})
