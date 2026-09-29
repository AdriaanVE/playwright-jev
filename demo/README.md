# Decision race demo

## Explainer video

`npm run demo:explainer` renders `demo/output/explainer.mp4`, a 103-second explainer for engineers: what JEV
is, what goes in and comes out, and what it changes in a Playwright suite. It needs no API keys:
[`explainer/explainer.html`](explainer/explainer.html) draws every frame as a function of time, and
[`explainer/render.mjs`](explainer/render.mjs) steps through it with Playwright and encodes the frames with ffmpeg.

Sound effects are synthesized in [`explainer/sounds.mjs`](explainer/sounds.mjs) from cues the page derives from its
own timeline, so they stay in sync when scenes move. They are sparse and quiet (peak about -12 dBFS): a soft
whoosh on scene changes, a tick per token while the LLM writes, a chime when JEV answers, a low knock when the
LLM answers, two falling notes for the caught bug, and a soft chord on the results and end card.

| Time | Scene |
| --- | --- |
| 0 to 13 s | JEV is a non-autoregressive decision engine, extremely fast and cheap: one forward pass for every question against one per token for an LLM, with 0.35 s and $0.000025 per decision against 4.9 s and $0.0044 |
| 13 to 26 s | Input: unstructured state (an accessibility snapshot) inside a structured `/v1/systemone` request |
| 26 to 42 s | `noul`, `choice`, and `score`: criteria, answer JSON, and probabilities for each |
| 42 to 52 s | Output: typed answers checked against playwright-jev's default thresholds |
| 52 to 62 s | playwright-jev: which Playwright extension point uses which question type |
| 62 to 72 s | Locator healing on the demo shop, both engines in real time, with cost per decision |
| 72 to 84 s | The whole suite, 8× speed, with questions, waiting time, and AI cost adding up per lane |
| 84 to 96 s | Results: 4.8× faster and 177× cheaper with the same outcomes, plus each lane's triage cost line |
| 96 to 103 s | End card |

Timings, costs, and outcomes come from the recorded runs in [Measured numbers](#measured-numbers), and
the triage lines from those runs' `triage.md`. The probabilities in the question-type scene are example values. Open `explainer.html` in a
browser to preview it live (click to restart, add `#t=31` to jump to a time). Pass `--fps 60` for a smoother
render, `--stills 12,26` to save PNG frames instead, `--silent` for no sound, or `--audio-only` to rebuild just the
sound track of the last render.

## Live race

A side-by-side race for a non-technical audience. The same AI-assisted Playwright suite runs twice, at
the same time, against a shop release that renamed four controls and broke the cart total. While the
tests run, they ask AI 12 small questions: which element a renamed button is now, whether a page shows
what it should, and why a test failed.

| Lane | Who answers the questions |
| --- | --- |
| Left, Playwright with Claude Opus 5.5 | Claude Opus 5.5 through OpenRouter chat completions, as when Claude Code or Playwright's agents answer these questions with the session model |
| Right, Playwright with JEV | JEV, TypeSafe's decision engine, through OpenRouter |

Both lanes get identical questions and page data and use the same thresholds and timeouts. Only the
engine differs, so any time difference is waiting for AI answers.

## What viewers see

1. **Intro.** "We replaced Claude Opus 5.5 calls in our tests with JEV": what JEV is, and 4.7 s versus 0.3 s
   per question.
2. **Race.** Two columns, each with:
   - a stopwatch
   - a bar splitting the time into testing (green) and waiting on AI (striped)
   - the live test browser, with a ring around each element the AI picked and the time it took
   - the question the test is asking, with a live counter while it waits
   - the 10 tests, tagged "Healed" or "Bug found"
   - one bar per question showing how long it waited
3. **Result.** "JEV finished 4.8× faster than Claude Opus 5.5, with the same results" (4.8 to 5.0× across
   takes, 14 to 15× less waiting on AI). Both lanes heal the
   same four controls and catch the same cart bug. The test steps take the same time; the waiting does not.

## Run it

```sh
export OPENROUTER_API_KEY=...
npm run demo            # watch it in a browser window
npm run demo:record     # also save demo/output/race.mp4
```

Options, passed after `--` (for example `npm run demo -- --llm openai/gpt-4.1-mini`):

| Option | Effect |
| --- | --- |
| `--record` | Save `demo/output/race.webm`, and `race.mp4` when ffmpeg is installed |
| `--headless` | No window; use with `--record` |
| `--llm <model>` | Compare against another OpenRouter model, for example `anthropic/claude-sonnet-4.6` |
| `--provider typesafe` | Call JEV through TypeSafe's API with `TYPESAFE_API_KEY` |
| `--release v1` | Nothing broken: fewer questions, the lanes only differ on page checks |
| `--hold-ms 14000` | How long the result screen stays up |

A recording is about 100 seconds: 9 seconds of intro, about 73 seconds of race (JEV is done after 15), and
the result screen.

## Measured numbers

Two recorded runs on one laptop, live APIs, no caching:

| | Claude Opus 5.5 lane | JEV lane |
| --- | --- | --- |
| Total run time | 69.3 to 72.5 s | 14.4 to 14.6 s |
| Waiting on AI | 59.1 to 62.3 s | 4.2 to 4.3 s |
| Average per question | 4.93 to 5.19 s | 0.35 to 0.36 s |
| Test steps | about 10.2 s | about 10.2 s |
| AI cost per run | $0.053 | $0.0003 |
| Tests passed, bugs caught | 9 of 10, 1 | 9 of 10, 1 |

Other engines on the same questions, timed separately:

| Engine | Per question | All answers correct |
| --- | --- | --- |
| JEV | 0.3 to 0.6 s | Yes |
| Claude Sonnet 4.6 | 1.2 to 1.7 s | Yes |
| GPT-4.1 mini | 1.1 to 1.5 s | One page check wrong |
| Claude Haiku 4.5 | 2.0 to 2.2 s | Yes |
| Claude Opus 5 | 2.2 to 5.9 s | Yes |
| Claude Opus 5.5 | 2.5 to 7.8 s | Yes |

With Claude Sonnet 4.6 as the baseline (`--llm anthropic/claude-sonnet-4.6`), the recorded runs took
26 to 28 s against 14 to 16 s for JEV.

## Honest framing

- The speedup is in the AI questions, not in Playwright itself. The more questions a suite asks, the
  larger the share of time JEV saves; a suite that asks none gains nothing.
- Opus 5.5 is what these questions go to when a Claude Code session on Opus answers them. Test code that
  calls an API directly would more likely use a smaller model; Sonnet 4.6 is the closest baseline for that,
  and JEV is still about 4× faster per question there.
- Results vary slightly between runs, because API latency varies. Record a few takes.
