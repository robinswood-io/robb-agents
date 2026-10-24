import { MAX_SUMMARIZATION_INPUT } from './token-budget.ts';

// ============================================================
// Summarization Prompt Builder
// ============================================================

export interface SummarizationContext {
  /** Tool or API name */
  toolName: string;
  /** Optional endpoint/path for API calls */
  path?: string;
  /** Tool input parameters */
  input?: Record<string, unknown>;
  /** The model's stated intent before calling the tool */
  intent?: string;
  /** The user's original request (fallback context) */
  userRequest?: string;
}

/**
 * Build the prompt for summarizing a large tool result.
 * Pure function — no SDK calls.
 *
 * @param text - The large response text
 * @param context - Context about the tool call
 * @returns Prompt string ready for agent.getSummarizeCallback()
 */
export function buildSummarizationPrompt(text: string, context: SummarizationContext): string {
  // Safely stringify input
  let inputContext = 'No specific parameters provided.';
  if (context.input) {
    try {
      inputContext = `Request parameters: ${JSON.stringify(context.input)}`;
    } catch {
      inputContext = 'Request parameters: [non-serializable input]';
    }
  }

  const endpointContext = context.path ? `Endpoint: ${context.path}` : '';

  // Prefer model's stated intent, fall back to user request
  const intentContext = context.intent
    ? `The AI assistant's goal: "${context.intent.slice(0, 500)}"`
    : context.userRequest
      ? `User's original request: "${context.userRequest.slice(0, 300)}"`
      : '';

  // Truncate response to fit within summarization limits
  const maxChars = MAX_SUMMARIZATION_INPUT * 4; // ~400KB
  const truncated = text.length > maxChars;
  const responseText = truncated
    ? text.substring(0, maxChars) + '\n\n[... truncated for summarization ...]'
    : text;

  return `You are summarizing a tool result that was too large to fit in context.

Tool: ${context.toolName}
${endpointContext}
${inputContext}
${intentContext ? `\n${intentContext}` : ''}
${truncated ? '\nNote: The response was truncated before summarization due to extreme size.' : ''}

Your task:
1. Extract the MOST RELEVANT information based on the stated goal or request above
2. Preserve key data points, IDs, URLs, and actionable information that relate to the goal
3. Summarize long text content but keep essential details needed to complete the task
4. Format the output cleanly for the AI assistant to use

Tool result to summarize:
${responseText}

Provide a concise but comprehensive summary that captures the essential information needed to accomplish the stated goal.`;
}

// ============================================================
// Result Message Formatting
// ============================================================

export interface FormatOptions {
  estimatedTokens: number;
  /** Relative path from session dir (for transform_data reference) */
  relativePath: string;
  /** Absolute path (for Read/Grep reference) */
  absolutePath: string;
  /** Summary from the selected session model (if available) */
  summary?: string;
  /** Fallback preview when no summary (first N chars of response) */
  preview?: string;
  /** Deterministic bounded scalars retained from an exact top-level JSON result. */
  resultMetadataJson?: string;
  /** Digest of the complete persisted response, used to authenticate re-reads. */
  fullDataSha256: string;
}

const LARGE_RESULT_METADATA_KEYS = new Set([
  'code', 'exitCode', 'ok', 'success', 'status', 'resultCount',
]);

/** Preserve only small deterministic transport/business scalars. The full
 * result stays on disk; arbitrary nested fields and stdout/stderr never return
 * to model context through this metadata channel. */
export function extractLargeResultMetadataJson(
  text: string,
  context?: Pick<SummarizationContext, 'toolName' | 'input'>,
): string | undefined {
  if (!text || text.length > 2_000_000) return undefined;
  try {
    let jsonText = text;
    const normalizedToolName = context?.toolName.startsWith('functions.')
      ? context.toolName.slice('functions.'.length)
      : context?.toolName;
    if (/^(?:WebFetch|web_fetch)$/i.test(normalizedToolName ?? '')) {
      const wrapped = /^JSON from https?:\/\/[^\r\n]+:\r?\n\r?\n([\s\S]+)$/.exec(text.replace(/\r?\n$/, ''));
      if (!wrapped) return undefined;
      jsonText = wrapped[1]!;
    }
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const metadata: Record<string, string | number | boolean> = {};
    for (const key of LARGE_RESULT_METADATA_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(parsed, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const value = descriptor.value;
      if ((key === 'code' || key === 'exitCode')
        && typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 1_000_000) {
        metadata[key] = value;
      } else if ((key === 'ok' || key === 'success') && typeof value === 'boolean') {
        metadata[key] = value;
      } else if (key === 'resultCount'
        && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000) {
        metadata[key] = value;
      } else if (key === 'status' && ((typeof value === 'number' && Number.isInteger(value)
        && value >= 0 && value <= 999) || (typeof value === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)))) {
        metadata[key] = value;
      }
    }
    if (!Object.keys(metadata).length) return undefined;
    const serialized = JSON.stringify(metadata);
    return serialized.length <= 512 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format the message the model sees for a large response.
 * Includes file references for both Read/Grep and transform_data access.
 */
export function formatLargeResponseMessage(opts: FormatOptions): string {
  const { estimatedTokens, relativePath, absolutePath, summary, preview, resultMetadataJson, fullDataSha256 } = opts;

  const fileRef = [
    `Full data saved to: ${absolutePath}`,
    `- Use Read/Grep to access specific content`,
    `- Use transform_data with inputFiles: ["${relativePath}"] for data analysis`,
  ].join('\n');
  const metadata = resultMetadataJson ? `\n\nResult metadata JSON: ${resultMetadataJson}` : '';
  const authenticatedFileRef = `${metadata}\n\nFull data SHA256: ${fullDataSha256}\n\n${fileRef}`;

  if (summary) {
    return `[Large response (~${estimatedTokens} tokens) summarized]${authenticatedFileRef}\n\n${summary}`;
  }

  if (preview) {
    return `[Response too large (~${estimatedTokens} tokens)]${authenticatedFileRef}\n\nPreview:\n${preview}...`;
  }

  return `[Response too large (~${estimatedTokens} tokens)]${authenticatedFileRef}`;
}
