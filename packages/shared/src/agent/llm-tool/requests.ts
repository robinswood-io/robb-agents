import { MODEL_REGISTRY } from "../../config/models.ts";
import { processAttachment } from './attachments.ts';
import type { LLMQueryRequest, ToolResult } from './contracts.ts';
import { OUTPUT_FORMATS } from './formats.ts';

// ============================================================================
// SHARED PRE-EXECUTION PIPELINE (used by Codex/Copilot PreToolUse intercepts)
// Validates input, processes attachments, resolves schema, builds LLMQueryRequest
// ============================================================================

export interface BuildCallLlmOptions {
  /** Backend name for error messages (e.g., "Codex", "Copilot") */
  backendName: string;
  /** Optional model validation hook — return undefined to reject, or a validated model ID */
  validateModel?: ((resolvedModelId: string) => string | undefined) | undefined;
  /** Session directory for resolving relative attachment paths */
  sessionPath?: string;
}

/**
 * Shared pre-execution pipeline for call_llm PreToolUse intercepts.
 * Validates input, processes attachments, resolves schema, and builds an LLMQueryRequest
 * ready to be passed to the backend's queryLlm().
 *
 * Used by PiAgent's call_llm intercept path.
 */
export async function buildCallLlmRequest(
  input: Record<string, unknown>,
  options: BuildCallLlmOptions
): Promise<LLMQueryRequest> {
  const prompt = input["prompt"] as string;
  if (!prompt?.trim()) {
    throw new Error('Prompt is required and cannot be empty.');
  }

  // Process attachments
  const textParts: string[] = [];
  const attachments = input["attachments"] as Array<string | { path: string; startLine?: number; endLine?: number }> | undefined;

  if (attachments?.length) {
    for (let i = 0; i < attachments.length; i++) {
      const result = await processAttachment(attachments[i]!, i, options.sessionPath);
      if (result.type === 'error') {
        throw new Error(result.message);
      }
      if (result.type === 'image') {
        throw new Error(
          `Attachment ${i + 1}: Image attachments are not supported in ${options.backendName} mode. Use text files only.`
        );
      }
      if (result.type === 'text') {
        textParts.push(`<file path="${result.filename}">\n${result.content}\n</file>`);
      }
    }
  }

  textParts.push(prompt);

  // Resolve model against registry, with optional backend-specific validation
  let model = input["model"] as string | undefined;
  if (model) {
    const modelDef = MODEL_REGISTRY.find(m => m.id === model)
      || MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === model!.toLowerCase())
      || MODEL_REGISTRY.find(m => m.name.toLowerCase() === model!.toLowerCase());
    if (modelDef) {
      model = modelDef.id;
    }

    // Backend-specific model validation (e.g., Codex rejects non-OpenAI models)
    if (options.validateModel) {
      const validated = options.validateModel(model);
      if (!validated) throw new Error(`Model "${model}" is not supported by ${options.backendName}.`);
      model = validated;
    }
  }

  // Build system prompt with structured output injection if needed
  let systemPrompt = (input["systemPrompt"] as string) || '';
  const outputFormat = input["outputFormat"] as string | undefined;
  const outputSchema = input["outputSchema"] as Record<string, unknown> | undefined;

  let schema: Record<string, unknown> | null = null;
  if (outputSchema) {
    schema = outputSchema;
  } else if (outputFormat && OUTPUT_FORMATS[outputFormat as keyof typeof OUTPUT_FORMATS]) {
    schema = OUTPUT_FORMATS[outputFormat as keyof typeof OUTPUT_FORMATS];
  }

  if (schema) {
    const schemaJson = JSON.stringify(schema, null, 2);
    systemPrompt += `${systemPrompt ? '\n\n' : ''}You MUST respond with valid JSON matching this schema:\n${schemaJson}\n\nRespond with ONLY the JSON object, no other text or markdown formatting.`;
  }

  const optionalSystemPrompt = systemPrompt || undefined;
  return {
    prompt: textParts.join('\n\n'),
    ...(optionalSystemPrompt !== undefined ? { systemPrompt: optionalSystemPrompt } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(typeof input["maxTokens"] === "number" ? { maxTokens: input["maxTokens"] } : {}),
    ...(typeof input["temperature"] === "number" ? { temperature: input["temperature"] } : {}),
    ...(schema != null ? { outputSchema: schema } : {}),
  };
}

// ============================================================================
// HELPER: ERROR RESPONSE
// Creates a standardized error response with isError flag
// ============================================================================

export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
