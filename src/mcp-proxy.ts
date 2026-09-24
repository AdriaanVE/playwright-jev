import { readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import type { ResolvedConfig } from "./config.js"
import { extractSnapshot, extractSnapshotLink, pruneSnapshot, verifyStep } from "./features/snapshot-pruning.js"

export type ProxyOptions = {
  config: ResolvedConfig
  /** Upstream MCP server command. Defaults to `npx @playwright/mcp@latest`. */
  command: string
  args: string[]
  /** Directory the upstream server runs in; linked snapshot files resolve against it. */
  cwd?: string
  log?: (message: string) => void
}

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean }

const goalProperty = {
  jev_goal: {
    type: "string",
    description:
      "Optional. What you are trying to do on this page. playwright-jev uses it to drop irrelevant parts of the returned snapshot. Omit to reuse the last goal.",
  },
  jev_full_snapshot: { type: "boolean", description: "Optional. Return the unpruned snapshot." },
}

const extraTools: Tool[] = [
  {
    name: "jev_set_goal",
    description:
      "Set the current goal used to prune page snapshots, for example 'add the first product to the cart'. Call it when your goal changes.",
    inputSchema: { type: "object", properties: { goal: { type: "string" } }, required: ["goal"] },
  },
  {
    name: "jev_verify_step",
    description:
      "Check cheaply whether the last action achieved its expected outcome, using the live page snapshot. Returns achieved true or false with a probability. Use this instead of re-reading the full snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "string", description: "The action just performed." },
        expected: { type: "string", description: "What the page should show if it worked." },
        threshold: { type: "number", description: "Minimum probability to count as achieved. Default 0.8." },
      },
      required: ["step", "expected"],
    },
  },
]

/**
 * MCP proxy in front of Playwright MCP (features 4 and 5). Tool calls pass through unchanged; snapshots
 * in results are pruned against the agent's goal, and `jev_verify_step` answers step checks with one
 * decision instead of another LLM turn over the full tree.
 */
export async function runMcpProxy(options: ProxyOptions): Promise<void> {
  const { config } = options
  const log = options.log ?? ((message: string) => process.stderr.write(`[playwright-jev] ${message}\n`))
  const upstream = new Client({ name: "playwright-jev", version: "0.1.0" })
  await upstream.connect(
    new StdioClientTransport({ command: options.command, args: options.args, cwd: options.cwd, stderr: "inherit" }),
  )

  let goal = ""
  const stats = { calls: 0, originalChars: 0, keptChars: 0 }
  const server = new Server(
    { name: "playwright-jev", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: upstream.getInstructions() },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await upstream.listTools()
    const extended = tools.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...(tool.inputSchema.properties ?? {}), ...goalProperty },
      },
    }))
    return { tools: config.stepVerification.enabled ? [...extended, ...extraTools] : [...extended, extraTools[0]] }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params
    const { jev_goal, jev_full_snapshot, ...args } = (request.params.arguments ?? {}) as Record<string, unknown>
    if (typeof jev_goal === "string" && jev_goal.trim()) goal = jev_goal.trim()

    if (name === "jev_set_goal") {
      goal = String(args.goal ?? "").trim()
      return text(`Goal set: ${goal}`)
    }
    if (name === "jev_verify_step") {
      if (!config.stepVerification.enabled) return text("jev_verify_step is disabled in playwright-jev config.", true)
      const snapshot = await currentSnapshot(upstream, options.cwd)
      if (!snapshot) return text("No page snapshot is available; navigate first.", true)
      try {
        const result = await verifyStep(
          {
            step: String(args.step),
            expected: String(args.expected),
            snapshot,
            threshold: typeof args.threshold === "number" ? args.threshold : undefined,
          },
          config,
        )
        return text(JSON.stringify({ achieved: result.achieved, probability: Number(result.probability.toFixed(3)) }))
      } catch (error) {
        return text(`Step verification failed: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    }

    const result = (await upstream.callTool({ name, arguments: args })) as ToolResult
    if (jev_full_snapshot === true || !goal) return result
    const content = await Promise.all(
      result.content.map(async (item) => {
        if (item.type !== "text" || !item.text) return item
        const parts = extractSnapshot(item.text) ?? inlineLinkedSnapshot(item.text, options.cwd)
        if (!parts) return item
        try {
          const pruned = await pruneSnapshot(parts.snapshot, goal, config)
          if (!pruned.pruned) return item
          stats.calls++
          stats.originalChars += pruned.originalChars
          stats.keptChars += pruned.keptChars
          log(
            `pruned ${name}: ${pruned.originalChars} -> ${pruned.keptChars} chars, ` +
              `${pruned.keptRegions}/${pruned.totalRegions} regions (session ${stats.originalChars} -> ${stats.keptChars})`,
          )
          const note =
            "\n[playwright-jev: collapsed regions are irrelevant to the goal; pass jev_full_snapshot to expand]"
          return { ...item, text: `${parts.before}${pruned.text}${parts.after}${note}` }
        } catch (error) {
          log(`pruning skipped: ${error instanceof Error ? error.message : String(error)}`)
          return item
        }
      }),
    )
    return { ...result, content }
  })

  const shutdown = async () => {
    await upstream.close().catch(() => undefined)
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  await server.connect(new StdioServerTransport())
  log(`proxying ${options.command} ${options.args.join(" ")} via ${config.provider.name}`)
}

async function currentSnapshot(upstream: Client, cwd: string | undefined): Promise<string | undefined> {
  const result = (await upstream.callTool({ name: "browser_snapshot", arguments: {} })) as ToolResult
  for (const item of result.content) {
    if (item.type !== "text" || !item.text) continue
    const parts = extractSnapshot(item.text) ?? inlineLinkedSnapshot(item.text, cwd)
    if (parts) return parts.snapshot
  }
  return undefined
}

/** Read a snapshot the upstream saved to disk, so it can be pruned and returned inline in its place. */
function inlineLinkedSnapshot(
  text: string,
  cwd: string | undefined,
): { before: string; snapshot: string; after: string } | undefined {
  const link = extractSnapshotLink(text)
  if (!link) return undefined
  try {
    const snapshot = readFileSync(path.resolve(cwd ?? process.cwd(), link.file), "utf8").trimEnd()
    const index = text.indexOf(link.line)
    return {
      before: `${text.slice(0, index)}\`\`\`yaml\n`,
      snapshot,
      after: `\n\`\`\`${text.slice(index + link.line.length)}`,
    }
  } catch {
    return undefined
  }
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) }
}
