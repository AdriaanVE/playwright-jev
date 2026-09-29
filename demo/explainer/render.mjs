#!/usr/bin/env node
// Renders explainer.html to demo/output/explainer.mp4, one frame at a time. The page draws each frame as a pure
// function of time through window.seek(t), so the video is smooth and identical on every run, with no API calls.
// Sound effects are synthesized from the page's cue list (sounds.mjs) and muxed into the same file.
//
//   node demo/explainer/render.mjs                  full video at 30 fps
//   node demo/explainer/render.mjs --fps 60
//   node demo/explainer/render.mjs --stills 3,12,26  save PNG stills at these seconds instead
//   node demo/explainer/render.mjs --silent          no sound track
//   node demo/explainer/render.mjs --audio-only      rebuild only the sound track of an existing video
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { chromium } from "@playwright/test"
import { writeSoundtrack } from "./sounds.mjs"

const here = import.meta.dirname
const output = path.resolve(here, "..", "output")
const { values: args } = parseArgs({
  options: {
    fps: { type: "string", default: "30" },
    stills: { type: "string" },
    silent: { type: "boolean", default: false },
    "audio-only": { type: "boolean", default: false },
    out: { type: "string", default: path.join(output, "explainer.mp4") },
  },
})
mkdirSync(output, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(pathToFileURL(path.join(here, "explainer.html")).href)
await page.waitForFunction(() => window.explainerReady === true)
const duration = await page.evaluate(() => window.DURATION)
const soundtrack = path.join(output, "explainer.wav")
const silentVideo = path.join(output, "explainer.silent.mp4")

if (args["audio-only"]) {
  await mux()
} else if (args.stills) {
  const dir = path.join(output, "explainer-stills")
  mkdirSync(dir, { recursive: true })
  for (const t of args.stills.split(",").map(Number)) {
    await page.evaluate((time) => window.seek(time), t)
    await page.screenshot({ path: path.join(dir, `t${t}.png`) })
  }
  console.log(`Saved stills to ${path.relative(process.cwd(), dir)}`)
} else {
  const fps = Number(args.fps)
  const frames = Math.round(duration * fps)
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"],
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
      silentVideo,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  )
  const exited = new Promise((resolve) => ffmpeg.on("exit", resolve))
  for (let frame = 0; frame < frames; frame++) {
    await page.evaluate((time) => window.seek(time), frame / fps)
    const png = await page.screenshot({ type: "png" })
    if (!ffmpeg.stdin.write(png)) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve))
    if (frame % (fps * 5) === 0) process.stdout.write(`\r${Math.round((frame / frames) * 100)}%`)
  }
  ffmpeg.stdin.end()
  const status = await exited
  if (status !== 0) throw new Error(`ffmpeg exited with ${status}`)
  await mux()
}
await browser.close()

// Adds the synthesized sound track to the silent render, or copies it through with --silent.
async function mux() {
  const inputs = ["-i", silentVideo]
  if (!args.silent) {
    writeSoundtrack(await page.evaluate(() => window.soundCues), duration, soundtrack)
    inputs.push("-i", soundtrack)
  }
  const audio = args.silent ? ["-an"] : ["-c:a", "aac", "-b:a", "192k", "-shortest"]
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    ...inputs,
    "-c:v",
    "copy",
    ...audio,
    "-movflags",
    "+faststart",
    args.out,
  ])
  console.log(`\rSaved ${path.relative(process.cwd(), args.out)}`)
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    spawn(command, commandArgs, { stdio: "inherit" }).on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    )
  })
}
