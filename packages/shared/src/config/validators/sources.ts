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
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { safeJsonParse } from "../../utils/files.ts";
import { EntityColorSchema } from "../../colors/validate.ts";
import { evaluateMcpTransportWrite, LEGACY_SSE_TRANSPORT_ERROR } from "../../sources/mcp-transport-policy.ts";
import type { FolderSourceConfig } from "../../sources/types.ts";
// ============================================================
// Source & Agent Validators (Folder-Based Architecture)
// ============================================================
import { getWorkspaceSourcesPath } from "../../workspaces/storage.ts";
import type { ValidationIssue, ValidationResult } from './validation-types.ts';
import { zodErrorToIssues } from './validation-types.ts';

// --- sources/{slug}/config.json ---

const SourceTypeSchema = z.enum(['mcp', 'api', 'local']);

// MCP source supports current transports plus legacy persisted SSE:
// - Streamable HTTP / legacy SSE: requires url and authType
// - Stdio: requires command (and optional args, env)
const McpSourceConfigSchema = z.object({
  transport: z.enum(['http', 'sse', 'stdio']).optional(),
  // Remote transport fields
  url: z.string().url().optional(),
  authType: z.enum(['oauth', 'bearer', 'none']).optional(),
  clientId: z.string().optional(),
  // Stdio fields
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  // Custom headers for remote transport (e.g., API keys, custom auth)
  headers: z.record(z.string(), z.string()).optional(),
  // Header names for credential-store auth (values stored in credential store as JSON)
  headerNames: z.array(z.string()).optional(),
}).refine(
  (data) => {
    if (data.transport === 'stdio') {
      // Stdio transport requires command
      return !!data.command;
    } else {
      // Remote transport (default HTTP or persisted SSE) requires url and authType
      return !!data.url && !!data.authType;
    }
  },
  {
    message: 'MCP config requires either (url + authType) for remote transport or (command) for stdio transport',
  }
);

const ApiOAuthConfigSchema = z.object({
  authorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  audience: z.string().optional(),
  extraParams: z.record(z.string(), z.string()).optional(),
});

