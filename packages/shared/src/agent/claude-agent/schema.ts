import { z } from 'zod';


















































/**
 * Create an in-process MCP server that proxies source tool calls through the McpClientPool.
 * This replaces direct MCP connections — the pool owns all source connections centrally.
 *
 * Returns a McpSdkServerConfigWithInstance that can be added to Options.mcpServers.
 */

export interface ClaudeJsonSchemaProperty {
  [key: string]: unknown;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  oneOf?: ClaudeJsonSchemaProperty[];
  anyOf?: ClaudeJsonSchemaProperty[];
  allOf?: ClaudeJsonSchemaProperty[];
  properties?: Record<string, ClaudeJsonSchemaProperty>;
  required?: string[];
  items?: ClaudeJsonSchemaProperty;
  additionalProperties?: boolean | ClaudeJsonSchemaProperty;
}


export const MAX_SCHEMA_DEPTH = 5;


/**
 * Convert a JSON Schema property to a Zod type.
 * Handles oneOf/anyOf unions, nested objects with properties, typed arrays, allOf merges,
 * and enums — so the LLM sees the full parameter structure instead of z.unknown().
 */
export function jsonPropToZod(prop: unknown, depth = 0): z.ZodTypeAny {
  if (!prop || typeof prop !== 'object') return z.unknown();
  const schemaProperty = prop as ClaudeJsonSchemaProperty;
  if (depth >= MAX_SCHEMA_DEPTH) return z.unknown();

  // Attach description if present
  const withDesc = (zodType: z.ZodTypeAny): z.ZodTypeAny =>
    schemaProperty.description ? zodType.describe(schemaProperty.description) : zodType;

  // Enum — string literals
  if (schemaProperty.enum && Array.isArray(schemaProperty.enum) && schemaProperty.enum.length > 0) {
    return withDesc(z.enum(schemaProperty.enum as [string, ...string[]]));
  }

  // oneOf / anyOf — discriminated or plain unions
  const unionVariants = schemaProperty.oneOf ?? schemaProperty.anyOf;
  if (Array.isArray(unionVariants) && unionVariants.length > 0) {
    const members = unionVariants.map((v) => jsonPropToZod(v, depth + 1));
    if (members.length === 1) return withDesc(members[0]!);
    return withDesc(z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]));
  }

  // allOf — merge into a single object shape
  if (Array.isArray(schemaProperty.allOf) && schemaProperty.allOf.length > 0) {
    const mergedProps: Record<string, ClaudeJsonSchemaProperty> = {};
    const mergedRequired: string[] = [];
    for (const sub of schemaProperty.allOf) {
      if (sub.properties) Object.assign(mergedProps, sub.properties);
      if (Array.isArray(sub.required)) mergedRequired.push(...sub.required);
    }
    if (Object.keys(mergedProps).length > 0) {
      return withDesc(jsonPropToZod({
        type: 'object',
        properties: mergedProps,
        required: mergedRequired,
        description: schemaProperty.description,
      }, depth));
    }
    // Fallback: if allOf doesn't have properties, take the first variant
    return withDesc(jsonPropToZod(schemaProperty.allOf[0], depth + 1));
  }

  switch (schemaProperty.type) {
    case 'string':
      return withDesc(z.string());
    case 'number':
    case 'integer':
      return withDesc(z.number());
    case 'boolean':
      return withDesc(z.boolean());
    case 'array': {
      const itemSchema = schemaProperty.items
        ? jsonPropToZod(schemaProperty.items, depth + 1)
        : z.unknown();
      return withDesc(z.array(itemSchema));
    }
    case 'object': {
      // Nested object with known properties → build z.object({...})
      if (schemaProperty.properties && typeof schemaProperty.properties === 'object') {
        const shape = jsonSchemaToZodShape(schemaProperty, depth + 1);
        const obj = z.object(shape);
        // JSON Schema defaults additionalProperties to true when omitted.
        // Only use strict (strip) mode when explicitly set to false.
        if (schemaProperty.additionalProperties === false) {
          return withDesc(obj);
        }
        return withDesc(obj.passthrough());
      }
      // Generic object (no properties defined)
      return withDesc(z.record(z.string(), z.unknown()));
    }
    default:
      return withDesc(z.unknown());
  }
}


export function jsonSchemaToZodShape(schema: Record<string, unknown>, depth = 0): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties as Record<string, ClaudeJsonSchemaProperty>) || {};
  const required = new Set((schema.required as string[]) || []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType = jsonPropToZod(prop, depth);
    if (!required.has(key)) zodType = zodType.optional();
    shape[key] = zodType;
  }

  return shape;
}
