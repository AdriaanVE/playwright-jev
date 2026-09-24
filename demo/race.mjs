#!/usr/bin/env node
// Runs the same Playwright suite twice, side by side: standard Playwright and playwright-jev. A dashboard
// shows both lanes live, and `--record` saves it as a video for sharing.
//
//   node demo/race.mjs                 open the dashboard and race after v2 ships
//   node demo/race.mjs --record        also save demo/output/race.webm (and .mp4 when ffmpeg exists)
//   node demo/race.mjs --release v1    control round: nothing is broken, both lanes should tie
//   node demo/race.mjs --headless      no visible window (CI, smoke tests)
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs"
import http from "node:http"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "@playwright/test"
import { startShop } from "./app/shop.mjs"

const here = import.meta.dirname
const root = path.resolve(here, "..")
const output = path.join(here, "output")

const { values: args } = parseArgs({
  options: {
    release: { type: "string", default: "v2" },
    record: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    provider: { type: "string", default: "openrouter" },
    "hold-ms": { type: "string", default: "12000" },
  },
})

const keyVariable = args.provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY"
if (!process.env[keyVariable]) {
  console.error(`${keyVariable} is not set. The JEV lane calls the live API.`)
  process.exit(1)
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
// Latest screencast frame per lane and worker. Frames skip the history so late joiners get no backlog.
const frames = new Map()
const hub = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/events/frame") {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        const frame = JSON.parse(body)
        frames.set(`${frame.lane}:${frame.worker}`, frame)
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

// Each lane gets its own copy of the shop, so the one-time slow search hits both lanes equally.
const shops = {
  standard: await startShop({ port: 0, release: args.release }),
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
await dashboard.goto(`http://127.0.0.1:${hubPort}/?release=${args.release}&provider=${args.provider}`)
await dashboard.waitForFunction(() => window.dashboardReady === true)
await dashboard.waitForTimeout(2_500) // Title card.

publish({ type: "start", release: args.release })
const results = await Promise.all([runStandard(), runJev()])
publish({ type: "finish", results })
console.log(results.map((result) => `${result.lane}: ${(result.ms / 1000).toFixed(1)}s`).join("  "))

await dashboard.waitForTimeout(Number(args["hold-ms"])) // Final tally.
const video = dashboard.video()
await context.close()
await browser.close()
if (video) finishVideo(await video.path())
for (const server of [hub, ...Object.values(shops)]) server.close()
process.exit(0)

async function runStandard() {
  const started = Date.now()
  publish({ type: "phase", lane: "standard", phase: "run", label: "Running the suite, with retries: 2" })
  await playwright("standard", "playwright.standard.config.ts", [])
  publish({ type: "lane-done", lane: "standard" })
  return { lane: "standard", ms: Date.now() - started }
}

async function runJev() {
  const started = Date.now()
  publish({ type: "phase", lane: "jev", phase: "run", label: "Running the suite, JEV triages failures" })
  await playwright("jev", "playwright.jev.config.ts", [])
  const retryFile = path.join(output, "jev", "playwright-jev", "retry.json")
  const triage = readJson(path.join(output, "jev", "playwright-jev", "triage.json"))
  publish({ type: "triage", lane: "jev", results: triage?.results ?? [] })
  const rerun = readJson(retryFile)?.failedTests ?? []
  if (rerun.length) {
    publish({
      type: "phase",
      lane: "jev",
      phase: "retry",
      label: `Rerunning ${rerun.length} transient failure(s) only`,
    })
    await playwright("jev", "playwright.jev.config.ts", ["--last-failed", "--last-failed-file", retryFile], "retry")
  }
  publish({ type: "lane-done", lane: "jev" })
  return { lane: "jev", ms: Date.now() - started }
}

function playwright(lane, config, extra, phase = "run") {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules", "@playwright", "test", "cli.js"), "test", "-c", config, ...extra],
      {
        cwd: here,
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          DEMO_LANE: lane,
          DEMO_PHASE: phase,
          DEMO_BASE_URL: baseUrl(lane),
          DEMO_EVENTS_URL: eventsUrl,
          DEMO_PROVIDER: args.provider,
          PLAYWRIGHT_JEV_CONFIG: path.join(here, "playwright-jev.config.mjs"),
        },
      },
    )
    child.on("exit", resolve)
  })
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
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