const ApiSourceConfigSchema = z.object({
  baseUrl: z.string().url(),
  authType: z.enum(['bearer', 'header', 'query', 'basic', 'oauth', 'none']),
  headerName: z.string().optional(),
  headerNames: z.array(z.string()).optional(),
  queryParam: z.string().optional(),
  authScheme: z.string().optional(),
  defaultHeaders: z.record(z.string(), z.string()).optional(),
  testEndpoint: z
    .object({
      method: z.enum(['GET', 'POST']),
      path: z.string(),
      body: z.record(z.string(), z.unknown()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  googleService: z.enum(['gmail', 'calendar', 'drive', 'docs', 'sheets', 'youtube', 'searchconsole']).optional(),
  googleScopes: z.array(z.string()).optional(),
  googleOAuthClientId: z.string().optional(),
  googleOAuthClientSecret: z.string().optional(),
  slackService: z.enum(['messaging', 'channels', 'users', 'files', 'full']).optional(),
  slackUserScopes: z.array(z.string()).optional(),
  microsoftService: z.enum(['outlook', 'microsoft-calendar', 'onedrive', 'teams', 'sharepoint']).optional(),
  microsoftScopes: z.array(z.string()).optional(),
  oauth: ApiOAuthConfigSchema.optional(),
});

const LocalSourceConfigSchema = z.object({
  path: z.string().min(1),
  format: z.string().optional(),
});

// Source brand schema
const SourceBrandSchema = z.object({
  color: EntityColorSchema.optional(),
});

export const FolderSourceConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  enabled: z.boolean(),
  provider: z.string().min(1),
  type: SourceTypeSchema,
  mcp: McpSourceConfigSchema.optional(),
  api: ApiSourceConfigSchema.optional(),
  local: LocalSourceConfigSchema.optional(),
  brand: SourceBrandSchema.optional(),
  isAuthenticated: z.boolean().optional(),
  lastTestedAt: z.number().int().min(0).optional(),
  // Timestamps are optional - manually created configs may not have them
  // Storage functions add these automatically when saving
  createdAt: z.number().int().min(0).optional(),
  updatedAt: z.number().int().min(0).optional(),
}).refine(
  (data) => {
    // Ensure correct config block exists for type
    switch (data.type) {
      case 'mcp': return !!data.mcp;
      case 'api': return !!data.api;
      case 'local': return !!data.local;
    }
  },
  { message: 'Config must include type-specific configuration (mcp, api, or local)' }
);

/**
 * Validate a source config object (in-memory, no disk reads)
 */
export function validateSourceConfig(config: unknown): ValidationResult {
  const result = FolderSourceConfigSchema.safeParse(config);

  if (result.success) {
    const warnings: ValidationIssue[] = [];
    if (result.data.type === 'mcp' && result.data.mcp?.transport === 'sse') {
      warnings.push({
        file: 'config.json',
        path: 'mcp.transport',
        message: 'Legacy SSE transport is retained only for persisted configurations',
        severity: 'warning',
        suggestion: 'Migrate this source to Streamable HTTP or stdio',
      });
    }
    return { valid: true, errors: [], warnings };
  }

  return {
    valid: false,
    errors: zodErrorToIssues(result.error, 'config.json'),
    warnings: [],
  };
}

/**
 * Validate source config from a JSON string.
 * Used by PreToolUse hook to validate before writing to disk.
 */
export function validateSourceConfigContent(
  jsonString: string,
  options?: {
    enforceMcpTransportWrite?: boolean;
    previousJsonString?: string;
  },
): ValidationResult {
  let content: unknown;
  try {
    content = safeJsonParse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file: 'config.json',
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const validation = validateSourceConfig(content);
  if (!validation.valid || !options?.enforceMcpTransportWrite) return validation;

  let previous: FolderSourceConfig | null = null;
  if (options.previousJsonString) {
    try {
      previous = safeJsonParse(options.previousJsonString) as FolderSourceConfig;
    } catch {
      // An invalid prior file must not weaken policy for the replacement write.
    }
  }
  const decision = evaluateMcpTransportWrite(content as FolderSourceConfig, previous);
  if (!decision.allowed) {
    validation.valid = false;
    validation.errors.push({
      file: 'config.json',
      path: 'mcp.transport',
      message: LEGACY_SSE_TRANSPORT_ERROR,
      severity: 'error',
      suggestion: 'Set mcp.transport to "http" (Streamable HTTP) or "stdio"',
    });
  }
  return validation;
}

/**
 * Validate a source folder (workspace-scoped)
 */
export function validateSource(workspaceId: string, slug: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const file = `sources/${slug}/config.json`;
  const configPath = join(sourcesDir, slug, 'config.json');

  if (!existsSync(join(sourcesDir, slug))) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Source folder '${slug}' does not exist`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  if (!existsSync(configPath)) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: 'config.json not found',
        severity: 'error',
        suggestion: 'Create a config.json file in the source folder',
      }],
      warnings: [],
    };
  }

  let content: unknown;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    content = safeJsonParse(raw);
  } catch (e) {
    return {
      valid: false,
      errors: [{
        file,
        path: '',
        message: `Invalid JSON: ${e instanceof Error ? e.message : 'Unknown error'}`,
        severity: 'error',
      }],
      warnings: [],
    };
  }

  const result = validateSourceConfig(content);

  // Add warnings for missing guide.md
  const guidePath = join(sourcesDir, slug, 'guide.md');
  if (!existsSync(guidePath)) {
    result.warnings.push({
      file: `sources/${slug}/guide.md`,
      path: '',
      message: 'guide.md not found (recommended for usage guidelines)',
      severity: 'warning',
    });
  }

  return result;
}

/**
 * Validate all sources in a workspace
 */
export function validateAllSources(workspaceId: string): ValidationResult {
  const sourcesDir = getWorkspaceSourcesPath(workspaceId);
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!existsSync(sourcesDir)) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'Sources directory does not exist (no sources configured)',
        severity: 'warning',
      }],
    };
  }

  const entries = readdirSync(sourcesDir);
  const sourceFolders = entries.filter((entry) => {
    const entryPath = join(sourcesDir, entry);
    return statSync(entryPath).isDirectory();
  });

  if (sourceFolders.length === 0) {
    return {
      valid: true,
      errors: [],
      warnings: [{
        file: 'sources/',
        path: '',
        message: 'No sources configured',
        severity: 'warning',
      }],
    };
  }

  for (const folder of sourceFolders) {
    const result = validateSource(workspaceId, folder);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
