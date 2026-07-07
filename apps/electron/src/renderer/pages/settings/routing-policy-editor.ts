import { validateRoutingPolicy, type RoutingPolicy } from '@config/routing-policy'

export interface ParsedRoutingPolicyText {
  policy?: RoutingPolicy
  errors: string[]
  warnings: string[]
}

/**
 * Parse and validate workspace routingPolicy JSON from the settings editor.
 * Empty text deliberately means “clear the policy”.
 */
export function parseRoutingPolicyText(text: string, knownConnectionSlugs: string[]): ParsedRoutingPolicyText {
  const trimmed = text.trim()
  if (!trimmed) {
    return { policy: undefined, errors: [], warnings: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : 'Invalid JSON'],
      warnings: [],
    }
  }

  const validation = validateRoutingPolicy(parsed as RoutingPolicy, knownConnectionSlugs)
  return {
    policy: parsed as RoutingPolicy,
    errors: validation.errors,
    warnings: validation.warnings,
  }
}
