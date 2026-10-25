/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - Claude SDK  → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi    → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the schema, description, handler import, and
 * one entry in SESSION_TOOL_DEFS.
 */
import { z } from "zod";
import { getCompletionCriteriaJsonSchema } from "../completion-criteria-schema.ts";
import { getSessionToolDefs } from './registry.ts';
import { TransformFilterScalar } from './schemas.ts';

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  idempotent?: boolean;
  parallelSafe?: boolean;
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @param opts.prefix - Optional prefix for tool names (e.g., 'mcp__session__' for Pi)
 * @param opts.includeDeveloperFeedback - Include experimental feedback tool in output
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({ includeDeveloperFeedback: opts?.includeDeveloperFeedback });

  return defs.map(def => {
    // Every registry schema is Zod 4. The Zod 3 converter silently emitted {}
    // for 28 tools, hiding required inputs, enums and the reviewer role from Pi.
    const jsonSchema = (def.name === 'set_completion_criteria'
      ? getCompletionCriteriaJsonSchema()
      : z.toJSONSchema(def.inputSchema, {
        io: 'input',
        override: ({ zodSchema, jsonSchema }) => {
          if (zodSchema !== TransformFilterScalar) return;
          // Pi tries/coerces anyOf alternatives in order. A typed JSON filter
          // must retain true/1/null rather than matching a different string.
          delete jsonSchema.anyOf;
          (jsonSchema as Record<string, unknown>).type = ['string', 'number', 'boolean', 'null'];
        },
      })) as Record<string, unknown>;
    if (jsonSchema.type !== 'object' || !jsonSchema.properties || typeof jsonSchema.properties !== 'object') {
      throw new Error(`Session tool ${def.name} did not produce an object input schema`);
    }
    // Strip metadata not needed by MCP/Pi consumers
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    return {
      name: prefix + def.name,
      description: def.description,
      inputSchema: jsonSchema,
      readOnly: def.readOnly,
      idempotent: def.idempotent,
      parallelSafe: def.parallelSafe,
    };
  });
}
