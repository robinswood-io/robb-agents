import { toolMetadataStore } from "../../interceptor-common.ts";
import type { ToolUseBlock } from './transcript.ts';
import { log } from './transcript.ts';

// ============================================================================
// Helpers (pure)
// ============================================================================

/**
 * Extract intent and displayName metadata for a tool call.
 *
 * Sources (checked in priority order):
 * 1. toolMetadataStore — populated by the SSE stripping stream in unified-network-interceptor.ts
 * 2. toolBlock.input._intent / _displayName — fallback for Codex backend or if SSE interception didn't run
 * 3. Bash description field — fallback for intent on Bash tools
 */
export function extractToolMetadata(toolBlock: ToolUseBlock, sessionDir?: string): { intent?: string; displayName?: string } {
  // 1. Check the metadata store first (populated by SSE interceptor)
  // Pass sessionDir to ensure we read from the correct session's file even when
  // the singleton _sessionDir has been clobbered by a concurrent session.
  const idCandidates = new Set<string>([toolBlock.id]);
  if (toolBlock.id.includes('|')) {
    const [base] = toolBlock.id.split('|');
    if (base) idCandidates.add(base);
  }

  for (const candidate of idCandidates) {
    const stored = toolMetadataStore.get(candidate, sessionDir);
    if (!stored) continue;

    let intent = stored.intent;
    const displayName = stored.displayName;

    // Bash description fallback for intent
    if (!intent && toolBlock.name === 'Bash') {
      intent = (toolBlock.input as { description?: string }).description;
    }

    return { intent, displayName };
  }

  // Log when metadata store misses — helps diagnose cross-process sync issues
  const argsHasIntent = typeof toolBlock.input._intent === 'string';
  const argsHasDisplayName = typeof toolBlock.input._displayName === 'string';
  log.debug(
    `extractToolMetadata: store miss for ${toolBlock.name} (${toolBlock.id}); candidates=${Array.from(idCandidates).join(' -> ')}; argsIntent=${argsHasIntent}; argsDisplayName=${argsHasDisplayName}`,
  );

  // 2. Fallback: read directly from tool input (Codex backend, non-streaming, etc.)
  let intent = toolBlock.input._intent as string | undefined;
  const displayName = toolBlock.input._displayName as string | undefined;

  // 3. Bash description fallback for intent
  if (!intent && toolBlock.name === 'Bash') {
    intent = (toolBlock.input as { description?: string }).description;
  }

  return { intent, displayName };
}

/** Serialize a tool result value to string, handling circular references */
export function serializeResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Result contains non-serializable data]';
  }
}

/** Check if a tool result indicates an error */
export function isToolResultError(result: unknown): boolean {
  if (typeof result === 'string') {
    // Check for common error patterns
    return /^\s*(?:\[ERROR\]|Error:|error:|❌\s*(?:Download|Upload) error:)/u.test(result);
  }
  if (result && typeof result === 'object') {
    // Check for error flag in result object
    if ('is_error' in result && (result as { is_error: boolean }).is_error) return true;
    if ('error' in result) return true;
  }
  return false;
}
