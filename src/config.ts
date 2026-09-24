import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { cachedProvider } from "./providers/cache.js"
import { type HttpProviderOptions, httpProvider } from "./providers/http.js"
import { type OpenRouterOptions, openRouterProvider } from "./providers/openrouter.js"
import { type TypeSafeOptions, typeSafeProvider } from "./providers/typesafe.js"
import type { DecisionProvider } from "./types.js"

export type ProviderConfig =
  | ({ type: "openrouter" } & OpenRouterOptions)
  | ({ type: "typesafe" } & TypeSafeOptions)
  | ({ type: "http" } & HttpProviderOptions)
  /** Load a module whose export is a DecisionProvider or a factory `(options) => DecisionProvider`. */
  | { type: "module"; module: string; export?: string; options?: unknown }

export type FeatureMode = "off" | "report" | "enforce"

export type PlaywrightJevConfig = {
  /** Provider settings or a ready provider instance. Defaults to OpenRouter JEV. */
  provider?: ProviderConfig | DecisionProvider
  cache?: { mode?: "read-write" | "read-only" | "off"; dir?: string }
  /** Maximum concurrent decision calls per process. */
  concurrency?: number
  /** Directory for reports and handoff files. */
  outputDir?: string
  /** 1. Failure triage. */
  triage?: {
    enabled?: boolean
    /** Category key to description. Replace or extend the defaults to fit your suite. */
    categories?: Record<string, string>
    /** Categories that a plain rerun can fix. */
    transient?: string[]
    /** Categories the LLM healer can fix by editing the test. */
    healable?: string[]
    instructions?: string
    /** Maximum characters of the failure page snapshot sent as state. */
    snapshotChars?: number
    /** Git ref to diff against for changed-file context. Omit to skip the diff. */
    diffBase?: string
  }
  /** 2. Smart retries. */
  retry?: { threshold?: number }
  /** 3. Healer gate. `command` runs your healer with `{tests}` (quoted titles) and `{files}` substituted. */
  healerGate?: { threshold?: number; command?: string }
  /** 4. MCP snapshot pruning. */
  snapshotPruning?: { enabled?: boolean; minChars?: number; maxRegionChars?: number; keepScore?: number }
  /** 5. MCP step verification. */
  stepVerification?: { enabled?: boolean; snapshotChars?: number }
  /** 6. Runtime locator healing. */
  locatorHealing?: {
    mode?: FeatureMode
    threshold?: number
    probeTimeoutMs?: number
    maxCandidates?: number
    /** Fail healed tests at the end when running in CI, so healing never hides drift on main. */
    failInCI?: boolean
  }
  /** 7. Semantic assertions. */
  assertions?: { threshold?: number; timeoutMs?: number; intervalMs?: number; snapshotChars?: number }
  /** 8. Test impact ordering. */
  impact?: { base?: string; minScore?: number; batchSize?: number }
}

export const defaultCategories: Record<string, string> = {
  locator_drift:
    "The element exists in a changed form: renamed text, changed role, moved or restructured markup. The page otherwise works.",
  timing: "A race or wait problem: the element or state appears later, animations, slow network, or detached elements.",
  app_bug: "The application behaves incorrectly: wrong data, missing feature, server error, or broken flow.",
  environment:
    "Infrastructure problem: network failure, DNS, service unavailable, browser crash, or out-of-memory outside the app logic.",
  test_data: "Test setup or data problem: missing fixtures, stale accounts, order dependence, or leaked state.",
  assertion_outdated: "The app changed intentionally and the test expectation is out of date.",
}

