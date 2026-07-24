/**
 * Determine whether an @ at the given position should open the mention menu.
 *
 * Valid triggers:
 * - @ at the start of input
 * - @ preceded by whitespace
 * - @ preceded by opening parenthesis or quote
 *
 * Invalid triggers:
 * - @ in the middle of a word, such as an email address
 * - @ preceded by alphanumeric or unsupported punctuation
 */
export function isValidMentionTrigger(textBeforeCursor: string, atPosition: number): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (charBefore === undefined) return false
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}
