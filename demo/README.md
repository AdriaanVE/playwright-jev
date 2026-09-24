# Decision race demo

A side-by-side race for a non-technical audience. The same AI-assisted Playwright suite runs twice, at
the same time, against a shop release that renamed four controls and broke the cart total. While the
tests run, they ask AI 12 small questions: which element a renamed button is now, whether a page shows
what it should, and why a test failed.

| Lane | Who answers the questions |
| --- | --- |
| Left, Playwright with an LLM | Claude Sonnet 4.6 through OpenRouter chat completions |
| Right, Playwright with JEV | JEV, TypeSafe's decision engine, through OpenRouter |

Both lanes get identical questions and page data and use the same thresholds and timeouts. Only the
engine differs, so any time difference is waiting for AI answers.

## What viewers see

1. **Intro.** "We replaced the LLM calls in our tests with JEV": what JEV is, and 1.3 s versus 0.3 s per
   question.
2. **Race.** Two columns, each with:
   - a stopwatch
   - a bar splitting the time into testing (green) and waiting on AI (striped)
   - the live test browser, with a ring around each element the AI picked and the time it took
   - the question the test is asking, with a live counter while it waits
   - the 10 tests, tagged "Healed" or "Bug found"
   - one bar per question showing how long it waited
3. **Result.** "Same results. 3× less waiting on AI" (3 to 4× across takes). Both lanes heal the same four controls and catch
   the same cart bug. The test steps take the same time; the waiting does not.

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
| `--llm <model>` | Compare against another OpenRouter model |
| `--provider typesafe` | Call JEV through TypeSafe's API with `TYPESAFE_API_KEY` |
| `--release v1` | Nothing broken: fewer questions, the lanes only differ on page checks |
| `--hold-ms 14000` | How long the result screen stays up |

A recording is about 50 seconds: 9 seconds of intro, about 28 seconds of race, and the result screen.

## Measured numbers

Recorded runs on one laptop, live APIs, no caching:

| | LLM lane | JEV lane |
| --- | --- | --- |
| Total run time | 26.1 to 28.4 s | 14.0 to 15.9 s |
| Waiting on AI | 16.0 to 17.6 s | 4.0 to 5.7 s |
| Average per question | 1.33 to 1.47 s | 0.33 to 0.47 s |
| Test steps | about 10 s | about 10 s |
| AI cost per run | $0.022 | $0.0003 |
| Tests passed, bugs caught | 9 of 10, 1 | 9 of 10, 1 |

Before building the demo, the same heal question was also timed against other LLMs: Claude Haiku 4.5
2.0 to 2.2 s, GPT-4.1 mini 1.1 to 1.3 s, JEV 0.26 to 0.67 s. All picked the right element. GPT-4.1 mini
answered one page check wrongly, and Claude Sonnet 5 and GPT-5 mini took 3.6 to 8.9 s per page check.

## Honest framing

- The speedup is in the AI questions, not in Playwright itself. The more questions a suite asks, the
  larger the share of time JEV saves; a suite that asks none gains nothing.
- The LLM lane is a fair baseline for an LLM-based self-healing or checking step, not the slowest
  possible one. A reasoning model would be much slower; see the numbers above.
- Results vary slightly between runs, because API latency varies. Record a few takes.
