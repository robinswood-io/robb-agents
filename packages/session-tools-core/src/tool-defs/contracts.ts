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
import { errorResponse } from "../response.ts";
import type { SessionToolContext } from "../context.ts";
import type { ToolResult } from "../types.ts";

// ============================================================
// Tool Definition Type
// ============================================================

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: unknown) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

/** Safe/Explore mode behavior for a session tool. */
export type SessionToolSafeMode = 'allow' | 'block';

interface SessionToolDefBase {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Whether this tool is allowed in Explore/Safe mode. */
  safeMode: SessionToolSafeMode;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
  /** Whether retrying the same call has the same externally visible effect. */
  idempotent?: boolean;
  /** Explicit opt-in for speculative parallel execution by sequential backends. */
  parallelSafe?: boolean;
}

/** Tool executed from the canonical registry (requires a concrete handler). */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
  handler: SessionToolHandler;
}

/** Tool executed by backend-specific adapters (Pi/Claude/session-mcp-server). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
  handler: null;
}

/** A single session tool definition combining name, description, schema, mode, and handler. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

/** Validate input for handlers that require a schema-specific argument object.
 * Handlers accepting unknown own their validation and stay registered directly. */
export function defineRegistryTool<Schema extends z.ZodObject<z.ZodRawShape>>(
  definition: Omit<RegistrySessionToolDef, 'inputSchema' | 'handler'> & {
    inputSchema: Schema;
    handler: (ctx: SessionToolContext, args: z.output<Schema>) => Promise<ToolResult>;
  },
): RegistrySessionToolDef {
  return {
    ...definition,
    async handler(ctx, args) {
      const parsed = definition.inputSchema.safeParse(args);
      if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 3)
          .map(issue => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`).join('; ');
        return errorResponse(`Invalid arguments for ${definition.name}: ${details}`);
      }
      return definition.handler(ctx, parsed.data);
    },
  };
}
