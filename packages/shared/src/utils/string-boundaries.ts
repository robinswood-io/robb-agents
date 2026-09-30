/** Linear suffix trimming for externally supplied text. */
export function trimTrailingCharacters(value: string, characters: string): string {
  let end = value.length
  while (end > 0 && characters.includes(value[end - 1]!)) end--
  return value.slice(0, end)
}

/** A single mailbox shape, without overlapping domain quantifiers. */
export function hasSingleMailboxShape(value: string): boolean {
  if (/\s/.test(value)) return false
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const dot = value.lastIndexOf('.')
  return dot > at + 1 && dot < value.length - 1
}
