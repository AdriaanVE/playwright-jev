// Drives the MCP proxy against a real @playwright/mcp server. Run after `npm run build`.
import assert from "node:assert/strict"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = path.resolve(import.meta.dirname, "..")
const links = Array.from({ length: 120 }, (_, i) => `<li><a href="#${i}">Footer article ${i}</a></li>`).join("")
const html = `<main><h1>Shop</h1><button>Checkout now</button></main><footer><ul>${links}</ul></footer>`

const client = new Client({ name: "check", version: "0" })
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [
      path.join(root, "dist/cli.js"),
      "mcp",
      "--",
      "node",
      path.join(root, "node_modules/@playwright/mcp/cli.js"),
      "--headless",
      "--isolated",
      "--snapshot-mode",
      "full",
      "--output-dir",
      path.join(root, "test-results/mcp"),
    ],
    env: {
      ...process.env,
      PLAYWRIGHT_JEV_CONFIG: process.env.MCP_CHECK_CONFIG ?? path.join(import.meta.dirname, "mcp.config.mjs"),
    },
    stderr: "pipe",
  }),
)
try {
  const { tools } = await client.listTools()
  const names = tools.map((tool) => tool.name)
  assert.ok(names.includes("browser_navigate") && names.includes("jev_verify_step") && names.includes("jev_set_goal"))
  assert.ok(tools.find((tool) => tool.name === "browser_click")?.inputSchema.properties.jev_goal)

  const url = `data:text/html,${encodeURIComponent(html)}`
  await client.callTool({ name: "browser_navigate", arguments: { url } })
  await client.callTool({ name: "jev_set_goal", arguments: { goal: "click checkout" } })
  const pruned = (await client.callTool({ name: "browser_snapshot", arguments: {} })).content[0].text
  const unpruned = (await client.callTool({ name: "browser_snapshot", arguments: { jev_full_snapshot: true } }))
    .content[0].text

  assert.match(pruned, /button "Checkout now"/)
  assert.match(pruned, /\[collapsed:/)
  assert.doesNotMatch(pruned, /link "Footer article 60"/)
  assert.match(unpruned, /link "Footer article 60"/)
  const yaml = (text) => /```yaml\n([\s\S]*?)\n```/.exec(text)?.[1] ?? ""
  if (process.env.DUMP) console.log(yaml(pruned))
  console.log(`snapshot chars: full ${yaml(unpruned).length}, pruned ${yaml(pruned).length}`)

  const yes = await client.callTool({
    name: "jev_verify_step",
    arguments: { step: "open shop", expected: "A shop page with a Checkout now button" },
  })
  const no = await client.callTool({
    name: "jev_verify_step",
    arguments: { step: "pay", expected: "An order confirmation saying payment received" },
  })
  assert.equal(JSON.parse(yes.content[0].text).achieved, true)
  assert.equal(JSON.parse(no.content[0].text).achieved, false)
  console.log("mcp proxy check passed")
} finally {
  await client.close()
}
