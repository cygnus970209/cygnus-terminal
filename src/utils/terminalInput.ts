/** NBSP looks like a space but Bash does not treat it as an argument separator. */
export function normalizeTerminalInput(data: string): string {
  return data.replace(/\u00a0/g, " ");
}
