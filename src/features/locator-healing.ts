import type { Locator, Page } from "@playwright/test"
import type { ResolvedConfig } from "../config.js"
import { choice, choiceAnswer, choiceProbability } from "../questions.js"
import { describeNode, fillableRoles, interactiveRoles, overlap, parseSnapshot, tokens } from "../snapshot.js"

/** Test annotation type that carries a JSON-encoded HealEvent. */
export const healAnnotation = "jev-heal"

export type HealEvent = {
  original: string
  action: string
  /** Element the provider picked, or `none`. */
  choice: string
  element?: string
  healedLocator?: string
  probability: number
  /** `healed` acted on the new element; `suggested` only recorded it (report mode); `rejected` fell through. */
  outcome: "healed" | "suggested" | "rejected"
  step?: string
  cached: boolean
}

export type HealContext = {
  config: ResolvedConfig
  step: () => string | undefined
  record: (event: HealEvent) => void
}

/** Locator methods that act on one element and can be retried against a healed target. */
const healableActions = new Set([
  "click",
  "dblclick",
  "fill",
  "check",
  "uncheck",
  "setChecked",
  "hover",
  "tap",
  "focus",
  "press",
  "pressSequentially",
  "selectOption",
  "selectText",
  "clear",
  "scrollIntoViewIfNeeded",
])

/** Methods that return another Locator and must stay wrapped. */
const chainMethods = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "first",
  "last",
  "nth",
  "filter",
  "and",
  "or",
])

const wrapped = new WeakSet<object>()

/** Wrap a page so locators it creates heal on action timeouts. The returned page is a transparent proxy. */
export function healingPage(page: Page, context: HealContext): Page {
  if (context.config.locatorHealing.mode === "off") return page
  return new Proxy(page, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof property === "string" && chainMethods.has(property) && typeof value === "function") {
        return (...args: unknown[]) => wrapLocator(value.apply(target, args) as Locator, target, context)
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function wrapLocator(locator: Locator, page: Page, context: HealContext): Locator {
  if (wrapped.has(locator)) return locator
  const proxy = new Proxy(locator, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof property !== "string" || typeof value !== "function") return value
      if (chainMethods.has(property)) {
        return (...args: unknown[]) => wrapLocator(value.apply(target, args) as Locator, page, context)
      }
      if (healableActions.has(property)) {
        return (...args: unknown[]) => healAction(target, page, property, args, context)
      }
      return value.bind(target)
    },
  })
  wrapped.add(proxy)
  return proxy
}

