#!/usr/bin/env node
// Runs the same AI-assisted Playwright suite twice, side by side. Both lanes heal renamed elements, check
// pages against plain-language claims, and triage failures. The left lane asks a general LLM each question;
// the right lane asks JEV. A dashboard shows both lanes live, and `--record` saves it as a video.
//
//   node demo/race.mjs                    open the dashboard and race after release 2 ships
//   node demo/race.mjs --record           also save demo/output/race.webm (and .mp4 when ffmpeg exists)
//   node demo/race.mjs --headless         no visible window
//   node demo/race.mjs --llm openai/gpt-4.1-mini   compare against another LLM on OpenRouter
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "@playwright/test"
import { startShop } from "./app/shop.mjs"
import { defaultLlmModel } from "./llm-provider.mjs"

const here = import.meta.dirname
const root = path.resolve(here, "..")
const output = path.join(here, "output")

const { values: args } = parseArgs({
  options: {
    release: { type: "string", default: "v2" },
    record: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    provider: { type: "string", default: "openrouter" },
    llm: { type: "string", default: defaultLlmModel },
    "hold-ms": { type: "string", default: "14000" },
  },
})

const required = ["OPENROUTER_API_KEY", ...(args.provider === "typesafe" ? ["TYPESAFE_API_KEY"] : [])]
for (const variable of required) {
  if (!process.env[variable]) {
    console.error(`${variable} is not set. Both lanes call live APIs.`)
    process.exit(1)
  }
}
if (!existsSync(path.join(root, "dist", "index.js"))) {
  console.error("playwright-jev is not built. Run `npm run build` first.")
  process.exit(1)
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

// Event hub: lanes post progress, the dashboard listens with server-sent events.
const clients = new Set()
const history = []
function publish(event) {
  event = { at: Date.now(), ...event }
  history.push(event)
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const client of clients) client.write(line)
}

const dashboardHtml = readFileSync(path.join(here, "dashboard.html"), "utf8")
// Screencast frames go straight to connected clients and skip the history, so late joiners get no backlog.
const hub = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/events/frame") {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        const frame = JSON.parse(body)
        const line = `data: ${JSON.stringify({ type: "frame", ...frame })}\n\n`
        for (const client of clients) client.write(line)
      } catch {
        // Ignore malformed frames.
      }
      response.end()
    })
    return
  }
  if (request.method === "POST" && request.url === "/events") {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        publish({ at: Date.now(), ...JSON.parse(body) })
      } catch {
        // Ignore malformed events.
      }
      response.end()
    })
    return
  }
  if (request.url === "/stream") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
    for (const event of history) response.write(`data: ${JSON.stringify(event)}\n\n`)
    clients.add(response)
    request.on("close", () => clients.delete(response))
    return
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(dashboardHtml)
})
const hubPort = await listen(hub)
const eventsUrl = `http://127.0.0.1:${hubPort}/events`

// Each lane gets its own copy of the shop.
const shops = {
  llm: await startShop({ port: 0, release: args.release }),
  jev: await startShop({ port: 0, release: args.release }),
}
const baseUrl = (lane) => `http://127.0.0.1:${shops[lane].address().port}`

// Dashboard window, optionally recorded.
const browser = await chromium.launch({ headless: args.headless })
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  ...(args.record ? { recordVideo: { dir: output, size: { width: 1920, height: 1080 } } } : {}),
})
const dashboard = await context.newPage()
const query = new URLSearchParams({ release: args.release, provider: args.provider, llm: args.llm })
await dashboard.goto(`http://127.0.0.1:${hubPort}/?${query}`)
await dashboard.waitForFunction(() => window.dashboardReady === true)
await dashboard.waitForTimeout(9_000) // Intro: what JEV is and what the race shows.

publish({ type: "start", release: args.release })
const results = await Promise.all([runLane("llm"), runLane("jev")])
publish({ type: "finish", results })
console.log(results.map((result) => `${result.lane}: ${(result.ms / 1000).toFixed(1)}s`).join("  "))

await dashboard.waitForTimeout(Number(args["hold-ms"])) // Final tally.
const video = dashboard.video()
await context.close()
await browser.close()
if (video) finishVideo(await video.path())
for (const server of [hub, ...Object.values(shops)]) server.close()
process.exit(0)

async function runLane(lane) {
  const started = Date.now()
  await playwright(lane)
  publish({ type: "lane-done", lane })
  return { lane, ms: Date.now() - started }
}

function playwright(lane) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", "playwright.config.ts"],
      {
        cwd: here,
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          DEMO_LANE: lane,
          DEMO_RELEASE: args.release,
          DEMO_BASE_URL: baseUrl(lane),
          DEMO_EVENTS_URL: eventsUrl,
          DEMO_JEV_PROVIDER: args.provider,
          DEMO_LLM_MODEL: args.llm,
          PLAYWRIGHT_JEV_CONFIG: path.join(here, "playwright-jev.config.mjs"),
        },
      },
    )
    child.on("exit", resolve)
  })
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)))
}

function finishVideo(recorded) {
  const webm = path.join(output, "race.webm")
  renameSync(recorded, webm)
  const mp4 = path.join(output, "race.mp4")
  const ffmpeg = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      webm,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      mp4,
    ],
    { stdio: "inherit" },
  )
  console.log(
    ffmpeg.status === 0 ? `Saved ${path.relative(process.cwd(), mp4)}` : `Saved ${path.relative(process.cwd(), webm)}`,
  )
}
