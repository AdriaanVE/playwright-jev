#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { loadConfig, resolveConfig } from "./config.js"
import { findSpecs, gitDiff, scoreSpecs } from "./features/impact.js"
import { runMcpProxy } from "./mcp-proxy.js"
import { shellWord } from "./shell.js"

const usage = `Usage: playwright-jev <command> [options]

Commands:
  retry [-- playwright args]   Rerun only failures triaged as transient (feature 2)
  heal  [--dry-run]            Run the configured healer on healable failures (feature 3)
  impact [--base ref] [--dir tests] [--json]
                               Order spec files by relevance to the diff (feature 8)
  mcp [-- upstream command]    MCP proxy that prunes snapshots and adds jev_verify_step (features 4, 5)

Triage (feature 1) runs in the reporter: add ["playwright-jev/reporter"] to your Playwright reporters.
Locator healing (6) and toSatisfy (7) come from "playwright-jev/test".`

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2)
  const separator = rest.indexOf("--")
  const own = separator === -1 ? rest : rest.slice(0, separator)
  const passthrough = separator === -1 ? [] : rest.slice(separator + 1)
  const loaded = await loadConfig()
  const config = await resolveConfig(loaded.config, loaded.dir)

  switch (command) {
    case "retry": {
      const file = path.join(config.outputDir, "retry.json")
      if (!existsSync(file)) {
        console.error(`${file} not found. Run Playwright with the playwright-jev reporter first.`)
        return 1
      }
      const { failedTests } = JSON.parse(readFileSync(file, "utf8")) as { failedTests: string[] }
      if (failedTests.length === 0) {
        console.log("[playwright-jev] No failures were triaged as transient; nothing to rerun.")
        return 0
      }
      console.log(`[playwright-jev] Rerunning ${failedTests.length} transient failure(s).`)
      const result = spawnSync(
        "npx",
        ["playwright", "test", "--last-failed", "--last-failed-file", file, ...passthrough],
        {
          stdio: "inherit",
        },
      )
      return result.status ?? 1
    }

    case "heal": {
      const { values } = parseArgs({ args: own, options: { "dry-run": { type: "boolean" } } })
      const file = path.join(config.outputDir, "heal.json")
      const failures = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { name: string; title: string; file: string }[])
        : []
      if (failures.length === 0) {
        console.log("[playwright-jev] No failures were triaged as healable.")
        return 0
      }
      const template = config.healerGate.command
      if (!template || values["dry-run"]) {
        for (const failure of failures) console.log(`${failure.file}\t${failure.title}`)
        if (!template) console.error("\nSet healerGate.command in playwright-jev.config to run a healer automatically.")
        return 0
      }
      const tests = failures.map((failure) => shellWord(failure.name)).join(" ")
      const files = [...new Set(failures.map((failure) => shellWord(failure.file)))].join(" ")
      // Function replacers stop `$&` and similar patterns in titles from being expanded by replaceAll.
      const commandLine = template.replaceAll("{tests}", () => tests).replaceAll("{files}", () => files)
      console.log(`[playwright-jev] Healing ${failures.length} failure(s): ${commandLine}`)
      return (
        spawnSync(commandLine, {
          stdio: "inherit",
          shell: true,
          env: { ...process.env, PLAYWRIGHT_JEV_HEAL_FILE: path.resolve(file) },
        }).status ?? 1
      )
    }

    case "impact": {
      const { values } = parseArgs({
        args: own,
        options: { base: { type: "string" }, dir: { type: "string", default: "tests" }, json: { type: "boolean" } },
      })
      const dir = path.resolve(values.dir ?? "tests")
      const specs = findSpecs(dir).map((file) => path.relative(process.cwd(), file))
      const diff = gitDiff(values.base ?? config.impact.base)
      const scored = await scoreSpecs({ config, specs, diff })
      mkdirSync(config.outputDir, { recursive: true })
      writeFileSync(path.join(config.outputDir, "impact.json"), JSON.stringify(scored, null, 2))
      if (values.json) console.log(JSON.stringify(scored, null, 2))
      else {
        const first = scored.filter((item) => item.score >= config.impact.minScore)
        console.error(
          `[playwright-jev] ${first.length}/${scored.length} spec(s) relevant to ${diff.files.length} changed file(s).`,
        )
        // Plain list for `npx playwright test $(playwright-jev impact)`; relevant specs first, everything else after.
        console.log(scored.map((item) => item.file).join("\n"))
      }
      return 0
    }

    case "mcp": {
      const [upstreamCommand = "npx", ...upstreamArgs] = passthrough.length
        ? passthrough
        : ["npx", "@playwright/mcp@latest", "--snapshot-mode", "full"]
      await runMcpProxy({ config, command: upstreamCommand, args: upstreamArgs })
      return -1
    }

    default:
      console.log(usage)
      return command && command !== "help" && command !== "--help" ? 1 : 0
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code)
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
