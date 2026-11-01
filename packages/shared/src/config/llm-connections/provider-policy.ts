import type { LlmConnection, LlmProviderType, MidStreamBehavior } from './connection-types.ts';

/**
 * Check if a provider type is a "compat" provider.
 * Compat providers use custom endpoints and require explicit model lists.
 * @param providerType - Provider type to check
 * @returns true if this is a compat provider (pi_compat)
 */
export function isCompatProvider(providerType: LlmProviderType): providerType is 'pi_compat' {
  return providerType === 'pi_compat';
}

/**
 * Check if a provider type uses the Anthropic Claude Agent SDK.
 * Only direct Anthropic API connections use the Claude SDK.
 * @param providerType - Provider type to check
 * @returns true if this provider uses the Anthropic SDK
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic';
}

/**
 * Check if a connection points to a local model runtime (loopback URL).
 */
export function isLocalConnection(conn: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!conn.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(conn.baseUrl.trim()).hostname;
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Check if a provider type uses Pi unified API.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Pi
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * Default mid-stream send behavior for a given provider type.
 *
 * - 'anthropic' → 'queue': Claude has no acknowledged native mid-turn steer.
 *   Queue preserves the complete payload and the current turn by default.
 *   An explicit 'steer' setting aborts the old turn before host FIFO replay.
 * - 'pi' / 'pi_compat' → 'steer': Pi's native `.steer()` is non-destructive
 *   (delivers after the current tool finishes, keeps full context). A failed
 *   subprocess write falls back to abort plus durable host replay.
 */
export function defaultMidStreamBehavior(providerType: LlmProviderType): MidStreamBehavior {
  return providerType === 'anthropic' ? 'queue' : 'steer';
}

/**
 * Read the effective mid-stream behavior for a connection.
 *
 * Single source of truth — every call site that needs to decide steer-vs-queue
 * should go through here so legacy connections (created before the field
 * existed) and connections with corrupt/unexpected values fall through to the
 * provider-appropriate default.
 */
export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  if (connection.midStreamBehavior === 'steer' || connection.midStreamBehavior === 'queue') {
    return connection.midStreamBehavior;
  }
  return defaultMidStreamBehavior(connection.providerType);
}