export type ResolvedConfig = {
  provider: DecisionProvider
  outputDir: string
  triage: Required<Omit<NonNullable<PlaywrightJevConfig["triage"]>, "diffBase">> & { diffBase?: string }
  retry: { threshold: number }
  healerGate: { threshold: number; command?: string }
  snapshotPruning: Required<NonNullable<PlaywrightJevConfig["snapshotPruning"]>>
  stepVerification: Required<NonNullable<PlaywrightJevConfig["stepVerification"]>>
  locatorHealing: Required<NonNullable<PlaywrightJevConfig["locatorHealing"]>>
  assertions: Required<NonNullable<PlaywrightJevConfig["assertions"]>>
  impact: Required<NonNullable<PlaywrightJevConfig["impact"]>>
}

export function defineConfig(config: PlaywrightJevConfig): PlaywrightJevConfig {
  return config
}

const configNames = [
  "playwright-jev.config.ts",
  "playwright-jev.config.mjs",
  "playwright-jev.config.js",
  "playwright-jev.config.json",
]

export type LoadedConfig = { config: PlaywrightJevConfig /** Directory relative paths resolve against. */; dir: string }

/**
 * Load `playwright-jev.config.{ts,mjs,js,json}` from `cwd`, or the file named by PLAYWRIGHT_JEV_CONFIG.
 * Relative paths inside the file resolve against the file's directory.
 */
export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const explicit = process.env.PLAYWRIGHT_JEV_CONFIG
  const file = explicit
    ? path.resolve(cwd, explicit)
    : configNames.map((name) => path.join(cwd, name)).find((candidate) => existsSync(candidate))
  if (!file) return { config: {}, dir: cwd }
  const dir = path.dirname(file)
  if (file.endsWith(".json")) return { config: JSON.parse(readFileSync(file, "utf8")) as PlaywrightJevConfig, dir }
  const loaded = (await import(pathToFileURL(file).href)) as { default?: PlaywrightJevConfig }
  return { config: loaded.default ?? {}, dir }
}

/** Merge config with defaults and environment overrides, and build the provider stack. */
export async function resolveConfig(config: PlaywrightJevConfig = {}, cwd = process.cwd()): Promise<ResolvedConfig> {
  const outputDir = path.resolve(cwd, config.outputDir ?? ".playwright-jev")
  const base = await createProvider(applyEnv(config.provider ?? { type: "openrouter" }), cwd)
  const limited = limitConcurrency(base, config.concurrency ?? 4)
  const cacheMode = config.cache?.mode ?? "read-write"
  const provider =
    cacheMode === "off"
      ? limited
      : cachedProvider(limited, path.resolve(cwd, config.cache?.dir ?? path.join(outputDir, "cache")), cacheMode)

  return {
    provider,
    outputDir,
    triage: {
      enabled: config.triage?.enabled ?? true,
      categories: config.triage?.categories ?? defaultCategories,
      transient: config.triage?.transient ?? ["timing", "environment"],
      healable: config.triage?.healable ?? ["locator_drift", "timing", "assertion_outdated"],
      instructions:
        config.triage?.instructions ?? "What is the most likely root cause of this Playwright end-to-end test failure?",
      snapshotChars: config.triage?.snapshotChars ?? 12_000,
      diffBase: config.triage?.diffBase,
    },
    retry: { threshold: config.retry?.threshold ?? 0.8 },
    healerGate: { threshold: config.healerGate?.threshold ?? 0.7, command: config.healerGate?.command },
    snapshotPruning: {
      enabled: config.snapshotPruning?.enabled ?? true,
      minChars: config.snapshotPruning?.minChars ?? 4_000,
      maxRegionChars: config.snapshotPruning?.maxRegionChars ?? 2_000,
      keepScore: config.snapshotPruning?.keepScore ?? 2,
    },
    stepVerification: {
      enabled: config.stepVerification?.enabled ?? true,
      snapshotChars: config.stepVerification?.snapshotChars ?? 20_000,
    },
    locatorHealing: {
      mode: config.locatorHealing?.mode ?? "report",
      threshold: config.locatorHealing?.threshold ?? 0.55,
      probeTimeoutMs: config.locatorHealing?.probeTimeoutMs ?? 2_000,
      maxCandidates: config.locatorHealing?.maxCandidates ?? 40,
      failInCI: config.locatorHealing?.failInCI ?? false,
    },
    assertions: {
      threshold: config.assertions?.threshold ?? 0.9,
      timeoutMs: config.assertions?.timeoutMs ?? 5_000,
      intervalMs: config.assertions?.intervalMs ?? 1_000,
      snapshotChars: config.assertions?.snapshotChars ?? 20_000,
    },
    impact: {
      base: config.impact?.base ?? "origin/main",
      minScore: config.impact?.minScore ?? 1,
      batchSize: config.impact?.batchSize ?? 20,
    },
  }
}

