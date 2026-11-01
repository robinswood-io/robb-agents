import type { MergedPermissionsConfig } from './contracts.ts';

// ============================================================
// API Endpoint Checking
// ============================================================

/**
 * Check if an API call is allowed by endpoint rules
 */
export function isApiEndpointAllowed(
  method: string,
  path: string,
  config: MergedPermissionsConfig
): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules
  for (const rule of config.allowedApiEndpoints) {
    if (rule.method === upperMethod && rule.pathPattern.test(path)) {
      return true;
    }
  }

  return false;
}
