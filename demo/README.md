# Test race demo

A side-by-side race for a non-technical audience. The same 10 end-to-end tests run at the same time
in two pipelines, against a small shop that just shipped a release with three problems:

| Problem | Standard Playwright | Playwright with JEV |
| --- | --- | --- |
| "Checkout" button renamed to "Go to checkout" | Waits 30 seconds, three times, then fails | Heals the locator in about 2 seconds and passes |
| Cart total skips the last item (a real bug) | Retries it twice | Triages it as an app bug and sends it to a person |
| First search is slow while a cache warms up | Passes on retry 1 | Triages it as a slow page and reruns only that test |

The screen shows each pipeline's four live browsers, a timeline of every test attempt, and a
stopwatch per lane. An end card compares time to a final answer, reruns, failures that would go on to
an AI healer, and JEV's decision count and cost.

## Run it

```sh
export OPENROUTER_API_KEY=...
npm run demo            # watch it in a browser window
npm run demo:record     # also save demo/output/race.mp4
```

Options, passed after `--` (for example `npm run demo -- --release v1`):

| Option | Effect |
| --- | --- |
| `--release v1` | Control round: nothing is broken, and both lanes finish together |
| `--record` | Save `demo/output/race.webm`, and `race.mp4` when ffmpeg is installed |
| `--headless` | No window; use with `--record` |
| `--provider typesafe` | Use TypeSafe's JEV API with `TYPESAFE_API_KEY` |
| `--hold-ms 12000` | How long the end card stays on screen |

A full run takes about 1 minute 45 seconds, most of it standard Playwright waiting out timeouts.

## Suggested presentation

1. Play the control round first (`--release v1`, about 15 seconds). It shows that JEV costs nothing
   when every test passes.
2. Play the release 2 race. Point at the checkout row: the top lane waits on a button that no longer
   exists, and the bottom lane heals it.
3. End on the tally. If the audience asks about AI healers: standard Playwright would now send both
   remaining failures to an LLM healer, including the real cart bug, which the healer might "fix" by
   changing the expected total. JEV sends none, and the bug goes to a person.

## Fairness

- Both lanes run the same spec file, the same browser, 4 workers each, and their own copy of the shop.
- Standard Playwright uses `retries: 2`, the setting `npm init playwright` generates for CI, and its
  default timeouts. Tighter timeouts would shorten its run, but it would still retry the real bug.
- JEV calls are live, with no decision cache. Three recorded runs on one laptop: standard 92.7 to
  92.8 seconds, JEV 9.2 to 10.3 seconds, with 3 JEV decisions per run at 0.5 to 0.9 seconds each and
  $0.0002 in total. The control round finished in 2.5 and 2.8 seconds.
- Results vary slightly between runs, because JEV's probabilities vary. Record a few takes.