/** Environment overrides for CI: model, endpoint URL, and key variable. */
function applyEnv(provider: ProviderConfig | DecisionProvider): ProviderConfig | DecisionProvider {
  if ("decide" in provider) return provider
  const { PLAYWRIGHT_JEV_URL: url, PLAYWRIGHT_JEV_MODEL: model, PLAYWRIGHT_JEV_API_KEY_ENV: apiKeyEnv } = process.env
  if (provider.type === "module") return provider
  const overridden = { ...provider, ...(model ? { model } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) }
  if (!url) return overridden
  // A new endpoint never inherits a literal key; it authenticates from a variable instead.
  const { apiKey: _key, ...rest } = overridden
  const keyEnv = rest.apiKeyEnv ?? defaultKeyEnv[provider.type]
  return { ...rest, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}), type: "http", url }
}

const defaultKeyEnv: Partial<Record<ProviderConfig["type"], string>> = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
}

async function createProvider(provider: ProviderConfig | DecisionProvider, cwd: string): Promise<DecisionProvider> {
  if ("decide" in provider) return provider
  switch (provider.type) {
    case "openrouter": {
      const { type: _, ...options } = provider
      return openRouterProvider(options)
    }
    case "typesafe": {
      const { type: _, ...options } = provider
      return typeSafeProvider(options)
    }
    case "http": {
      const { type: _, ...options } = provider
      return httpProvider(options)
    }
    case "module": {
      const specifier = provider.module.startsWith(".")
        ? pathToFileURL(path.resolve(cwd, provider.module)).href
        : provider.module
      const loaded = (await import(specifier)) as Record<string, unknown>
      const exported = loaded[provider.export ?? "default"]
      const instance = typeof exported === "function" ? await exported(provider.options) : exported
      if (!instance || typeof (instance as DecisionProvider).decide !== "function") {
        throw new Error(`${provider.module} does not export a DecisionProvider.`)
      }
      return instance as DecisionProvider
    }
  }
}

export function limitConcurrency(inner: DecisionProvider, limit: number): DecisionProvider {
  let active = 0
  const queue: (() => void)[] = []
  return {
    name: inner.name,
    cacheScope: inner.cacheScope,
    async decide(request, options) {
      // A released slot passes directly to the next waiter, so a new caller cannot take it in between.
      if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
      else active++
      try {
        return await inner.decide(request, options)
      } finally {
        const next = queue.shift()
        if (next) next()
        else active--
      }
    },
  }
}

let shared: Promise<ResolvedConfig> | undefined

/** Load and resolve the project config once per process. */
export function getConfig(): Promise<ResolvedConfig> {
  shared ??= loadConfig().then(({ config, dir }) => resolveConfig(config, dir))
  return shared
}

/** Override the shared config, mainly for tests and programmatic use. */
export function setConfig(config: PlaywrightJevConfig | ResolvedConfig): void {
  shared =
    "provider" in config &&
    config.provider &&
    "decide" in config.provider &&
    "triage" in config &&
    "outputDir" in config
      ? Promise.resolve(config as ResolvedConfig)
      : resolveConfig(config as PlaywrightJevConfig)
}

export function isDisabled(): boolean {
  return process.env.PLAYWRIGHT_JEV_DISABLED === "1"
}
