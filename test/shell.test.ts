import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { shellWord } from "../src/shell.js"

describe("shellWord", () => {
  it.each([
    ["plain title", "plain title"],
    ["it's quoted", "it's quoted"],
    ["pays $' fee and $& more", "pays ' fee and & more"],
    ["runs $(touch MARKER) and `touch MARKER`", "runs (touch MARKER) and touch MARKER"],
  ])("keeps %j inert in single and double quoted templates", (title, expected) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pwjev-"))
    const word = shellWord(title)
    expect(execFileSync("sh", ["-c", `printf %s ${word}`], { cwd, encoding: "utf8" })).toBe(expected)
    execFileSync("sh", ["-c", `printf %s "heal ${word}"`], { cwd, encoding: "utf8" })
    expect(existsSync(path.join(cwd, "MARKER"))).toBe(false)
  })
})