async function healAction(
  locator: Locator,
  page: Page,
  action: string,
  args: unknown[],
  context: HealContext,
): Promise<unknown> {
  // Call as a method so Playwright reports the real API name (for example `locator.click`) in errors.
  const call = (target: Locator, callArgs: unknown[]) =>
    (target as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[action]?.(...callArgs)

  // Probe within the caller's own budget. Only locators that resolve to nothing are candidates for healing;
  // strict-mode violations and actionability failures keep Playwright's normal behavior.
  const settings = context.config.locatorHealing
  const callerTimeout = actionTimeout(args)
  const probeTimeout =
    callerTimeout === undefined ? settings.probeTimeoutMs : Math.min(settings.probeTimeoutMs, callerTimeout)
  const started = Date.now()
  const found = await locator
    .first()
    .waitFor({ state: "attached", timeout: probeTimeout })
    .then(() => true)
    .catch(() => false)
  if (found) return call(locator, args)

  let healed: Locator | undefined
  try {
    healed = await findReplacement(locator, page, action, context)
  } catch {
    healed = undefined
  }
  if (healed) return call(healed, args)
  // Still missing: fail with Playwright's own error, using what is left of an explicit timeout. A late
  // element can still appear during this wait, which keeps slow pages working.
  const remaining = callerTimeout === undefined ? undefined : Math.max(1, callerTimeout - (Date.now() - started))
  return call(locator, remaining === undefined ? args : withTimeout(args, remaining))
}

/** Playwright action methods take their options object last; `press` and `fill` take a value first. */
function actionTimeout(args: unknown[]): number | undefined {
  const last = args.at(-1)
  if (last && typeof last === "object" && "timeout" in last && typeof last.timeout === "number" && last.timeout > 0) {
    return last.timeout
  }
  return undefined
}

function withTimeout(args: unknown[], timeout: number): unknown[] {
  const last = args.at(-1)
  return [...args.slice(0, -1), { ...(last as object), timeout }]
}

async function findReplacement(
  locator: Locator,
  page: Page,
  action: string,
  context: HealContext,
): Promise<Locator | undefined> {
  const { config } = context
  const settings = config.locatorHealing
  const original = locator.toString()
  // Look inside the container of a chained locator, for example `getByRole('main').getByLabel(...)`.
  const container = containerOf(locator, page)
  const snapshot = await container.ariaSnapshot({ mode: "ai", timeout: settings.probeTimeoutMs })
  const candidates = rankCandidates(snapshot, original, action, settings.maxCandidates)
  if (candidates.length === 0) return undefined

  const options: Record<string, string> = Object.fromEntries(candidates.map((node) => [node.ref, describeNode(node)]))
  options.none = "No candidate has the same purpose; the control was removed."
  const step = context.step()
  const response = await config.provider.decide({
    state: {
      action,
      original_locator: original,
      intended_element: describeIntent(original),
      test_step: step,
      // Path only: query strings and fragments can carry session or magic-link tokens.
      page_path: safePath(page.url()),
      context:
        "The original locator matches no element. UI copy and labels change often between releases. Small wording changes, added words, and role changes of the same control are expected.",
    },
    questions: {
      target: choice("Which current element is the renamed or restructured version of the intended element?", options),
    },
    metadata: { feature: "locator-healing" },
  })
  const answer = choiceAnswer(response, "target")
  const probability = choiceProbability(answer)
  const picked = candidates.find((node) => node.ref === answer.choice)
  const accepted = picked !== undefined && probability >= settings.threshold
  const base = { original, action, choice: answer.choice, probability, step, cached: response.cached ?? false }

  if (!accepted || !picked?.ref) {
    context.record({ ...base, element: picked ? describeNode(picked) : undefined, outcome: "rejected" })
    return undefined
  }
  const target = page.locator(`aria-ref=${picked.ref}`)
  const healedLocator = suggestLocator(picked.role, picked.name)
  const outcome = settings.mode === "enforce" ? "healed" : "suggested"
  context.record({ ...base, element: describeNode(picked), healedLocator, outcome })
  return outcome === "healed" ? target : undefined
}

/** The locator's parent for a chain, or the whole page. Falls back to the page if the parent is missing. */
function containerOf(locator: Locator, page: Page): Page | Locator {
  const text = locator.toString()
  const segments = text.split(/\.(?=(?:locator|getBy\w+)\()/)
  if (segments.length < 2) return page
  const selector = (locator as unknown as { _selector?: string })._selector
  if (!selector) return page
  // Playwright chains selectors with " >> "; drop the last step to reach the parent.
  const parts = selector.split(" >> ")
  return parts.length > 1 ? page.locator(parts.slice(0, -1).join(" >> ")).first() : page
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ""
  }
}

/** Keep the interactive elements that best match the original locator text, in document order. */
export function rankCandidates(snapshot: string, original: string, action: string, max: number) {
  const wanted = tokens(original.replace(/getBy\w+|locator|exact|name|true|false/g, " "))
  const nodes = parseSnapshot(snapshot).filter(
    (node): node is typeof node & { ref: string } =>
      node.ref !== undefined &&
      interactiveRoles.has(node.role) &&
      (!["fill", "pressSequentially", "clear"].includes(action) || fillableRoles.has(node.role)),
  )
  if (nodes.length <= max) return nodes
  const scored = nodes.map((node, index) => ({ node, index, score: overlap(wanted, tokens(describeNode(node))) }))
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.node)
}

/**
 * Read role, name, label, text, or test id of the target out of a locator description. In a chain such as
 * `getByRole('main').getByLabel('Coupon')`, the last segment is the target and earlier ones are its container.
 */
export function describeIntent(locator: string): Record<string, string> {
  const segments = locator.split(/\.(?=(?:locator|getBy\w+)\()/)
  const target = segments.at(-1) ?? locator
  const intent: Record<string, string> = {}
  if (segments.length > 1) intent.inside = segments.slice(0, -1).join(".")
  const role = /getByRole\('([^']+)'/.exec(target)?.[1]
  if (role) intent.role = role
  for (const [key, pattern] of [
    ["name", /name: '((?:[^'\\]|\\.)*)'/],
    ["label", /getByLabel\('((?:[^'\\]|\\.)*)'/],
    ["text", /getByText\('((?:[^'\\]|\\.)*)'/],
    ["placeholder", /getByPlaceholder\('((?:[^'\\]|\\.)*)'/],
    ["test_id", /getByTestId\('((?:[^'\\]|\\.)*)'/],
  ] as const) {
    const value = pattern.exec(target)?.[1]
    if (value) intent[key] = value
  }
  return intent
}

export function suggestLocator(role: string, name: string): string {
  return name
    ? `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`
    : `getByRole(${JSON.stringify(role)})`
}
