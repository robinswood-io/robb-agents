/**
 * LLM Tool (call_llm)
 *
 * Session-scoped tool that enables the main agent to invoke secondary LLM calls
 * for specialized subtasks like summarization, classification, extraction, and analysis.
 *
 * Key features:
 * - Attachment-based file loading (agent passes paths, tool loads content)
 * - Line range support for large files
 * - Predefined output formats + custom JSON Schema (native structured output)
 * - Parallel execution support (multiple calls run simultaneously)
 * - Comprehensive validation with actionable error messages
 *
 * All calls are delegated to the agent backend's queryLlm() implementation.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MODEL_REGISTRY } from "../../config/models.ts";
import { MAX_ATTACHMENTS, MAX_TOTAL_CONTENT_BYTES, processAttachment } from './attachments.ts';
import type { LLMQueryRequest, LLMQueryResult } from './contracts.ts';
import { OUTPUT_FORMATS } from './formats.ts';
import { errorResponse } from './requests.ts';

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

const AttachmentSchema = z.union([
  z.string().describe('Simple file path'),
  z.object({
    path: z.string().describe('File path'),
    startLine: z.number().int().min(1).optional().describe('First line to include (1-indexed)'),
    endLine: z.number().int().min(1).optional().describe('Last line to include (1-indexed)'),
  }).describe('File path with optional line range for large files'),
]);

const OutputSchemaParam = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
}).describe('JSON Schema for structured output');

// ============================================================================
// MAIN TOOL FACTORY
// ============================================================================

export interface LLMToolOptions {
  sessionId: string;
  /** Session directory for resolving relative attachment paths */
  sessionPath?: string;
  /**
   * Lazy resolver for the agent-native query callback.
   * Called at execution time to get the current callback from the session registry.
   * Each backend implements queryLlm() with native structured output support.
   */
  getQueryFn: () => ((request: LLMQueryRequest) => Promise<LLMQueryResult>) | undefined;
}

export function createLLMTool(options: LLMToolOptions) {
  // sessionId captured in closure for potential future use (logging, rate limiting per session)
  const { sessionId: _sessionId } = options;

  return tool(
    'call_llm',
    `Invoke a secondary LLM for focused subtasks. Use for:
- Structured output: JSON schema compliance via native backend support
- Parallel processing: call multiple times in one message - all run simultaneously
- Context isolation: process content without polluting main context

This tool uses the current session connection and may inherit the same model.
It can review response content, but cannot supply independent-review evidence;
use a separate reviewer-role session for that contract.

Put text/content directly in the 'prompt' parameter. Do NOT pass inline text via attachments.
Only use 'attachments' for existing file paths on disk - the tool loads file content automatically.
For large files (>2000 lines), use {path, startLine, endLine} to select a portion.`,
    {
      prompt: z.string().min(1, 'Prompt cannot be empty')
        .describe('Instructions for the LLM'),

      attachments: z.array(AttachmentSchema).max(MAX_ATTACHMENTS).optional()
        .describe(`File paths on disk (max ${MAX_ATTACHMENTS}). NOT for inline text — put text in prompt instead. Use {path, startLine, endLine} for large files.`),

      model: z.string().optional()
        .describe('Model ID or short name (e.g., "haiku", "sonnet"). Defaults to the model selected for this session.'),

      systemPrompt: z.string().optional()
        .describe('Optional system prompt'),

      maxTokens: z.number().int().min(1).max(64000).optional()
        .describe('Max output tokens (1-64000). Defaults to 4096'),

      temperature: z.number().min(0).max(1).optional()
        .describe('Sampling temperature 0-1'),

      outputFormat: z.enum(['summary', 'classification', 'extraction', 'analysis', 'comparison', 'validation']).optional()
        .describe('Predefined output format'),

      outputSchema: OutputSchemaParam.optional()
        .describe('Custom JSON Schema for structured output'),
    },
    async (args) => {
      // ========================================
      // VALIDATION PHASE
      // ========================================

      if (!args.prompt?.trim()) {
        return errorResponse('Prompt is required and cannot be empty.');
      }

      if (args.outputFormat && args.outputSchema) {
        return errorResponse(
          'Cannot use both outputFormat and outputSchema.\n\n' +
          'Options:\n' +
          '1. Use outputFormat for predefined schemas (summary, classification, etc.)\n' +
          '2. Use outputSchema for custom JSON Schema'
        );
      }

      // --- Validate and resolve model against registry ---
      if (args.model) {
        let modelDef = MODEL_REGISTRY.find(m => m.id === args.model);
        if (!modelDef) {
          modelDef = MODEL_REGISTRY.find(m => m.shortName.toLowerCase() === args.model!.toLowerCase())
            || MODEL_REGISTRY.find(m => m.name.toLowerCase() === args.model!.toLowerCase());
          if (modelDef) {
            args.model = modelDef.id;
          } else {
            const available = MODEL_REGISTRY.map(m => `  - ${m.id} (${m.shortName})`).join('\n');
            return errorResponse(
              `Unknown model: "${args.model}"\n\n` +
              `Available models:\n${available}`
            );
          }
        }
      }

      // ========================================
      // RESOLVE QUERY FUNCTION
      // ========================================

      const queryFn = options.getQueryFn();

      if (!queryFn) {
        return errorResponse(
          'No authentication configured for call_llm.\n\n' +
          'Sign in with your AI provider to use this tool.'
        );
      }

      // ========================================
      // PROCESS ATTACHMENTS
      // ========================================

      const textParts: string[] = [];
      let totalContentBytes = 0;

      if (args.attachments?.length) {
        for (let i = 0; i < args.attachments.length; i++) {
          const attachment = args.attachments[i]!;
          const result = await processAttachment(attachment, i, options.sessionPath);

          if (result.type === 'error') {
            return errorResponse(result.message);
          }

          if (result.type === 'image') {
            return errorResponse(
              `Attachment ${i + 1}: Image attachments are not supported. Use text files only.`
            );
          }

          if (result.type === 'text') {
            totalContentBytes += result.bytes;

            if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
              return errorResponse(
                `Total attachment size exceeds ${MAX_TOTAL_CONTENT_BYTES / 1_000_000}MB limit.\n\n` +
                'Options:\n' +
                '1. Use line ranges to reduce content: {path: "...", startLine: X, endLine: Y}\n' +
                '2. Split into multiple call_llm calls\n' +
                '3. Remove some attachments'
              );
            }

            textParts.push(`<file path="${result.filename}">\n${result.content}\n</file>`);
          }
        }
      }

      textParts.push(args.prompt);

      // ========================================
      // EXECUTE QUERY
      // ========================================

      const model = args.model;
      const schema = args.outputSchema || (args.outputFormat ? OUTPUT_FORMATS[args.outputFormat] : null);

      try {
        const result = await queryFn({
          prompt: textParts.join('\n\n'),
          systemPrompt: args.systemPrompt || undefined,
          model,
          maxTokens: args.maxTokens,
          temperature: args.temperature,
          outputSchema: schema ? (schema as Record<string, unknown>) : undefined,
        });

        if (!result.text && !result.warning) {
          return { content: [{ type: 'text' as const, text: '(Model returned empty response)' }] };
        }

        const body = result.warning
          ? `[Partial result — ${result.warning}]\n\n${result.text || '(no text produced before stop)'}`
          : result.text;

        return { content: [{ type: 'text' as const, text: body }] };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`call_llm failed: ${error.message}`);
        }
        throw error;
      }
    },
    { annotations: { readOnlyHint: true } }
  );
}
