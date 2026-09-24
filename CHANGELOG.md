# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [0.4.1] - 2026-09-24

### Changed

- The demo now races JEV against Claude Opus 5.5 by default and names the model on every screen. The
  per-question chart scales to the slowest answer.

## [0.4.0] - 2026-09-24

### Changed

- The demo now races the same AI-assisted suite with an LLM and with JEV answering its questions,
  side by side, instead of comparing against plain retries. It opens with what JEV is, circles each
  element the AI picks in the live browsers, shows every question's wait, and ends on waiting time,
  run time, and cost per engine. Release 2 of the demo shop now has four renamed controls.

## [0.3.0] - 2026-09-24

### Added

- A recordable side-by-side demo (`npm run demo`, `npm run demo:record`) that races standard
  Playwright against playwright-jev on a shop release with a renamed button, a real bug, and a slow
  first search, showing live browsers, a timeline, stopwatches, and a final tally.

## [0.2.0] - 2026-09-24

### Added

- `typesafe` provider for TypeSafe's own JEV API, with `jev-latest`, `TYPESAFE_API_KEY`, and the
  TypeSafe SDK's `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` variables.

### Fixed

- Triage reports no longer show a $0 decision cost when the provider does not report cost. They show
  input tokens and say the cost was not reported, and cached decisions no longer count as calls.

## [0.1.0] - 2026-09-24

### Added

- Pluggable decision providers: OpenRouter JEV by default, any HTTP endpoint with optional request and
  response mapping, custom modules, or provider instances, with environment overrides, retries,
  concurrency limits, and a file-backed decision cache.
- Playwright reporter that triages each final failure into configurable root-cause categories and writes
  JSON, Markdown, retry, and heal handoff files.
- `playwright-jev retry` and `playwright-jev heal` commands that rerun only transient failures and send
  only healable failures to a configurable healer command.
- `playwright-jev/test` fixture that heals missing locators at runtime in report or enforce mode, and an
  `expect(...).toSatisfy(claim)` matcher over the accessibility tree.
- `playwright-jev mcp` proxy for Playwright MCP that prunes snapshots against the agent's goal and adds
  `jev_set_goal` and `jev_verify_step` tools, in front of either `@playwright/mcp` or the test server that
  Playwright's own agents use.
- `playwright-jev impact` command that orders spec files by relevance to a git diff.
- A usage guide covering adoption, CI, Playwright agents, configuration, custom providers, and data
  handling, plus an agent skill for coding agents working in projects that use playwright-jev.
