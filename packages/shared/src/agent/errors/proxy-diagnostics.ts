
/**
 * Extract all error messages from an error object, including nested causes.
 */
export function extractErrorMessages(error: unknown): string {
  const messages: string[] = [];

  if (error instanceof Error) {
    messages.push(error.message);

    // Check for nested cause (ES2022 Error.cause)
    if ('cause' in error && error.cause) {
      messages.push(extractErrorMessages(error.cause));
    }

    // Check for stdout/stderr (common in subprocess errors)
    const anyError = error as unknown as Record<string, unknown>;
    if (typeof anyError.stdout === 'string') messages.push(anyError.stdout);
    if (typeof anyError.stderr === 'string') messages.push(anyError.stderr);
    if (typeof anyError.output === 'string') messages.push(anyError.output);
  } else {
    messages.push(String(error));
  }

  return messages.join(' ');
}

const HTML_DOC_HINTS = ['<html', '<!doctype html', '<head', '<body', '<title', '<h1'] as const;

const HTML_PROXY_HINTS = [
  'cloudflare',
  'cf-ray',
  'captcha',
  'security check',
  'access denied',
  'attention required',
  'web application firewall',
  'waf',
  'proxy authentication required',
  'sucuri',
  'imperva',
  'akamai',
] as const;

const HTML_STATUS_PATTERN = /\b(400|401|403|407|408|409|429|500|502|503|504)\b/;

function looksLikeHtmlPayload(textLower: string): boolean {
  if (textLower.includes('<!doctype html') || textLower.includes('<html')) {
    return true;
  }

  let hintCount = 0;
  for (const hint of HTML_DOC_HINTS) {
    if (textLower.includes(hint)) hintCount++;
  }

  return hintCount >= 3;
}

function hasHtmlErrorPageSignals(textLower: string): boolean {
  const hasKnownHttpTitle =
    textLower.includes('bad request') ||
    textLower.includes('unauthorized') ||
    textLower.includes('forbidden') ||
    textLower.includes('service unavailable') ||
    textLower.includes('bad gateway') ||
    textLower.includes('gateway timeout') ||
    textLower.includes('proxy authentication required');

  return HTML_STATUS_PATTERN.test(textLower) && hasKnownHttpTitle;
}

export function isLikelyProxyInterception(textLower: string): boolean {
  if (textLower.includes('unexpected html error page') || textLower.includes('network proxy')) {
    return true;
  }

  if (!looksLikeHtmlPayload(textLower)) {
    return false;
  }

  if (HTML_PROXY_HINTS.some((hint) => textLower.includes(hint))) {
    return true;
  }

  return hasHtmlErrorPageSignals(textLower);
}

export function buildProxyErrorMessage(errorMessage: string, fullErrorText: string): string {
  const lowerErrorMessage = errorMessage.toLowerCase();
  if (!looksLikeHtmlPayload(lowerErrorMessage)) {
    // Interceptor-produced proxy messages are already user-safe and actionable.
    return errorMessage;
  }

  const details: string[] = [];
  const statusMatch = fullErrorText.match(HTML_STATUS_PATTERN);
  if (statusMatch?.[1]) {
    details.push(`HTTP ${statusMatch[1]}`);
  }
  if (fullErrorText.toLowerCase().includes('cloudflare')) {
    details.push('Cloudflare');
  }

  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Received an unexpected HTML error page${suffix} instead of a JSON API response. This is usually caused by a proxy, firewall, or captive portal intercepting the request. Check your proxy settings in Settings > Network.`;
}

export function hasRuntimeBridgeErrorContext(lowerMessage: string): boolean {
  if (
    lowerMessage.includes('execution bridge') ||
    lowerMessage.includes('runtime bridge') ||
    lowerMessage.includes('tool bridge') ||
    lowerMessage.includes('tools context') ||
    lowerMessage.includes('tool context') ||
    lowerMessage.includes('bridge is corrupted') ||
    lowerMessage.includes('bridge corrupted') ||
    lowerMessage.includes('command bridge') ||
    lowerMessage.includes('exec bridge') ||
    lowerMessage.includes('codex bridge') ||
    lowerMessage.includes('localhost:3201') ||
    lowerMessage.includes('localhost 3201') ||
    lowerMessage.includes('fix-errors') ||
    lowerMessage.includes('local agent') ||
    lowerMessage.includes('agent task') ||
    lowerMessage.includes('exec_command')
  ) {
    return true;
  }

  return (
    (lowerMessage.includes('econnrefused') || lowerMessage.includes('connection refused')) &&
    lowerMessage.includes('3201')
  );
}
