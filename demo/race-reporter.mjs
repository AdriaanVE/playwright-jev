// Streams test progress to the race dashboard. Both lanes use this reporter, so the dashboard sees the same
// events from each side.
const url = process.env.DEMO_EVENTS_URL
const lane = process.env.DEMO_LANE
const phase = process.env.DEMO_PHASE ?? "run"
const esc = String.fromCharCode(27)
const stripAnsi = (text) => text?.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "")

export default class RaceReporter {
  pending = []

  printsToStdio() {
    return false
  }

  send(type, data) {
    if (!url) return
    const body = JSON.stringify({ type, lane, phase, ...data })
    this.pending.push(
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => undefined),
    )
  }

  onBegin(_config, suite) {
    this.send("suite", { tests: suite.allTests().map((test) => ({ title: test.title })) })
  }

  onTestBegin(test, result) {
    this.send("test-begin", { title: test.title, retry: result.retry })
  }

  onTestEnd(test, result) {
    const healed = result.annotations
      .filter((annotation) => annotation.type === "jev-heal" && annotation.description)
      .map((annotation) => JSON.parse(annotation.description))
      .filter((event) => event.outcome === "healed")
      .map(({ original, healedLocator, element, probability }) => ({ original, healedLocator, element, probability }))
    this.send("test-end", {
      title: test.title,
      retry: result.retry,
      status: result.status,
      ok: result.status === test.expectedStatus,
      durationMs: result.duration,
      healed,
      error: stripAnsi(result.errors[0]?.message?.split("\n")[0]),
    })
  }

  async onEnd() {
    await Promise.all(this.pending)
  }
}
