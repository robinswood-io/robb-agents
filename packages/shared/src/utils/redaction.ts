const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED]' },
  { pattern: /\b(?:sk|sk-proj|sk-ant|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, replacement: '[REDACTED]' },
  { pattern: /\b(?:Authorization\s*:\s*)?Bearer\s+[A-Za-z0-9._~+/-]{12,}\b/gi, replacement: '[REDACTED]' },
  { pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*["']?[^\s,"'};]+/gi, replacement: '[REDACTED]' },
  { pattern: /\b((?:postgres|postgresql|mysql|mongodb):\/\/)[^@\s]+@/gi, replacement: '$1[REDACTED]@' },
  { pattern: /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)=)[^&#\s]+/gi, replacement: '$1[REDACTED]' },
] as const;

/** Redact credential-shaped material while retaining enough context for audit and diagnostics. */
export function redactSecretLikeMaterial(content: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, rule) => redacted.replace(rule.pattern, rule.replacement),
    content,
  );
}

/** Recursively redact JSON-compatible session/tool data without changing its shape. */
export function redactStructuredSecrets<T>(value: T): T {
  if (typeof value === 'string') return redactSecretLikeMaterial(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactStructuredSecrets(item)) as T;
  if (typeof value === 'object' && value !== null) {
    const redacted = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactStructuredSecrets(nested)]),
    );
    return redacted as T;
  }
  return value;
}
