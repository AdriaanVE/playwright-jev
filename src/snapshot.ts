/** Helpers for Playwright aria snapshots (`page.ariaSnapshot({ mode: "ai" })` and MCP snapshot YAML). */

export type SnapshotNode = {
  line: string
  indent: number
  role: string
  name: string
  ref?: string
  /** Landmark and container context, outermost first. */
  ancestors: string[]
}

const nodePattern = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/

export function parseSnapshot(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = []
  const stack: { indent: number; label: string }[] = []
  for (const line of snapshot.split("\n")) {
    const match = nodePattern.exec(line)
    if (!match) continue
    const [, spaces = "", role = "", rawName, rest = ""] = match
    const indent = spaces.length
    while (stack.length && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop()
    const name = rawName?.replace(/\\"/g, '"') ?? inlineText(rest)
    const ref = /\[ref=(e\d+|f\d+e\d+)\]/.exec(rest)?.[1]
    nodes.push({ line: line.trim(), indent, role, name, ref, ancestors: stack.map((item) => item.label) })
    if (containerRoles.has(role) || (role !== "generic" && name)) stack.push({ indent, label: label(role, name) })
  }
  return nodes
}

const containerRoles = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "dialog",
  "alertdialog",
  "list",
  "table",
  "row",
  "menu",
  "tablist",
  "tabpanel",
  "group",
  "article",
  "listitem",
])

export const interactiveRoles = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "listbox",
  "treeitem",
])

export const fillableRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"])

function inlineText(rest: string): string {
  const text = /:\s+(.+)$/.exec(rest)?.[1]
  return text && !text.startsWith("/") ? text.trim().replace(/^"|"$/g, "") : ""
}

function label(role: string, name: string): string {
  return name ? `${role} "${truncate(name, 40)}"` : role
}

export function describeNode(node: SnapshotNode): string {
  const own = node.name ? `${node.role} "${truncate(node.name, 80)}"` : node.role
  const context = node.ancestors.filter((item) => item !== "generic").slice(-3)
  return context.length ? `${own} in ${context.join(" > ")}` : own
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 14))}… [truncated]`
}

/** Keep the head and tail of long text so both the page header and the end of the content survive. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 30) / 2)
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} chars omitted] …\n${text.slice(-half)}`
}

export type SnapshotRegion = {
  id: string
  header: string
  text: string
  refs: string[]
  /** A container line kept to preserve tree shape; its children are separate regions. */
  structural: boolean
}

/**
 * Split snapshot YAML into regions. A subtree larger than `maxChars` is split into its children, and
 * consecutive small siblings are packed together up to `maxChars`, so every region is worth scoring.
 */
export function splitRegions(snapshot: string, maxChars: number, maxRegions = 60): SnapshotRegion[] {
  const lines = snapshot.split("\n").filter((line) => line.trim())
  const blocks: { lines: string[]; structural: boolean }[] = []
  const size = (block: string[]) => block.reduce((sum, line) => sum + line.length + 1, 0)

  function split(block: string[]): void {
    if (size(block) <= maxChars || block.length < 2 || blocks.length >= maxRegions) {
      blocks.push({ lines: block, structural: false })
      return
    }
    const [head = "", ...children] = block
    const childIndent = Math.min(...children.map(indentOf))
    const groups: string[][] = []
    for (const line of children) {
      if (indentOf(line) === childIndent && line.trimStart().startsWith("- ")) groups.push([line])
      else if (groups.length) groups.at(-1)?.push(line)
      else groups.push([line])
    }
    blocks.push({ lines: [head], structural: true })
    let packed: string[] = []
    for (const group of groups) {
      if (size(group) > maxChars) {
        if (packed.length) blocks.push({ lines: packed, structural: false })
        packed = []
        split(group)
      } else if (size(packed) + size(group) > maxChars) {
        blocks.push({ lines: packed, structural: false })
        packed = [...group]
      } else {
        packed.push(...group)
      }
    }
    if (packed.length) blocks.push({ lines: packed, structural: false })
  }

  split(lines)
  return blocks.map((block, index) => {
    const text = block.lines.join("\n")
    return {
      id: `r${index}`,
      header: block.lines[0]?.trim() ?? "",
      text,
      refs: [...text.matchAll(/\[ref=([a-z0-9]+)\]/g)].map((match) => match[1] ?? ""),
      structural: block.structural,
    }
  })
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Tokens for rough lexical overlap ranking. */
export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1),
  )
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const token of a) if (b.has(token)) count++
  return count
}

export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}
