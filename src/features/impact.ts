import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { ResolvedConfig } from "../config.js"
import { score, scoreAnswer } from "../questions.js"
import { clip } from "../snapshot.js"

export type SpecImpact = { file: string; score: number; probabilities?: Record<string, number>; error?: string }

const legend = [
  "Unrelated: the change cannot affect this spec",
  "Possibly related: shared code or indirect dependency",
  "Likely affected: the change touches a flow this spec covers",
  "Directly affected: the change targets exactly what this spec tests",
]

/** Score each spec's relevance to the change (feature 8). Scores order specs; they never skip them. */
export async function scoreSpecs(options: {
  config: ResolvedConfig
  specs: string[]
  diff: { files: string[]; patch: string; commits: string }
  cwd?: string
}): Promise<SpecImpact[]> {
  const { config, specs, diff } = options
  const cwd = options.cwd ?? process.cwd()
  const change = { changed_files: diff.files.slice(0, 200), commits: diff.commits, patch: clip(diff.patch, 12_000) }
  const results: SpecImpact[] = []
  for (let start = 0; start < specs.length; start += config.impact.batchSize) {
    const batch = specs.slice(start, start + config.impact.batchSize)
    const questions = Object.fromEntries(
      batch.map((file, index) => [
        `spec_${index}`,
        score(`How likely is it that the code change affects the behavior tested by ${file}?`, legend),
      ]),
    )
    const specSummaries = Object.fromEntries(batch.map((file) => [file, summarizeSpec(path.resolve(cwd, file))]))
    try {
      const response = await config.provider.decide({
        state: { change, specs: specSummaries },
        questions,
        metadata: { feature: "impact" },
      })
      batch.forEach((file, index) => {
        const answer = scoreAnswer(response, `spec_${index}`)
        results.push({ file, score: answer.score, probabilities: answer.probabilities })
      })
    } catch (error) {
      // Unknown relevance ranks as high as possible so failures never push a spec down.
      for (const file of batch) {
        results.push({ file, score: legend.length - 1, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
}

/** Titles, steps, and URLs are enough to judge relevance and keep the state small. */
export function summarizeSpec(file: string): string {
  const source = readFileSync(file, "utf8")
  const interesting = source
    .split("\n")
    .filter((line) => /\b(test|describe|step)(\.\w+)?\(|goto\(|getBy\w+\(|import /.test(line))
    .map((line) => line.trim())
  return clip(interesting.join("\n"), 2_500)
}

export function gitDiff(base: string, cwd = process.cwd()): { files: string[]; patch: string; commits: string } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  const mergeBase = git("merge-base", base, "HEAD").trim()
  return {
    files: git("diff", "--name-only", mergeBase).split("\n").filter(Boolean),
    patch: git("diff", "--unified=1", mergeBase),
    commits: clip(git("log", "--format=%s", `${mergeBase}..HEAD`), 2_000),
  }
}

export function findSpecs(dir: string, pattern = /\.(spec|test)\.[cm]?[jt]sx?$/): string[] {
  const results: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (pattern.test(entry)) results.push(full)
    }
  }
  walk(dir)
  return results.sort()
}
