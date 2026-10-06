export function normalizeRecoveryValidationGapsForProgress(
  validationGaps: readonly string[],
): string[] {
  const normalized = validationGaps.map(gap => gap.trim()
    .replace(/\b(messageId|toolUseId|callId|requestId|dispatchId|attemptId)\s*([:=])\s*["']?(?:[a-z0-9][a-z0-9._:-]{7,})["']?/gi, '$1$2<volatile>')
    .replace(/\b(?:msg-[0-9]{10,}-[a-f0-9]{6,}|call_[a-z0-9_-]{8,}|toolu_[a-z0-9_-]{8,})\b/gi, '<volatile-id>')
    .replace(/\battempt\s+#?\d+\b/gi, 'attempt <volatile>')
    .replace(/\bat\s+\d{13}\b/gi, 'at <volatile>'))
    .filter(Boolean)
  return [...new Set(normalized)].sort()
}
