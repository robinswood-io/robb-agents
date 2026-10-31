/** Parse only JSON objects; malformed fixture input is ignored like the stdio servers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function parseRequest(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}
export function requestedEnvironmentKeys(params: unknown): string[] {
  if (!isRecord(params) || params['name'] !== 'read_env') return []
  const args = params['arguments']
  if (!isRecord(args) || !Array.isArray(args['keys'])) return []
  const keys: unknown[] = args['keys']
  return keys.filter((key): key is string => typeof key === 'string')
}
