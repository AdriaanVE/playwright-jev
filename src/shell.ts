/**
 * Quote one value as a POSIX shell word. Characters that expand inside double quotes are removed as well,
 * so a placeholder stays inert even when a template wraps it in double quotes. Test titles come from
 * contributors, and healer commands often run in CI with secrets.
 */
export function shellWord(value: string): string {
  const safe = value.replace(/[`$\\"\n\r]/g, "")
  return `'${safe.replace(/'/g, "'\\''")}'`
}
