
function normalizeToolCommandName(toolName?: string): string {
  const raw = toolName || 'tool'
  if (raw.startsWith('mcp__session__')) return raw.slice('mcp__session__'.length)
  if (raw.startsWith('mcp__workspace__')) return raw.slice('mcp__workspace__'.length)
  return raw
}

function formatCliValue(value: unknown): string {
  if (typeof value === 'string') {
    const needsQuoting = /\s|"|\\/.test(value)
    if (!needsQuoting) return value
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return JSON.stringify(value)
}

/** Build a deterministic, Bash-like command preview from tool name + input. */
export function formatToolCommandPreview(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolName) return undefined
  const normalized = normalizeToolCommandName(toolName)

  if (!input || Object.keys(input).length === 0) {
    return normalized
  }

  // Wrapper commands pass through the raw CLI input for best fidelity.
  if (normalized === 'browser_tool' && typeof input["command"] === 'string' && input["command"].trim()) {
    return input["command"].trim()
  }

  const entries = Object.entries(input)
    .filter(([key, value]) => key !== '_intent' && key !== '_displayName' && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))

  const flags = entries.map(([key, value]) => {
    if (typeof value === 'boolean') return value ? `--${key}` : `--${key} false`
    return `--${key} ${formatCliValue(value)}`
  })

  return flags.length > 0 ? `${normalized} ${flags.join(' ')}` : normalized
}
