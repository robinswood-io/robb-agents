import { isUnknownArray } from '../utils/json.ts';
/**
 * Unified fetch interceptor for all AI API requests (Anthropic + OpenAI format).
 *
 * Loaded via --preload (Bun) or --require (Node) into SDK subprocesses.
 * Patches globalThis.fetch before any SDK captures it.
 *
 * Features:
 * - Adds _intent and _displayName metadata to all tool schemas (request)
 * - Re-injects stored metadata into conversation history (request)
 * - Processes SSE response streams per API format:
 *   - Anthropic: STRIPS metadata from stream (SDK validates immediately)
 *   - OpenAI: CAPTURES metadata passthrough (hook strips before execution)
 * - Captures API errors (4xx/5xx) for error handler
 * - Fast mode support for Anthropic (Opus 4.7)
 *
 * Auto-detects API format based on request URL:
 * - Anthropic: baseUrl + /messages
 * - OpenAI: /chat/completions
 */
// Shared infrastructure (toolMetadataStore, error capture, logging, config)
import { debugLog, toolMetadataStore, displayNameSchema, intentSchema } from "../interceptor-common.ts";

// ============================================================================
// API ADAPTER INTERFACE
// ============================================================================

/**
 * Adapter interface for API-format-specific behavior.
 * Each adapter handles the differences between Anthropic and OpenAI API formats.
 */
export interface ApiAdapter {
  name: string;
  shouldIntercept(url: string): boolean;
  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown>;
  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown>;
  createSseProcessor(): TransformStream<Uint8Array, Uint8Array>;
  /** Whether SSE processing strips metadata (Anthropic) or passes through (OpenAI) */
  stripsSseMetadata: boolean;
  /** Optional request modifications (e.g., fast mode headers) */
  modifyRequest?(url: string, init: RequestInit, body: Record<string, unknown>): { init: RequestInit; body: Record<string, unknown> };
  /**
   * Optional pre-flight validation of the outgoing body. Adapters that opt in
   * throw {@link MalformedBodyError} when the body would cause a deterministic
   * upstream 400 (duplicate tool_call_id, missing call_id, etc.). The
   * interceptor turns the throw into a synthetic 400 response so the SDK
   * surfaces a clear error instead of dying on an opaque upstream failure.
   */
  validateOutgoingBody?(body: Record<string, unknown>): void;
}

// ============================================================================
// MALFORMED BODY ERROR
// ============================================================================

/**
 * Thrown by {@link ApiAdapter.validateOutgoingBody} when the request body would
 * be rejected by the upstream API for a structural reason we can detect locally
 * (duplicate `tool_call_id`, missing `call_id`, orphaned tool result, etc.).
 *
 * The interceptor catches this and turns it into a synthetic 400 response with
 * a structured error body that the SDK treats as a normal API error — far more
 * useful than the opaque `400 status code (no body)` users see today.
 */
export class MalformedBodyError extends Error {
  /** Stable error code for telemetry/UX */
  readonly code: 'duplicate_tool_call_id' | 'missing_tool_call_id' | 'missing_call_id' | 'orphaned_function_call_output' | 'empty_tool_name';
  /** Human-readable detail to show in logs and surface to the user */
  readonly detail: string;
  /** Adapter name (for diagnostics) */
  readonly adapter: string;

  constructor(args: {
    code: MalformedBodyError['code'];
    detail: string;
    adapter: string;
  }) {
    super(`[${args.adapter}] Outgoing body rejected: ${args.code} — ${args.detail}`);
    this.name = 'MalformedBodyError';
    this.code = args.code;
    this.detail = args.detail;
    this.adapter = args.adapter;
  }
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Inject _displayName and _intent into a tool's properties object.
 * Shared by both Anthropic and OpenAI adapters (same logic, different schema paths).
 */
function injectMetadataFields(
  properties: Record<string, unknown>,
  required: string[] | undefined,
): { properties: Record<string, unknown>; required: string[] } {
  const { _displayName, _intent, ...rest } = properties as {
    _displayName?: unknown;
    _intent?: unknown;
    [key: string]: unknown;
  };
  const newProperties = {
    _displayName: _displayName || displayNameSchema,
    _intent: _intent || intentSchema,
    ...rest,
  };
  const otherRequired = (required || []).filter(r => r !== '_displayName' && r !== '_intent');
  return { properties: newProperties, required: ['_displayName', '_intent', ...otherRequired] };
}

/**
 * Normalize a tool schema so metadata can always be injected, including zero-arg
 * tools whose schema may be `{ type: "object" }` without a `properties` key.
 *
 * Exported for focused unit tests.
 */
export function injectMetadataIntoToolSchema<T extends {
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}>(
  schema: T,
): T & { properties: Record<string, unknown>; required: string[] } {
  const normalizedProperties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const normalizedRequired = isUnknownArray(schema.required) ? schema.required : [];
  const result = injectMetadataFields(normalizedProperties, normalizedRequired);
  return {
    ...schema,
    properties: result.properties,
    required: result.required,
  };
}

/**
 * Extract _intent/_displayName from a parsed tool input and store in toolMetadataStore.
 * Shared by both SSE processors (Anthropic strips, OpenAI captures).
 *
 * @returns true if metadata was found and stored
 */
export function captureMetadataFromInput(toolId: string, toolName: string, parsed: Record<string, unknown>): boolean {
  const intent = typeof parsed["_intent"] === 'string' ? parsed["_intent"] : undefined;
  const displayName = typeof parsed["_displayName"] === 'string' ? parsed["_displayName"] : undefined;
  if (intent || displayName) {
    toolMetadataStore.set(toolId, { ...(intent !== undefined ? { intent } : {}), ...(displayName !== undefined ? { displayName } : {}), timestamp: Date.now() });
    debugLog(`[SSE] Stored metadata for ${toolName} (${toolId}): intent=${!!intent}, displayName=${!!displayName}`);
    return true;
  }
  return false;
}

/**
 * Best-effort regex removal of metadata fields from raw JSON string.
 * Used as fallback when JSON.parse fails — ensures _intent/_displayName
 * never leak to the SDK even with malformed JSON.
 *
 * Exported for focused unit tests.
 */
export function stripMetadataFieldsFromRawJson(json: string): string {
  return json
    .replace(/"_intent"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*/g, '')
    .replace(/"_displayName"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*/g, '')
    .replace(/,\s*}/g, '}');
}
