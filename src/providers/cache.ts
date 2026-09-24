import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { DecisionProvider, DecisionResponse } from "../types.js"

export type CacheMode = "read-write" | "read-only"

/**
 * File-backed decision cache. Identical state and questions return the stored answer, which keeps reruns
 * deterministic and free. Commit the directory to pin decisions that affect test outcomes.
 */
export function cachedProvider(inner: DecisionProvider, dir: string, mode: CacheMode = "read-write"): DecisionProvider {
  return {
    name: inner.name,
    cacheScope: inner.cacheScope,
    async decide(request, options) {
      const key = cacheKey(inner.name, inner.cacheScope, request.state, request.questions)
      const file = path.join(dir, key.slice(0, 2), `${key}.json`)
      try {
        const stored = JSON.parse(readFileSync(file, "utf8")) as DecisionResponse
        return { ...stored, cached: true }
      } catch {
        // Cache miss.
      }
      const response = await inner.decide(request, options)
      if (mode === "read-write") {
        mkdirSync(path.dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify(response, null, 2))
        renameSync(temp, file)
      }
      return response
    },
  }
}

export function cacheKey(...parts: unknown[]): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex")
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
