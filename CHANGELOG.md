# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

## [0.1.0] - 2026-09-29

First public release.

### Added

- Pluggable decision providers: OpenRouter JEV by default, TypeSafe's own JEV API (`typesafe`, with
  `jev-latest`, `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL`), any HTTP endpoint
  with optional request and response mapping, custom modules, or provider instances, with environment
  overrides, retries, concurrency limits, and a file-backed decision cache.
- Playwright reporter that triages each final failure into configurable root-cause categories and writes
  JSON, Markdown, retry, and heal handoff files. When the provider does not report cost, the report shows
  input tokens and says so, and cached decisions do not count as calls.
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
- A recordable side-by-side demo (`npm run demo`, `npm run demo:record`) that races the same AI-assisted
  suite with Claude Opus 5.5 and with JEV answering its questions, against a shop release with four renamed
  controls and a broken cart total, ending on waiting time, run time, and cost per engine.
- An explainer video for engineers (`npm run demo:explainer`, saved as `demo/output/explainer.mp4`), rendered
  frame by frame from HTML with synthesized sound effects, so it needs no API keys or audio assets.

[0.1.0]: https://github.com/AdriaanVE/playwright-jev/releases/tag/v0.1.0
