/**
 * Auto-Label Rule Validation
 *
 * Validates auto-label rule patterns at config-save time to catch
 * invalid regex syntax and catastrophic backtracking patterns early.
 *
 * Called from the label config validator (validators.ts) when labels/config.json
 * is being written.
 */

export interface AutoLabelValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Known catastrophic backtracking patterns (nested quantifiers).
 * These can cause ReDoS (Regular Expression Denial of Service) by making
 * the regex engine take exponential time on non-matching inputs.
 *
 * Matches patterns like: (a+)+, (a*)+, (\w+)*, ([a-z]+)+
 */
function containsNestedQuantifier(pattern: string): boolean {
  const groupQuantifiers: boolean[] = []
  let inCharacterClass = false
  let escaped = false

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (inCharacterClass) continue

    if (character === '(') {
      groupQuantifiers.push(false)
      continue
    }
    if ((character === '+' || character === '*' || character === '{') && groupQuantifiers.length > 0) {
      groupQuantifiers[groupQuantifiers.length - 1] = true
      continue
    }
    if (character !== ')' || groupQuantifiers.length === 0) continue

    const containsQuantifier = groupQuantifiers.pop() ?? false
    if (containsQuantifier && ['+', '*', '{'].includes(pattern[index + 1] ?? '')) return true
  }

  return false
}

function hasCapturingGroup(pattern: string): boolean {
  let inCharacterClass = false
  let escaped = false

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (inCharacterClass || character !== '(') continue

    if (pattern[index + 1] !== '?') return true
    if (pattern[index + 2] === '<' && !['=', '!'].includes(pattern[index + 3] ?? '')) return true
  }

  return false
}

/**
 * Validate a single auto-label rule.
 * Checks regex syntax, flags, and known problematic patterns.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional flags (defaults to 'gi')
 * @returns Validation result with errors/warnings
 */
export function validateAutoLabelRule(pattern: string, flags?: string): AutoLabelValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Check regex compiles without errors
  try {
    const effectiveFlags = flags
      ? (flags.includes('g') ? flags : flags + 'g')
      : 'gi'
    new RegExp(pattern, effectiveFlags)
  } catch (e) {
    errors.push(`Invalid regex pattern: ${e instanceof Error ? e.message : 'Unknown error'}`)
    return { valid: false, errors, warnings }
  }

  // 2. Check for catastrophic backtracking patterns (nested quantifiers)
  if (containsNestedQuantifier(pattern)) {
    errors.push(
      `Pattern contains nested quantifiers which can cause catastrophic backtracking (ReDoS). ` +
      `Simplify the pattern to avoid nested repetition like (a+)+.`
    )
  }

  // 3. Warn about missing capture groups when no valueTemplate could use $1
  if (!hasCapturingGroup(pattern)) {
    warnings.push(
      'Pattern has no capture groups. The entire match will be used as the label value. ' +
      'Add capture groups (parentheses) to extract specific parts.'
    )
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
