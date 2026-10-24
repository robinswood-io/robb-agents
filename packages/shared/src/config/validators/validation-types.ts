/**
 * Config Validators
 *
 * Zod schemas and validation utilities for config files.
 * Used by agents to validate config changes before they take effect.
 *
 * Validates:
 * - config.json: Main app configuration
 * - preferences.json: User preferences
 * - sources/{slug}/config.json: Workspace-scoped source configs
 * - permissions.json: Permission rules for Explore mode
 * - tool-icons/tool-icons.json: CLI tool icon mappings
 */
import { z } from "zod";
import { join } from "path";
import { CONFIG_DIR } from "../paths.ts";
import { THINKING_LEVEL_IDS } from "../../agent/thinking-levels.ts";
import { SUPPORTED_LANGUAGE_CODES } from "../../i18n/languages.ts";
import type { LanguageCode } from "../../i18n/languages.ts";

// ============================================================
// Config Directory
// ============================================================

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationIssue {
  file: string;
  path: string;  // JSON path like "workspaces[0].name"
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  fixed?: string[];
}

// ============================================================
// Zod Schemas
// ============================================================

// --- config.json ---

const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  slug: z.string().optional(),
  createdAt: z.number().int().positive(),
  sessionId: z.string().optional(),
  iconUrl: z.string().optional(),
}).passthrough();

// --- LLM Connection schema for config validation ---

const LlmProviderTypeSchema = z.enum([
  'anthropic', 'openai', 'openai_compat', 'pi', 'pi_compat', 'copilot',
  // Legacy values kept for config parsing tolerance (migrated at runtime):
  'anthropic_compat', 'bedrock', 'vertex',
]);

const LlmAuthTypeSchema = z.enum([
  'api_key', 'api_key_with_endpoint', 'oauth', 'iam_credentials',
  'bearer_token', 'service_account_file', 'environment', 'none',
]);

const CustomEndpointSchema = z.object({
  api: z.enum(['openai-completions', 'anthropic-messages']),
  supportsImages: z.boolean().optional(),
});

const LlmConnectionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  providerType: LlmProviderTypeSchema,
  authType: LlmAuthTypeSchema,
  baseUrl: z.string().optional(),
  models: z.array(z.union([z.string(), z.object({ id: z.string() }).passthrough()])).optional(),
  defaultModel: z.string().optional(),
  modelSelectionMode: z.enum(['automaticallySyncedFromProvider', 'userDefined3Tier']).optional(),
  customEndpoint: CustomEndpointSchema.optional(),
  createdAt: z.number(),
  // Allow additional fields (codexPath, awsRegion, gcpProjectId, etc.)
}).passthrough();

export const StoredConfigSchema = z.object({
  schemaVersion: z.literal(1),
  workspaces: z.array(WorkspaceSchema).min(0),
  activeWorkspaceId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  llmConnections: z.array(LlmConnectionSchema).optional(),
  defaultLlmConnection: z.string().optional(),
  defaultThinkingLevel: z.enum([...THINKING_LEVEL_IDS, 'think'] as [string, ...string[]]).transform(v => v === 'think' ? 'medium' : v).optional(),
  // Note: tokenDisplay, showCost, cumulativeUsage, defaultPermissionMode removed
  // Permission mode and cyclable modes are now per-workspace in workspace config.json
}).passthrough();

// --- preferences.json ---

const LocationSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
});

export const UserPreferencesSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),  // TODO: Could validate against IANA timezone list
  location: LocationSchema.optional(),
  notes: z.string().optional(),
  // Internal: mirrors Appearance → Language. Not user-editable.
  // Validated against the registry-derived supported set.
  uiLanguage: z.enum([...SUPPORTED_LANGUAGE_CODES] as [LanguageCode, ...LanguageCode[]]).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).passthrough();

// ============================================================
// Validation Functions
// ============================================================

/**
 * Convert Zod error to ValidationIssues
 */
export function zodErrorToIssues(error: z.ZodError, file: string): ValidationIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join('.') || 'root',
    message: issue.message,
    severity: 'error' as const,
  }));
}
