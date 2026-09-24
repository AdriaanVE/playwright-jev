# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

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
