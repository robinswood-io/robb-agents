/**
 * Shared PreToolUse utilities and centralized PreToolUse pipeline.
 *
 * Individual utility functions (path expansion, skill qualification, etc.)
 * are used by the centralized `runPreToolUseChecks()` pipeline, which both
 * agent backends (Claude and Pi) call with normalized input and then translate
 * the result to their SDK-specific format. Pi hosts non-Anthropic model
 * providers (OpenAI, GitHub Copilot, Bedrock, etc.) under a single backend,
 * so they inherit this pipeline transparently.
 *
 * Pipeline steps:
 * 1. Permission mode check: Block tools disallowed by current mode
 * 2. Source blocking: Block tools from inactive MCP sources
 * 3. Prerequisite check: Block source tools until guide.md is read
 * 4. call_llm detection: Intercept mcp__session__call_llm
 * 5. Input transforms: Path expansion, config validation, skill qualification, metadata stripping
 * 6. Ask-mode prompt decision: Determine if user approval is needed
 */

import {
  containsBrowserKeyboardText,
  isObservationalBrowserCommand,
  setContextualGmailBrowserMutationGuard,
} from '../browser-tool-runtime.ts';
import { isBrowserToolNameOrAlias, isCanonicalBrowserToolName } from '../browser-tool-names.ts';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { yoloHumanHandoffBlock, YOLO_AUTONOMY_GUIDANCE } from '../yolo-policy.ts';
import { createHash, randomUUID } from 'node:crypto';
import { isProtectedApplicationPath, APPLICATION_PROTECTION_REASON } from '@craft-agent/session-tools-core';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { expandPath } from '../../utils/paths.ts';
import {
  detectConfigFileType,
  detectAppConfigFileType,
  validateConfigFileContent,
  formatValidationResult,
  type ConfigFileDetection,
} from '../../config/validators.ts';
import {
  CLI_DOMAIN_POLICIES,
  CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES,
  CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES,
  type CliDomainNamespace,
} from '../../config/cli-domains.ts';
import { FEATURE_FLAGS } from '../../feature-flags.ts';
import { AGENTS_PLUGIN_NAME } from '../../skills/types.ts';
import { GLOBAL_AGENT_SKILLS_DIR, PROJECT_AGENT_SKILLS_DIR } from '../../skills/storage.ts';
import {
  shouldAllowToolInMode,
  isApiEndpointAllowed,
  isReadOnlyBashCommandWithConfig,
  getPermissionModeDiagnostics,
  PERMISSION_MODE_CONFIG,
  isPathWithinDirectory,
  type PermissionMode,
} from '../mode-manager.ts';
import { permissionsConfigCache, type PermissionsContext } from '../permissions-config.ts';
import type { PrerequisiteCheckResult } from './prerequisite-manager.ts';
import type { TerminalReconciliationPolicy } from '../backend/types.ts';
import { rewriteBashWithRtk } from './rtk-rewrite.ts';
import { enforceTaskToolIsolation } from './task-tool-isolation.ts';
import {
  classifySensitiveExternalAction,
  contextualGmailClosedExactEffectExpectationFromObjective,
  contextualGmailReplyPreflightAttestationFromObjective,
  contextualGmailReplyRecoveryReason,
  contextualGmailTargetScopedAuthorizationSegments,
  externalActionAuthorityPolicySegments,
  hasContextualGmailReplyMention,
  hasUnresolvedRemoteScopeTarget,
  hasUnresolvedSensitiveExternalActionTarget,
  isClearlyReadOnlyToolAction,
  isContextualGmailReplyAuthorizedByObjective,
  isSensitiveExternalActionAuthorizedByObjective,
  isSensitiveExternalActionConfirmationRequestedByObjective,
  isSensitiveExternalActionExplicitlyAuthorized,
  isSensitiveExternalActionOtherwiseAuthorizedByObjective,
  isSensitiveRemoteTransferSource,
  isTargetFreeGenericContinuation,
  parseStructuredGmailSendResumeSegment,
  signedOssAtomicWriteAuthorizedSessionId,
  structuredGmailSendAuthorizationDiagnostic,
  type ContextualGmailReplyPreflightAttestation,
  type ContextualGmailReplyPreflightIntent,
  type SensitiveExternalActionCategory,
} from './sensitive-external-action.ts';
import type { SessionExecutionIsolation } from '../../tasks/durable-execution.ts';
import {
  checkObjectiveEvidenceBeforeMutation,
  detectHighStakesEvidenceDomain,
  isConcreteOperationalSoftwareRestatement,
  isOperationalTechnicalContractLifecycleObjective,
} from './objective-evidence-gate.ts';
import { classifyToolNameMutationSemantics } from './tool-name-semantics.ts';
import {
  classifyBoundedTargetedRemoteOperationalInspection,
  classifyReadOnlyRemoteObservationRepair,
  classifyNestedSshReadOnlyRemoteObservationRepair,
  containsRemoteStaticSourceInspectionCandidate,
  containsLocalSshTransportInvocation,
  isBoundedRemoteStaticSourceInspection,
  isProvablyReadOnlyShellCommand,
  isReadOnlyRegisteredShellObservation,
  isRemoteStaticSourceInspectionCandidate,
  remoteStaticSourceInspectionLiteralPath,
  remoteStaticSourceInspectionLiteralPaths,
  type BoundedTargetedRemoteOperationalInspection,
  type ReadOnlyRemoteObservationRepair,
} from './registered-observation.ts';

// ============================================================
// TYPES
// ============================================================

export interface PreToolUseContext {
  /** Current working directory or workspace root */
  workspaceRootPath: string;
  /** Workspace ID for skill qualification */
  workspaceId: string;
  /** Debug callback */
  onDebug?: (message: string) => void;
}

export interface PathExpansionResult {
  /** Whether any paths were modified */
  modified: boolean;
  /** The updated input (or original if not modified) */
  input: Record<string, unknown>;
}

export interface SkillQualificationResult {
  /** Whether the skill name was qualified */
  modified: boolean;
  /** The updated input */
  input: Record<string, unknown>;
}

export interface MetadataStrippingResult {
  /** Whether metadata was stripped */
  modified: boolean;
  /** The cleaned input */
  input: Record<string, unknown>;
}

export interface ConfigValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

export interface DeclaredToolCapabilities {
  readOnly?: boolean;
  idempotent?: boolean;
  destructive?: boolean;
  openWorld?: boolean;
  /** Host assertion, not a remote server's self-reported annotation. */
  trusted?: boolean;
}

/** Host-owned effect classification used by permission and evidence gates. */
export interface ToolEffectDescriptor {
  kind: 'read' | 'local-write' | 'external-mutation' | 'unknown';
  reversibility: 'not-applicable' | 'reversible' | 'irreversible' | 'unknown';
  idempotent?: boolean;
  openWorld?: boolean;
  source: 'builtin' | 'host-connector-contract' | 'input-semantics' | 'mcp-annotations' | 'permissions-config' | 'unknown';
}

// ============================================================
// BUILT-IN TOOLS
// ============================================================

/** SDK built-in tools that should NOT have metadata stripped */
export const BUILT_IN_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TaskOutput',
  'TodoWrite',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
  'SubmitPlan',
  'Skill',
  'SlashCommand',
  'TaskStop',
]);

/** Tools that operate on file paths */
export const FILE_PATH_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'NotebookEdit',
]);

/** Tools that can write config files */
export const CONFIG_WRITE_TOOLS = new Set(['Write', 'Edit']);

/** File tools blocked for labels domain. */
export const LABELS_BLOCKED_FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);


// ============================================================
// PATH EXPANSION
// ============================================================

/**
 * Expand ~ paths in file tool inputs.
 *
 * Handles multiple path parameters:
 * - file_path: Used by Read, Write, Edit, MultiEdit
 * - notebook_path: Used by NotebookEdit
 * - path: Used by Glob, Grep
 *
 * @param toolName - The SDK tool name
 * @param input - The tool input object
 * @param onDebug - Optional debug callback
 * @returns PathExpansionResult with modified flag and updated input
 */
export function expandToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): PathExpansionResult {
  if (!FILE_PATH_TOOLS.has(toolName)) {
    return { modified: false, input };
  }

  let updatedInput: Record<string, unknown> | null = null;

  // Expand file_path if present and starts with ~
  if (typeof input.file_path === 'string' && input.file_path.startsWith('~')) {
    const expandedPath = expandPath(input.file_path);
    onDebug?.(`Expanding path: ${input.file_path} → ${expandedPath}`);
    updatedInput = { ...input, file_path: expandedPath };
  }

  // Expand notebook_path if present and starts with ~
  if (typeof input.notebook_path === 'string' && input.notebook_path.startsWith('~')) {
    const expandedPath = expandPath(input.notebook_path);
    onDebug?.(`Expanding notebook path: ${input.notebook_path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), notebook_path: expandedPath };
  }

  // Expand path if present and starts with ~ (for Glob, Grep)
  if (typeof input.path === 'string' && input.path.startsWith('~')) {
    const expandedPath = expandPath(input.path);
    onDebug?.(`Expanding search path: ${input.path} → ${expandedPath}`);
    updatedInput = { ...(updatedInput || input), path: expandedPath };
  }

  return {
    modified: updatedInput !== null,
    input: updatedInput || input,
  };
}

// ============================================================
// SKILL QUALIFICATION
// ============================================================

/**
 * Ensure skill names are fully-qualified with the correct plugin prefix.
 *
 * The SDK resolves skills as `pluginName:skillSlug` where the plugin name is
 * read from `.claude-plugin/plugin.json` `name` field. Skills can live in 3 tiers:
 *   1. Workspace: {workspaceRoot}/skills/{slug}/ → plugin name from plugin.json
 *   2. Project:   {workingDir}/.agents/skills/{slug}/ → plugin name = ".agents"
 *   3. Global:    ~/.agents/skills/{slug}/ → plugin name = ".agents"
 *
 * This function resolves the bare slug to the correct plugin prefix by checking
 * which directory actually contains the skill. It also handles re-qualifying
 * skills that were incorrectly qualified by the UI (which always uses the
 * workspace slug, even for global/project skills).
 *
 * @param input - The Skill tool input ({ skill: string, args?: string })
 * @param workspaceSlug - The workspace slug (from .claude-plugin/plugin.json name)
 * @param workspaceRootPath - Absolute path to the workspace root
 * @param workingDirectory - Absolute path to the current working directory (optional)
 * @param onDebug - Optional debug callback
 * @returns SkillQualificationResult with modified flag and updated input
 */
export function qualifySkillName(
  input: Record<string, unknown>,
  workspaceSlug: string,
  workspaceRootPath?: string,
  workingDirectory?: string,
  onDebug?: (message: string) => void
): SkillQualificationResult {
  const skill = input.skill as string | undefined;
  if (!skill) return { modified: false, input };

  // Extract the bare slug — strip any existing qualifier (e.g. "CraftAgentWS:commit" → "commit")
  const bareSlug = skill.includes(':') ? skill.split(':').pop()! : skill;
  if (!bareSlug) return { modified: false, input };

  // If we don't have the workspace root path, fall back to simple workspace-only qualification
  if (!workspaceRootPath) {
    if (skill.includes(':')) return { modified: false, input };
    const qualifiedSkill = `${workspaceSlug}:${skill}`;
    onDebug?.(`Skill tool: qualified "${skill}" → "${qualifiedSkill}" (legacy fallback)`);
    return { modified: true, input: { ...input, skill: qualifiedSkill } };
  }

  // Resolve which plugin tier contains this skill by checking SKILL.md existence
  const resolvedSkill = resolveSkillPlugin(bareSlug, workspaceSlug, workspaceRootPath, workingDirectory);

  if (resolvedSkill === skill) {
    // Already correctly qualified
    return { modified: false, input };
  }

  onDebug?.(`Skill tool: qualified "${skill}" → "${resolvedSkill}"`);
  return {
    modified: true,
    input: { ...input, skill: resolvedSkill },
  };
}

/**
 * Resolve a skill slug to its fully-qualified plugin:slug name by checking
 * which plugin directory actually contains the skill.
 */
function resolveSkillPlugin(
  bareSlug: string,
  workspaceSlug: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string {
  // Priority order matches loadAllSkills: project (highest) > workspace > global (lowest)

  // 1. Project: {workingDir}/.agents/skills/{slug}/SKILL.md
  if (workingDirectory && existsSync(join(workingDirectory, PROJECT_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // 2. Workspace: {workspaceRoot}/skills/{slug}/SKILL.md
  if (existsSync(join(workspaceRootPath, 'skills', bareSlug, 'SKILL.md'))) {
    return `${workspaceSlug}:${bareSlug}`;
  }

  // 3. Global: ~/.agents/skills/{slug}/SKILL.md
  if (existsSync(join(GLOBAL_AGENT_SKILLS_DIR, bareSlug, 'SKILL.md'))) {
    return `${AGENTS_PLUGIN_NAME}:${bareSlug}`;
  }

  // Fallback: assume workspace plugin (original behavior)
  return `${workspaceSlug}:${bareSlug}`;
}

// ============================================================
// MCP METADATA STRIPPING
// ============================================================

/**
 * Strip _intent and _displayName metadata from tool inputs.
 *
 * These fields are injected into all tool schemas by the network interceptor
 * so Claude provides semantic intent for UI display. They must be stripped
 * before execution to avoid SDK validation errors and MCP server rejections.
 *
 * The extraction for UI happens in tool-matching.ts BEFORE this stripping.
 *
 * @param toolName - The tool name
 * @param input - The tool input object
 * @param onDebug - Optional debug callback
 * @returns MetadataStrippingResult with modified flag and cleaned input
 */
export function stripToolMetadata(
  toolName: string,
  input: Record<string, unknown>,
  onDebug?: (message: string) => void
): MetadataStrippingResult {
  const hasMetadata = '_intent' in input || '_displayName' in input;

  if (!hasMetadata) {
    return { modified: false, input };
  }

  // Strip the metadata fields
  const { _intent, _displayName, ...cleanInput } = input;
  onDebug?.(`Stripped tool metadata from ${toolName}: _intent=${!!_intent}, _displayName=${!!_displayName}`);

  return {
    modified: true,
    input: cleanInput,
  };
}

/**
 * @deprecated Use stripToolMetadata instead. This alias is kept for backwards compatibility.
 */
export const stripMcpMetadata = stripToolMetadata;

// ============================================================
// CONFIG FILE VALIDATION
// ============================================================

/**
 * Validate config file writes before they happen.
 *
 * For Write/Edit operations on workspace config files, validates the
 * resulting content before allowing the write to proceed. This prevents
 * invalid configs from ever reaching disk.
 *
 * Validates:
 * - sources/{slug}/config.json
 * - skills/{slug}/SKILL.md
 * - statuses/config.json
 * - permissions.json
 * - theme.json
 * - tool-icons/tool-icons.json
 *
 * @param toolName - 'Write' or 'Edit'
 * @param input - The tool input (with expanded paths)
 * @param workspaceRootPath - The workspace root path for detection
 * @param onDebug - Optional debug callback
 * @returns ConfigValidationResult with valid flag and optional error
 */
export function validateConfigWrite(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  onDebug?: (message: string) => void
): ConfigValidationResult {
  if (!CONFIG_WRITE_TOOLS.has(toolName)) {
    return { valid: true };
  }

  const filePath = input.file_path as string | undefined;
  if (!filePath) {
    return { valid: true };
  }

  // Check workspace-scoped configs first, then app-level configs
  const detection: ConfigFileDetection | null =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);

  if (!detection) {
    // Not a config file - allow
    return { valid: true };
  }

  let contentToValidate: string | null = null;
  let previousContent: string | undefined;

  if (toolName === 'Write') {
    // For Write, the full file content is in input.content
    contentToValidate = input.content as string;
    try {
      previousContent = readFileSync(filePath, 'utf-8');
    } catch {
      // A missing file is a new write and intentionally has no legacy allowance.
    }
  } else if (toolName === 'Edit') {
    // For Edit, simulate the replacement on the current file content
    try {
      const currentContent = readFileSync(filePath, 'utf-8');
      previousContent = currentContent;
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = input.replace_all as boolean | undefined;
      contentToValidate = replaceAll
        ? currentContent.replaceAll(oldString, newString)
        : currentContent.replace(oldString, newString);
    } catch {
      // File doesn't exist yet or can't be read — skip validation
      // (Write tool will create it; Edit will fail on its own)
      return { valid: true };
    }
  }

  if (!contentToValidate) {
    return { valid: true };
  }

  const validationResult = validateConfigFileContent(detection, contentToValidate, previousContent);

  if (validationResult && !validationResult.valid) {
    onDebug?.(
      `Config validation blocked ${toolName} to ${detection.displayFile}: ${validationResult.errors.length} errors`
    );
    return {
      valid: false,
      error: `Cannot write invalid config to ${detection.displayFile}.\n\n${formatValidationResult(validationResult)}\n\nFix the errors above and try again.`,
    };
  }

  return { valid: true };
}

function buildCliDomainBlockMessage(namespace: CliDomainNamespace, context: string): string {
  const policy = CLI_DOMAIN_POLICIES[namespace]
  const noun = namespace === 'automation' ? 'automation' : namespace
  const quickExamplesHeading = namespace === 'label' ? 'Quick examples:' : 'Examples:'

  return [
    `${context}`,
    `Use \`craft-agent ${namespace} ...\` instead.`,
    `Run \`${policy.helpCommand}\` for the full ${noun} command reference.`,
    '',
    quickExamplesHeading,
    ...policy.quickExamples.map(example => `  ${example}`),
  ].join('\n')
}

function getWorkspaceRelativePath(
  filePath: string,
  workspaceRootPath: string,
  workingDirectory?: string,
): string | null {
  const normalizedWorkspaceRoot = resolve(workspaceRootPath).replace(/\\/g, '/').replace(/\/?$/, '/');
  const resolvedPath = filePath.startsWith('/')
    ? resolve(filePath)
    : resolve(workingDirectory ?? workspaceRootPath, filePath);
  const normalizedPath = resolvedPath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedWorkspaceRoot)) return null;

  return normalizedPath.slice(normalizedWorkspaceRoot.length);
}

function matchesPathScope(relativePath: string, scope: string): boolean {
  if (scope.endsWith('/**')) {
    const prefix = scope.slice(0, -3)
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
  }

  if (scope.includes('*')) {
    const escaped = scope
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]+')
    return new RegExp(`^${escaped}$`).test(relativePath)
  }

  return relativePath === scope
}

function detectCliNamespaceFromConfigDetection(detection: ConfigFileDetection): CliDomainNamespace | null {
  if (detection.type === 'labels') return 'label'
  if (detection.type === 'automations') return 'automation'
  if (detection.type === 'source') return 'source'
  if (detection.type === 'skill') return 'skill'
  return null
}

/**
 * For selected config domains, enforce CLI usage instead of direct file operations.
 * - labels/**: strict block on Read/Write/Edit
 * - sources/{slug}/config.json: redirect on Write/Edit
 * - skills/{slug}/SKILL.md: redirect on Write/Edit
 * - automations.json: redirect on Write/Edit
 */
export function getConfigCliRedirect(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const filePath = input.file_path as string | undefined;

  if (filePath && LABELS_BLOCKED_FILE_TOOLS.has(toolName)) {
    const relativePath = getWorkspaceRelativePath(filePath, workspaceRootPath, workingDirectory)
    if (relativePath) {
      const labelsScopeMatch = CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES.find(
        entry => entry.namespace === 'label' && matchesPathScope(relativePath, entry.scope)
      )
      if (labelsScopeMatch) {
        return {
          message: buildCliDomainBlockMessage(
            'label',
            `Direct ${toolName} operations in labels/ are blocked.`
          ),
        }
      }
    }
  }

  if (!CONFIG_WRITE_TOOLS.has(toolName)) return null;
  if (!filePath) return null;

  const detection =
    detectConfigFileType(filePath, workspaceRootPath) ?? detectAppConfigFileType(filePath);
  if (!detection) return null;

  const namespace = detectCliNamespaceFromConfigDetection(detection)
  if (!namespace) return null

  return {
    message: buildCliDomainBlockMessage(
      namespace,
      `Direct ${toolName} operations in ${detection.displayFile} are blocked.`
    ),
  }
}

/**
 * Block bash commands that operate on guarded config paths unless they use craft-agent commands.
 * Current guarded domains in Bash are declared in shared CLI domain policy.
 */
export function getConfigDomainBashRedirect(
  input: Record<string, unknown>,
  workspaceRootPath: string,
  workingDirectory?: string,
): { message: string } | null {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return null;

  if (/^craft-agent\s+(label|automation|source|skill)\b/.test(command)) {
    return null;
  }

  const baseDir = resolve(workingDirectory ?? workspaceRootPath);
  const tokenRegex = /'([^']+)'|"([^"]+)"|([^\s'";|&()<>]+)/g;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(command)) !== null) {
    const candidate = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidate) continue;
    if (!candidate.includes('/') && !candidate.includes('\\') && !candidate.endsWith('.json') && !candidate.endsWith('.jsonl')) {
      continue;
    }
    candidates.push(candidate);
  }

  const bashGuardEntries: Array<{ namespace: CliDomainNamespace; scope: string }> = CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES

  for (const candidate of candidates) {
    const relativePath = getWorkspaceRelativePath(candidate, workspaceRootPath, baseDir);
    if (!relativePath) continue;

    for (const entry of bashGuardEntries) {
      if (!matchesPathScope(relativePath, entry.scope)) continue

      const context = entry.namespace === 'label'
        ? 'Direct Bash operations targeting the workspace labels/ folder are blocked.'
        : `Direct Bash operations targeting \`${relativePath}\` are blocked.`

      return {
        message: buildCliDomainBlockMessage(entry.namespace, context),
      }
    }
  }

  return null;
}

// ============================================================
// CENTRALIZED PRETOOLUSE PIPELINE
// ============================================================

/**
 * Discriminated union result from `runPreToolUseChecks()`.
 * Each agent translates these into its SDK-specific format via a simple switch.
 */
export type PreToolUseCheckResult =
  | { type: 'allow' }
  | { type: 'modify'; input: Record<string, unknown> }
  | { type: 'block'; reason: string; source?: 'prerequisite' }
  | {
      type: 'prompt';
      promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
      description: string;
      command?: string;
      modifiedInput?: Record<string, unknown>;
      appName?: string;
      reason?: string;
      impact?: string;
      requiresSystemPrompt?: boolean;
      rememberForMinutes?: number;
      commandHash?: string;
      approvalTtlSeconds?: number;
      /** Scoped metadata used to remember this exact external authorization. */
      sensitiveActionCategory?: SensitiveExternalActionCategory;
      sensitiveActionTargets?: string[];
      sensitiveActionOperationHash?: string;
      /** Never auto-allow this prompt when the backend has no permission handler. */
      requiresExplicitConfirmation?: true;
    }
  | { type: 'source_activation_needed'; sourceSlug: string; sourceExists: boolean }
  | { type: 'call_llm_intercept'; input: Record<string, unknown> }
  | { type: 'spawn_session_intercept'; input: Record<string, unknown> };

/**
 * Input for `runPreToolUseChecks()`. Each agent builds this from its SDK-specific
 * hook input. All fields needed for the pipeline are normalized here.
 */
export interface PreToolUseInput {
  /** SDK-normalized tool name (PascalCase for built-in, mcp__server__tool for MCP) */
  toolName: string;
  /** Tool input object */
  input: Record<string, unknown>;
  /** Current session ID */
  sessionId: string;
  /** Host-issued id for this exact tool call, used to bind post-tool receipts. */
  toolUseId?: string;
  /** Stable identity of the backend runtime executing this turn. */
  runtimeId?: string;
  /** Host-only marker for Pi's one synchronous re-check after it activates an MCP source. */
  sourceActivationReentry?: boolean;
  /** Host-only marker for the same backend tool call after a permission wait. */
  permissionApprovalReentry?: boolean;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Absolute path to workspace root */
  workspaceRootPath: string;
  /** Workspace ID or slug for skill qualification */
  workspaceId: string;
  /** Plans folder path for the session (writes allowed in explore mode) */
  plansFolderPath?: string;
  /** Data folder path (writes allowed in explore mode for transform_data output) */
  dataFolderPath?: string;
  /** Working directory override (for skill resolution) */
  workingDirectory?: string;
  /** Persisted host-enforced isolation for a Conductor child session. */
  executionIsolation?: SessionExecutionIsolation;
  /** Host-only evaluated capability lease for a specialized Mission. */
  missionCapabilityLock?: import('../../sessions/types.ts').MissionCapabilityLock;
  /** Currently active source slugs */
  activeSourceSlugs: string[];
  /** All available sources (for source-exists check) */
  allSourceSlugs: string[];
  /** Whether the agent supports source activation (has onSourceActivationRequest callback) */
  hasSourceActivation: boolean;
  /**
   * Confirmation policy for sensitive external actions. Defaults to `confirm`.
   * The opt-in bypass is honored only in the effective `allow-all` mode.
   */
  externalActionPolicy?: 'confirm' | 'allow-in-execute';
  /** Live host policy, including a bound ancestor's no-human requirement. */
  humanInputAllowed?: boolean;
  /** Host-derived from the persisted active objective, never from tool prose. */
  objectiveMutationAuthorized?: boolean;
  /** Mutation authority inherited from the authenticated root objective. A
   * spawned prompt cannot grant this capability to itself. */
  objectiveSensitiveActionAuthorized?: boolean;
  /** Authenticated human objective segments, kept separate so action words and
   * targets from unrelated amendments cannot be combined into authorization. */
  objectiveAuthorizationSegments?: readonly string[];
  /** Exact host-derived structured-answer segments. Public objective text can
   * never populate this provenance channel, even if it copies its marker. */
  authenticatedUserAuthorizationSegments?: readonly string[];
  /** Host-owned terminal lock and its complete positive tool allowlist. */
  objectiveTerminalReconciliationPolicy?: TerminalReconciliationPolicy;
  /** PermissionManager for session-scoped whitelists */
  permissionManager: PermissionManagerLike;
  /** PrerequisiteManager for guide.md checking */
  prerequisiteManager?: PrerequisiteManagerLike;
  /**
   * Source guide files whose full contents were preloaded into the model's
   * current context. Host-owned context builders may provide these to avoid a
   * synthetic first-call rejection.
   */
  preloadedSourceGuidePaths?: readonly string[];
  /** Backend metadata (e.g. Pi forwards intent / displayName via input.metadata) */
  backendMetadata?: { intent?: string; displayName?: string };
  /** Raw current request. Never overrides authenticated objective segments when they are present. */
  currentUserRequest?: string;
  /** Capability hints supplied by the registered MCP definition, never by model input. */
  declaredToolCapabilities?: DeclaredToolCapabilities;
  /** RTK Bash-rewrite context (undefined when toggle is off or rtk binary missing) */
  rtkContext?: import('./rtk-rewrite.ts').RtkContext;
  /** Debug callback */
  onDebug?: (message: string) => void;
}

const RBW_OSS_WHOLE_CATALOG_READ_TOOL = 'mcp__rbw-agents-oss__oss_read_file';
const RBW_OSS_OVERSIZED_CATALOG_GUIDANCE = new Map<string, string>([
  [
    '/srv/rbw-agents-oss/config/command-manifest.json',
    'Use `oss_list_automations` to inspect bounded wrapper metadata, then call `oss_run_automation` directly with the already-known `legacyId`; do not load the full command manifest.',
  ],
  [
    '/srv/rbw-agents-oss/config/automation-mapping.json',
    'Use `oss_list_automations` to inspect bounded wrapper metadata, then call `oss_run_automation` directly with the already-known `legacyId`; do not load the full automation mapping.',
  ],
  [
    '/srv/rbw-agents-oss/config/temporal/schedules.json',
    'Use `oss_schedule_status` for the bounded live schedule view; do not load the full schedule catalog.',
  ],
]);

/**
 * Refuse only known whole-catalog reads whose connector currently exposes no
 * offset/limit contract. This happens after normal mode/source/prerequisite
 * checks but before connector execution, so a rejected read cannot spend a
 * remote call or poison the model context. Ordinary OSS files and archived
 * snapshots remain available through the normal pipeline.
 */
export function oversizedRbwOssCatalogReadGuidance(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== RBW_OSS_WHOLE_CATALOG_READ_TOOL || typeof input.path !== 'string') {
    return undefined;
  }
  const rawPath = input.path.trim();
  // Connector paths are POSIX paths. Canonicalize dot segments as well as
  // duplicate separators so a spelling alias cannot bypass a known-catalog
  // guard, while a path that genuinely resolves elsewhere remains available.
  const normalizedPath = rawPath.startsWith('/') ? posix.normalize(rawPath) : rawPath;
  return RBW_OSS_OVERSIZED_CATALOG_GUIDANCE.get(normalizedPath);
}

const REQUEST_USER_INPUT_TOOL_NAMES = new Set([
  'request_user_input',
  'session__request_user_input',
  'mcp__session__request_user_input',
]);

/** A read-only Sellsy OAuth start is an admitted connector observation. Do
 * not turn that available step into an extra Robb Agents permission question.
 * A real provider consent or MFA callback is handled by the OAuth flow. */
function redundantlyAsksPermissionForSellsyReadOnlyOAuth(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!REQUEST_USER_INPUT_TOOL_NAMES.has(toolName)
    || !Array.isArray(input.questions)
    || input.questions.length !== 1) return false;
  const question = input.questions[0];
  if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
  const text = typeof question.question === 'string'
    ? normalizeAutonomyGuardText(question.question) : '';
  return /\bsellsy\b/u.test(text)
    && /\boauth\b/u.test(text)
    && /\bsubscriptions\.read\b/u.test(text)
    && /\blecture seule\b/u.test(text)
    && /\bautoris/u.test(text)
    && !/\b(?:write|ecriture|modifier|modification)\b/u.test(text);
}

const CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS = 15 * 60 * 1000;
const CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS = 10 * 60 * 1000;
const CONTEXTUAL_GMAIL_BINDING_FUTURE_SKEW_MS = 30 * 1000;
const GMAIL_API_MESSAGE_ID = /^[0-9a-f]{12,32}$/iu;
const CONTEXTUAL_GMAIL_READ_TOOLS = new Set([
  'mcp__google-contacts__gmail_get_message',
  'mcp__google-contacts__gmail_get_message_by_url',
]);
const CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
]);
const CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_bound',
  'mcp__google-contacts__gmail_reply_all',
]);
const pendingContextualGmailPreflights = new Map<string, {
  expiresAt: number;
  generation: number;
  intent: ContextualGmailReplyPreflightIntent;
  policySegments: readonly string[];
  objectiveFingerprint: string;
}>();
const observedContextualGmailReads = new Map<string, {
  expiresAt: number;
  messageId: string;
  toolUseId: string;
  objectiveFingerprint: string;
}>();
const contextualGmailPreflightAttestations = new Map<string, {
  expiresAt: number;
  generation: number;
  value: ContextualGmailReplyPreflightAttestation;
  objectiveFingerprint: string;
}>();
const reservedContextualGmailReplyAttestations = new Map<string, {
  expiresAt: number;
  generation: number;
  value: ContextualGmailReplyPreflightAttestation;
  objectiveFingerprint: string;
}>();
const contextualGmailPreflightGenerations = new Map<string, number>();
interface ContextualGmailToolUseClaim {
  objectiveFingerprint: string;
  operationHash: string;
  phase: 'claimed' | 'awaiting-source-reentry' | 'admitted' | 'terminal' | 'poisoned';
  sourceActivationReentryConsumed: boolean;
  toolName: string;
}
const contextualGmailToolUseClaims = new Map<string, ContextualGmailToolUseClaim>();
const inFlightContextualGmailReplies = new Map<string, {
  generation: number;
  hostExecutionToken?: string;
  invalidated: boolean;
  operationHash: string;
  poisoned: boolean;
  possiblyExecuted: boolean;
  runtimeId?: string;
  toolName: string;
  toolUseId: string;
}>();
/**
 * Definitive session deletion is distinct from a backend runtime restart.
 * When a bound host call is still unresolved, retain its exact correlation
 * until either its ticket settles or its runtime is confirmed dead, then purge
 * every remaining session-scoped tombstone and observation.
 */
const contextualGmailSessionsPendingFinalCleanup = new Map<string, {
  runtimeId?: string;
  runtimeTeardownConfirmed: boolean;
}>();
const observedThirdPartyDependencies = new Map<string, {
  expiresAt: number;
  objectiveFingerprint: string;
  dependencies: PendingThirdPartyDependency[];
}>();
const observedResolvedThirdPartyDependencies = new Map<string, {
  expiresAt: number;
  objectiveFingerprint: string;
  dependencies: PendingThirdPartyDependency[];
}>();

function contextualGmailObjectiveFingerprint(segments: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(segments), 'utf8').digest('hex');
}

function nextContextualGmailPreflightGeneration(sessionId: string): number {
  const generation = (contextualGmailPreflightGenerations.get(sessionId) ?? 0) + 1;
  contextualGmailPreflightGenerations.set(sessionId, generation);
  return generation;
}

function contextualGmailPreflightIntentsMatch(
  first: ContextualGmailReplyPreflightIntent,
  second: ContextualGmailReplyPreflightIntent,
): boolean {
  return first.scope === second.scope
    && first.messageId === second.messageId
    && first.body === second.body
    && first.isHtml === second.isHtml
    && first.requiresExactEffectReconciliation === second.requiresExactEffectReconciliation
    && first.expectedRecipientEmail === second.expectedRecipientEmail
    && first.expectedSenderEmail === second.expectedSenderEmail
    && first.expectedCc === second.expectedCc
    && first.expectedSubject === second.expectedSubject
    && first.objectiveRequest === second.objectiveRequest;
}

function contextualGmailBindingExpiresAt(
  binding: string,
  bindingExpiresInSeconds: unknown,
  observedAtMs: number,
): number | undefined {
  const match = /^v1\.([0-9]{10})\.[0-9a-f]{64}$/u.exec(binding);
  if (!match
    || typeof bindingExpiresInSeconds !== 'number'
    || !Number.isFinite(bindingExpiresInSeconds)
    || bindingExpiresInSeconds <= 0) return undefined;
  const issuedAtMs = Number(match[1]) * 1000;
  if (!Number.isSafeInteger(issuedAtMs)
    || issuedAtMs > observedAtMs + CONTEXTUAL_GMAIL_BINDING_FUTURE_SKEW_MS
    || observedAtMs - issuedAtMs > CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS) return undefined;
  const receiptExpiryMs = observedAtMs + Math.min(
    bindingExpiresInSeconds * 1000,
    CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS,
  );
  const signedExpiryMs = issuedAtMs + CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS;
  const expiresAtMs = Math.min(receiptExpiryMs, signedExpiryMs);
  return expiresAtMs > observedAtMs ? expiresAtMs : undefined;
}

function contextualGmailObjectiveProvidesClosedExactHumanAnchor(
  objectiveSegments: readonly string[] | undefined,
  intent: ContextualGmailReplyPreflightIntent,
): boolean {
  const exactEffect = contextualGmailClosedExactEffectExpectationFromObjective(
    objectiveSegments ?? [],
  );
  return intent.requiresExactEffectReconciliation
    && intent.scope === 'reply'
    && exactEffect?.scope === 'reply'
    && exactEffect.anchorMessageId?.toLowerCase() === intent.messageId.toLowerCase()
    && exactEffect.expectedRecipientEmail !== undefined
    && exactEffect.expectedRecipientEmail === intent.expectedRecipientEmail
    && exactEffect.expectedSenderEmail !== undefined
    && exactEffect.expectedSenderEmail === intent.expectedSenderEmail
    && exactEffect.expectedCc === ''
    && intent.expectedCc === ''
    && exactEffect.expectedSubject !== undefined
    && exactEffect.expectedSubject === intent.expectedSubject
    && exactEffect.expectedBody !== undefined
    && exactEffect.expectedBody === intent.body
    && exactEffect.expectedIsHtml === intent.isHtml;
}

function contextualGmailToolReceipt(value: string): Record<string, unknown> | undefined {
  if (!value || value.length > 2_000_000) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalGmailEmailSet(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  const residue = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '')
    .replace(/[\s,;]+/gu, '');
  return residue || new Set(emails).size !== emails.length
    ? undefined
    : [...new Set(emails)].sort();
}

function hasConclusiveContextualGmailExactEffectReconciliation(
  receipt: Record<string, unknown>,
): boolean {
  const reconciliation = receipt.exactEffectReconciliation;
  if (!reconciliation || typeof reconciliation !== 'object'
    || Array.isArray(reconciliation)) return false;
  const proof = reconciliation as Record<string, unknown>;
  return proof.checked === true
    && proof.conclusive === true
    && proof.paginationComplete === true
    && proof.source === 'gmail_threads_get_full'
    && Array.isArray(proof.scopes)
    && proof.scopes.length === 2
    && proof.scopes[0] === 'SENT'
    && proof.scopes[1] === 'DRAFT'
    && proof.candidateCount === 0
    && typeof receipt.threadId === 'string'
    && GMAIL_API_MESSAGE_ID.test(receipt.threadId)
    && proof.threadId === receipt.threadId
    && typeof receipt.operationKey === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.operationKey)
    && proof.operationKey === receipt.operationKey;
}

function exactObservedGmailMessageId(
  toolName: string,
  input: Record<string, unknown> | undefined,
  result: Record<string, unknown>,
): string | undefined {
  if (!CONTEXTUAL_GMAIL_READ_TOOLS.has(toolName) || result.error !== undefined) return undefined;
  const directId = typeof result.id === 'string' && GMAIL_API_MESSAGE_ID.test(result.id)
    ? result.id.toLowerCase()
    : undefined;
  const latest = result.latestMessage && typeof result.latestMessage === 'object'
    ? result.latestMessage as Record<string, unknown>
    : undefined;
  const latestId = typeof latest?.id === 'string' && GMAIL_API_MESSAGE_ID.test(latest.id)
    ? latest.id.toLowerCase()
    : undefined;
  const messageId = directId ?? latestId;
  if (!messageId) return undefined;
  const requestedId = typeof input?.messageId === 'string' && GMAIL_API_MESSAGE_ID.test(input.messageId.trim())
    ? input.messageId.trim().toLowerCase()
    : undefined;
  if (requestedId && requestedId !== messageId) return undefined;
  return messageId;
}

function currentContextualGmailPreflightAttestation(
  sessionId: string,
  objectiveFingerprint: string,
): ContextualGmailReplyPreflightAttestation | undefined {
  const stored = contextualGmailPreflightAttestations.get(sessionId);
  if (!stored) return undefined;
  if (stored.expiresAt <= Date.now()
    || stored.objectiveFingerprint !== objectiveFingerprint
    || stored.generation !== contextualGmailPreflightGenerations.get(sessionId)) {
    contextualGmailPreflightAttestations.delete(sessionId);
    return undefined;
  }
  return stored.value;
}

/**
 * Discard only transient Gmail exact-once mutation state after an interrupted
 * tool runtime. Keep independently observed third-party dependency evidence:
 * an abort/restart must not make the agent ask the user about the same known
 * vendor wait state again.
 */
export function clearContextualGmailMutationLifecycleState(sessionId: string): void {
  contextualGmailPreflightAttestations.delete(sessionId);
  contextualGmailPreflightGenerations.delete(sessionId);
  inFlightContextualGmailReplies.delete(sessionId);
  observedContextualGmailReads.delete(sessionId);
  for (const key of pendingContextualGmailPreflights.keys()) {
    if (key.startsWith(`${sessionId}:`)) pendingContextualGmailPreflights.delete(key);
  }
  for (const key of reservedContextualGmailReplyAttestations.keys()) {
    if (key.startsWith(`${sessionId}:`)) reservedContextualGmailReplyAttestations.delete(key);
  }
  maybeFinalizeContextualGmailSessionCleanup(sessionId);
}

/** Session destruction/tests can explicitly discard every session-scoped observation. */
export function clearContextualGmailPreflightAttestation(sessionId: string): void {
  contextualGmailSessionsPendingFinalCleanup.delete(sessionId);
  clearContextualGmailMutationLifecycleState(sessionId);
  for (const key of contextualGmailToolUseClaims.keys()) {
    if (key.startsWith(`${sessionId}:`)) contextualGmailToolUseClaims.delete(key);
  }
  observedThirdPartyDependencies.delete(sessionId);
  observedResolvedThirdPartyDependencies.delete(sessionId);
}

function maybeFinalizeContextualGmailSessionCleanup(sessionId: string): void {
  const pendingCleanup = contextualGmailSessionsPendingFinalCleanup.get(sessionId);
  if (!pendingCleanup
    || inFlightContextualGmailReplies.has(sessionId)
    || pendingCleanup.runtimeId && !pendingCleanup.runtimeTeardownConfirmed) return;
  clearContextualGmailPreflightAttestation(sessionId);
}

/**
 * Request definitive cleanup for a deleted session. Unlike a runtime
 * invalidation, this eventually removes dependency observations and tool-id
 * tombstones too. An unresolved host mutation remains fail-closed until its
 * exact ticket or confirmed runtime teardown proves the terminal boundary.
 */
export function destroyContextualGmailSessionState(sessionId: string): void {
  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  contextualGmailSessionsPendingFinalCleanup.set(sessionId, {
    runtimeId: inFlight?.runtimeId,
    runtimeTeardownConfirmed: !inFlight?.runtimeId,
  });
  invalidateContextualGmailSessionState(sessionId);
  maybeFinalizeContextualGmailSessionCleanup(sessionId);
}

/**
 * Invalidate reusable session evidence without making an unresolved host
 * mutation disappear. Backend instances call this when a session runtime is
 * destroyed or recreated; the matching runtime teardown/ticket is the only
 * authority that may release an in-flight reply.
 */
export function invalidateContextualGmailSessionState(sessionId: string): void {
  contextualGmailPreflightAttestations.delete(sessionId);
  observedContextualGmailReads.delete(sessionId);
  for (const key of pendingContextualGmailPreflights.keys()) {
    if (key.startsWith(`${sessionId}:`)) pendingContextualGmailPreflights.delete(key);
  }

  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  if (inFlight) inFlight.invalidated = true;
  const preservedKey = inFlight ? `${sessionId}:${inFlight.toolUseId}` : undefined;
  for (const key of reservedContextualGmailReplyAttestations.keys()) {
    if (key.startsWith(`${sessionId}:`) && key !== preservedKey) {
      reservedContextualGmailReplyAttestations.delete(key);
    }
  }
  for (const key of contextualGmailToolUseClaims.keys()) {
    if (key.startsWith(`${sessionId}:`) && key !== preservedKey) {
      contextualGmailToolUseClaims.delete(key);
    }
  }
  if (!inFlight) contextualGmailPreflightGenerations.delete(sessionId);
}

export interface ContextualGmailHostExecutionTicket {
  readonly generation: number;
  readonly hostExecutionToken: string;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly toolUseId: string;
}

export type ContextualGmailHostExecutionDecision =
  | { applies: false; allowed: true }
  | { applies: true; allowed: false; reason: string }
  | { applies: true; allowed: true; ticket: ContextualGmailHostExecutionTicket };

/** Read-only runtime correlation used to decide whether Stop must kill a host runtime. */
export function hasContextualGmailInFlightForRuntime(input: {
  sessionId: string;
  runtimeId: string;
}): boolean {
  return inFlightContextualGmailReplies.get(input.sessionId)?.runtimeId === input.runtimeId;
}

/**
 * Atomically cross the last host boundary before invoking a bound Gmail
 * mutation. The pre-tool reservation is correlated by runtime, operation hash
 * and (when available) the SDK tool-use id. An omitted id is safe only because
 * a session can hold at most one in-flight reply and the exact operation still
 * has to match.
 */
export function beginContextualGmailHostExecution(input: {
  sessionId: string;
  runtimeId?: string;
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): ContextualGmailHostExecutionDecision {
  if (!CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(input.toolName)) {
    return { applies: false, allowed: true };
  }

  const inFlight = inFlightContextualGmailReplies.get(input.sessionId);
  const exactOperationHash = hashSensitiveExternalActionOperation(input.toolName, input.toolInput);
  const reservationKey = inFlight
    ? `${input.sessionId}:${inFlight.toolUseId}`
    : undefined;
  const exactClaim = inFlight
    ? contextualGmailToolUseClaims.get(reservationKey!)
    : undefined;
  if (!input.runtimeId
    || !inFlight
    || inFlight.runtimeId !== input.runtimeId
    || inFlight.toolName !== input.toolName
    || inFlight.operationHash !== exactOperationHash
    || (input.toolUseId !== undefined && input.toolUseId !== inFlight.toolUseId)
    || inFlight.invalidated
    || inFlight.poisoned
    || exactClaim?.phase !== 'admitted') {
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: this bound Gmail host call has no exact admitted reservation for the current runtime, tool id and payload. Do not execute it or use another send path; run one fresh canonical preflight when no prior mutation remains in flight.',
    };
  }
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey!);
  const generation = contextualGmailPreflightGenerations.get(input.sessionId);
  if (!reserved
    || reserved.expiresAt <= Date.now()
    || reserved.generation !== inFlight.generation
    || generation !== inFlight.generation) {
    // The exact host invocation is known not to have started, so an expired or
    // otherwise invalid reservation can be consumed safely. Never restore it.
    reservedContextualGmailReplyAttestations.delete(reservationKey!);
    contextualGmailPreflightAttestations.delete(input.sessionId);
    inFlightContextualGmailReplies.delete(input.sessionId);
    exactClaim.phase = 'terminal';
    maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: the exact Gmail host reservation expired or is no longer the current generation. No host call started. Run one fresh canonical preflight before retrying.',
    };
  }
  if (inFlight.hostExecutionToken) {
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: the admitted bound Gmail reply already entered host execution. A duplicate host start is blocked until the exact execution ticket settles.',
    };
  }

  const hostExecutionToken = randomUUID();
  inFlight.hostExecutionToken = hostExecutionToken;
  inFlight.possiblyExecuted = true;
  return {
    applies: true,
    allowed: true,
    ticket: {
      generation: inFlight.generation,
      hostExecutionToken,
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      toolUseId: inFlight.toolUseId,
    },
  };
}

/**
 * Consume the authority represented by exactly one host execution ticket.
 * This is intentionally outcome-agnostic: once the host call started, a
 * transport error cannot prove that Gmail observed no effect. A retry therefore
 * requires a fresh canonical preflight and exact-effect reconciliation.
 */
export function settleContextualGmailHostExecution(
  ticket: ContextualGmailHostExecutionTicket,
): boolean {
  const inFlight = inFlightContextualGmailReplies.get(ticket.sessionId);
  if (!inFlight
    || inFlight.toolUseId !== ticket.toolUseId
    || inFlight.runtimeId !== ticket.runtimeId
    || inFlight.generation !== ticket.generation
    || inFlight.hostExecutionToken !== ticket.hostExecutionToken) {
    return false;
  }

  const reservationKey = `${ticket.sessionId}:${ticket.toolUseId}`;
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  if (reserved?.generation === ticket.generation) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
  }
  contextualGmailPreflightAttestations.delete(ticket.sessionId);
  inFlightContextualGmailReplies.delete(ticket.sessionId);
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  if (claim && claim.phase !== 'poisoned') claim.phase = 'terminal';
  maybeFinalizeContextualGmailSessionCleanup(ticket.sessionId);
  return true;
}

/**
 * Confirm that a backend runtime can no longer start host work. Teardown may
 * release its own admitted reservation only before host execution began; a
 * started call stays fail-closed until its exact ticket settles.
 */
export function confirmContextualGmailRuntimeTeardown(input: {
  sessionId: string;
  runtimeId: string;
}): boolean {
  const pendingCleanup = contextualGmailSessionsPendingFinalCleanup.get(input.sessionId);
  if (pendingCleanup?.runtimeId === input.runtimeId) {
    pendingCleanup.runtimeTeardownConfirmed = true;
    maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
  }
  const inFlight = inFlightContextualGmailReplies.get(input.sessionId);
  if (!inFlight
    || inFlight.runtimeId !== input.runtimeId
    || inFlight.hostExecutionToken
    || inFlight.possiblyExecuted) {
    return false;
  }

  const reservationKey = `${input.sessionId}:${inFlight.toolUseId}`;
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  if (reserved?.generation === inFlight.generation) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
  }
  contextualGmailPreflightAttestations.delete(input.sessionId);
  inFlightContextualGmailReplies.delete(input.sessionId);
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  if (claim && claim.phase !== 'poisoned') claim.phase = 'terminal';
  maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
  return true;
}

export interface ContextualGmailPromptReservationDecision {
  applies: boolean;
  allowed: boolean;
  reason?: string;
}

/**
 * Resolve an Ask-mode decision for a Gmail reply already reserved by the
 * pre-tool pipeline. Backends resume approved prompts directly, so this is the
 * last host-side boundary at which the signed binding, objective and exact-once
 * reservation can be revalidated after an arbitrarily long user wait.
 */
export function resolveContextualGmailPromptReservation(input: {
  sessionId: string;
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  approved: boolean;
  /** Effective host mode at the instant the delayed decision is consumed. */
  permissionMode?: PermissionMode;
  /** Active host sources at the instant the delayed decision is consumed. */
  activeSourceSlugs?: readonly string[];
  objectiveAuthorizationSegments?: readonly string[];
}): ContextualGmailPromptReservationDecision {
  const { sessionId, toolUseId, toolName, toolInput, approved } = input;
  if (!toolUseId || !CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName)) {
    return { applies: false, allowed: approved };
  }

  const reservationKey = `${sessionId}:${toolUseId}`;
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  const applies = claim?.toolName === toolName
    || reserved !== undefined
    || inFlight?.toolUseId === toolUseId;
  if (!applies) return { applies: false, allowed: approved };

  const now = Date.now();
  const generation = contextualGmailPreflightGenerations.get(sessionId);
  const objectiveFingerprint = contextualGmailObjectiveFingerprint(
    input.objectiveAuthorizationSegments ?? [],
  );
  const validApproval = claim?.phase === 'admitted'
    && claim?.toolName === toolName
    && claim.operationHash === hashSensitiveExternalActionOperation(toolName, toolInput)
    && claim.objectiveFingerprint === objectiveFingerprint
    && input.permissionMode !== undefined
    && input.permissionMode !== 'safe'
    && input.activeSourceSlugs?.includes('google-contacts') === true
    && reserved !== undefined
    && reserved.expiresAt > now
    && reserved.generation === generation
    && reserved.objectiveFingerprint === objectiveFingerprint
    && inFlight?.toolUseId === toolUseId
    && inFlight.generation === generation
    && !inFlight.invalidated
    && !inFlight.poisoned;

  if (approved && validApproval) return { applies: true, allowed: true };

  // A prompt rejection, expiry or objective change proves that this reserved
  // invocation did not execute. Release only an unpoisoned exact match; a
  // collided id remains locked until confirmed runtime teardown because its
  // terminal events are indistinguishable.
  if (claim?.phase !== 'poisoned' && !inFlight?.poisoned) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
    if (inFlight?.toolUseId === toolUseId) inFlightContextualGmailReplies.delete(sessionId);
    if (claim) claim.phase = 'terminal';

    const canRestoreAfterDenial = !approved
      && reserved !== undefined
      && reserved.expiresAt > now
      && reserved.generation === generation
      && reserved.objectiveFingerprint === objectiveFingerprint
      && !inFlight?.invalidated
      && !contextualGmailPreflightAttestations.has(sessionId);
    if (canRestoreAfterDenial) {
      contextualGmailPreflightAttestations.set(sessionId, reserved);
    }
    maybeFinalizeContextualGmailSessionCleanup(sessionId);
  }

  if (!approved) return { applies: true, allowed: false };
  return {
    applies: true,
    allowed: false,
    reason: 'Validation failed: the signed Gmail preflight reservation expired, changed objective, lost its exact host correlation, entered Explore mode, or lost its active Gmail source while awaiting approval. No reply was executed. Run one fresh canonical preflight after restoring the required mode and source before retrying; do not use a browser or another send path.',
  };
}

/** Promote only successful, host-observed Gmail read/preflight tool results. */
export function recordContextualGmailToolResult(input: {
  sessionId: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  executed?: boolean;
  objectiveAuthorizationSegments?: readonly string[];
}): void {
  const { sessionId, toolUseId, toolName, toolInput, result } = input;
  if (!toolUseId || !toolName) return;
  const now = Date.now();
  for (const [key, pending] of pendingContextualGmailPreflights) {
    if (pending.expiresAt <= now) pendingContextualGmailPreflights.delete(key);
  }
  for (const [key, reserved] of reservedContextualGmailReplyAttestations) {
    if (reserved.expiresAt <= now) reservedContextualGmailReplyAttestations.delete(key);
  }
  const pendingKey = `${sessionId}:${toolUseId}`;
  const terminalPending = CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)
    ? pendingContextualGmailPreflights.get(pendingKey)
    : undefined;
  if (CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)) {
    // A preflight call has one terminal result. Failed, blocked and malformed
    // results must consume the pending intent just like successful receipts.
    pendingContextualGmailPreflights.delete(pendingKey);
  }
  const objectiveSegments = input.objectiveAuthorizationSegments ?? [];
  const objectiveFingerprint = contextualGmailObjectiveFingerprint(objectiveSegments);
  if (result && !input.isError && input.executed !== false) {
    const dependencies = hostObservedThirdPartyDependencies(toolName, result);
    const resolvedDependencies = hostObservedResolvedThirdPartyDependencies(toolName, result);
    if (dependencies.length > 0 || resolvedDependencies.length > 0) {
      const previous = observedThirdPartyDependencies.get(sessionId);
      const mergedByParty = new Map<string, Set<PendingDependencyKind>>();
      for (const dependency of previous && previous.expiresAt > Date.now()
          && previous.objectiveFingerprint === objectiveFingerprint
          ? previous.dependencies : []) {
        const kinds = mergedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        mergedByParty.set(dependency.party, kinds);
      }
      for (const resolved of resolvedDependencies) {
        const kinds = mergedByParty.get(resolved.party);
        for (const kind of resolved.kinds) kinds?.delete(kind);
        if (kinds?.size === 0) mergedByParty.delete(resolved.party);
      }
      for (const dependency of dependencies) {
        const kinds = mergedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        mergedByParty.set(dependency.party, kinds);
      }
      if (mergedByParty.size === 0) {
        observedThirdPartyDependencies.delete(sessionId);
      } else {
        observedThirdPartyDependencies.set(sessionId, {
          expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
          objectiveFingerprint,
          dependencies: [...mergedByParty].map(([party, kinds]) => ({ party, kinds })),
        });
      }

      const previousResolved = observedResolvedThirdPartyDependencies.get(sessionId);
      const resolvedByParty = new Map<string, Set<PendingDependencyKind>>();
      for (const dependency of previousResolved && previousResolved.expiresAt > Date.now()
          && previousResolved.objectiveFingerprint === objectiveFingerprint
          ? previousResolved.dependencies : []) {
        resolvedByParty.set(dependency.party, new Set(dependency.kinds));
      }
      for (const dependency of dependencies) {
        const kinds = resolvedByParty.get(dependency.party);
        for (const kind of dependency.kinds) kinds?.delete(kind);
        if (kinds?.size === 0) resolvedByParty.delete(dependency.party);
      }
      for (const dependency of resolvedDependencies) {
        const kinds = resolvedByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
        for (const kind of dependency.kinds) kinds.add(kind);
        resolvedByParty.set(dependency.party, kinds);
      }
      if (resolvedByParty.size === 0) {
        observedResolvedThirdPartyDependencies.delete(sessionId);
      } else {
        observedResolvedThirdPartyDependencies.set(sessionId, {
          expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
          objectiveFingerprint,
          dependencies: [...resolvedByParty].map(([party, kinds]) => ({ party, kinds })),
        });
      }
    }
  }
  if (CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName)) {
    const reservationKey = `${sessionId}:${toolUseId}`;
    const claim = contextualGmailToolUseClaims.get(reservationKey);
    const inFlight = inFlightContextualGmailReplies.get(sessionId);
    if (inFlight?.toolUseId === toolUseId) {
      // Runtime-correlated reservations are released only by their exact host
      // ticket or a confirmed teardown. A delayed terminal event carries no
      // runtime identity and therefore must never erase a newer runtime's
      // reservation that happens to reuse the same SDK tool id.
      if (inFlight.runtimeId !== undefined) {
        inFlight.possiblyExecuted ||= input.executed !== false;
        return;
      }
      // Once a host id collides, its terminal events are indistinguishable.
      // Never count or guess which occurrence completed: retain the poisoned
      // lock until runtime teardown, then require a fresh exact reconciliation.
      if (inFlight.poisoned || claim?.phase === 'poisoned') return;
      inFlight.possiblyExecuted ||= input.executed !== false;
      inFlightContextualGmailReplies.delete(sessionId);
    } else if (claim?.phase === 'poisoned') {
      return;
    }
    if (claim) claim.phase = 'terminal';
    const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
    reservedContextualGmailReplyAttestations.delete(reservationKey);
    const active = contextualGmailPreflightAttestations.get(sessionId);
    if (active && (active.expiresAt <= now
      || active.generation !== contextualGmailPreflightGenerations.get(sessionId))) {
      contextualGmailPreflightAttestations.delete(sessionId);
    }
    const definitelyNotExecuted = inFlight?.toolUseId === toolUseId
      ? !inFlight.possiblyExecuted
      : input.executed === false;
    if (reserved && definitelyNotExecuted
      && reserved.expiresAt > now
      && reserved.objectiveFingerprint === objectiveFingerprint
      && reserved.generation === contextualGmailPreflightGenerations.get(sessionId)
      && !contextualGmailPreflightAttestations.has(sessionId)) {
      contextualGmailPreflightAttestations.set(sessionId, reserved);
    }
    maybeFinalizeContextualGmailSessionCleanup(sessionId);
    return;
  }
  if (!result || input.isError || input.executed === false) return;
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return;

  const observedMessageId = exactObservedGmailMessageId(toolName, toolInput, receipt);
  if (observedMessageId) {
    observedContextualGmailReads.set(sessionId, {
      expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
      messageId: observedMessageId,
      toolUseId,
      objectiveFingerprint,
    });
    const existing = contextualGmailPreflightAttestations.get(sessionId);
    if (existing && existing.value.messageId !== observedMessageId) {
      contextualGmailPreflightAttestations.delete(sessionId);
    }
    return;
  }

  if (!CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName)) return;
  const preflightClaim = contextualGmailToolUseClaims.get(pendingKey);
  if (preflightClaim?.phase === 'poisoned') return;
  if (preflightClaim) preflightClaim.phase = 'terminal';
  const pending = terminalPending;
  if (!pending || pending.expiresAt <= Date.now()
    || pending.objectiveFingerprint !== objectiveFingerprint
    || pending.generation !== contextualGmailPreflightGenerations.get(sessionId)) return;
  const resultIntent = toolInput
    ? contextualGmailReplyPreflightAttestationFromObjective(
      toolName,
      toolInput,
      pending.policySegments,
    )
    : undefined;
  if (!resultIntent || !contextualGmailPreflightIntentsMatch(resultIntent, pending.intent)) return;
  const read = observedContextualGmailReads.get(sessionId);
  const matchingRead = read && read.expiresAt > Date.now()
    && read.objectiveFingerprint === objectiveFingerprint
    && read.messageId === pending.intent.messageId
    ? read
    : undefined;
  // The exact-effect preflight itself performs the target-bound
  // gmail_threads_get_full read. It can therefore supply the anchor evidence
  // only when the same authenticated human objective fully closes one
  // recipient-bound plain-text reply and names this exact message. Deictic or
  // partial objectives still require a distinct host-observed Gmail read.
  const exactHumanAnchor = contextualGmailObjectiveProvidesClosedExactHumanAnchor(
    pending.policySegments,
    pending.intent,
  );
  if (!matchingRead && !exactHumanAnchor) return;
  const binding = typeof receipt.recipientBinding === 'string'
    ? receipt.recipientBinding.trim().toLowerCase()
    : '';
  const resolved = receipt.resolvedRecipients && typeof receipt.resolvedRecipients === 'object'
    ? receipt.resolvedRecipients as Record<string, unknown>
    : undefined;
  const resolvedTo = Array.isArray(resolved?.to) ? resolved.to : [];
  const resolvedCc = Array.isArray(resolved?.cc) ? resolved.cc : [];
  const recipientsAreStrings = [...resolvedTo, ...resolvedCc]
    .every(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
  const bodySha256 = createHash('sha256').update(pending.intent.body, 'utf8').digest('hex');
  const bindingExpiresAtMs = contextualGmailBindingExpiresAt(
    binding,
    receipt.bindingExpiresInSeconds,
    now,
  );
  const receiptMatches = receipt.ok === true
    && receipt.willSend === false
    && receipt.messageId === pending.intent.messageId
    && receipt.bodySha256 === bodySha256
    && receipt.isHtml === pending.intent.isHtml
    && (pending.intent.expectedSenderEmail === undefined
      ? receipt.expectedSenderEmail === undefined
        && (receipt.primarySenderEmail === undefined
          || typeof receipt.primarySenderEmail === 'string'
            && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(receipt.primarySenderEmail))
      : receipt.expectedSenderEmail === pending.intent.expectedSenderEmail
        && receipt.primarySenderEmail === pending.intent.expectedSenderEmail)
    && bindingExpiresAtMs !== undefined
    && recipientsAreStrings
    && resolvedTo.length + resolvedCc.length > 0
    && (pending.intent.expectedSubject === undefined
      || receipt.subject === pending.intent.expectedSubject)
    && (pending.intent.expectedCc === undefined
      || JSON.stringify([...resolvedCc].sort())
        === JSON.stringify(canonicalGmailEmailSet(pending.intent.expectedCc)))
    && (pending.intent.scope === 'reply-all'
      ? receipt.replyAll === true
      : receipt.replyAll === false
        && receipt.expectedRecipientEmail === pending.intent.expectedRecipientEmail
        && resolvedTo.length === 1
        && resolvedTo[0] === pending.intent.expectedRecipientEmail
        && resolvedCc.length === 0)
    && (!pending.intent.requiresExactEffectReconciliation
      || hasConclusiveContextualGmailExactEffectReconciliation(receipt));
  if (!receiptMatches || bindingExpiresAtMs === undefined) return;
  const anchorEvidence = matchingRead
    ? { anchorEvidence: 'gmail-read' as const, readToolUseId: matchingRead.toolUseId }
    : { anchorEvidence: 'exact-human-objective' as const };
  contextualGmailPreflightAttestations.set(sessionId, {
    expiresAt: bindingExpiresAtMs,
    generation: pending.generation,
    value: {
      ...pending.intent,
      recipientBinding: binding,
      bindingExpiresAtMs,
      preflightToolUseId: toolUseId,
      ...anchorEvidence,
    },
    objectiveFingerprint,
  });
}

function normalizeAutonomyGuardText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

type PendingDependencyKind = 'access' | 'credential' | 'endpoint' | 'key' | 'response' | 'token';

interface PendingThirdPartyDependency {
  kinds: Set<PendingDependencyKind>;
  party: string;
}

const NON_PARTY_NAME_TOKENS = new Set([
  'API', 'CRM', 'CSV', 'DNS', 'ERP', 'HTTP', 'HTTPS', 'JSON', 'MFA', 'MCP',
  'PDF', 'REST', 'SQL', 'SSH', 'SSO', 'UI', 'URL', 'UX', 'VPS',
  'CLIENT', 'IMPORTANT', 'URGENT', 'THE', 'LE', 'LA', 'UN', 'UNE',
  'FOURNISSEUR', 'PROVIDER', 'VENDOR', 'PRESTATAIRE', 'EDITEUR',
]);
const THIRD_PARTY_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['isagri', 'agiris'],
  ['guardtek', 'guartech'],
];

function canonicalThirdPartyName(value: string): string {
  const normalized = normalizeAutonomyGuardText(value).replace(/[^a-z0-9&._-]/gu, '');
  const aliases = THIRD_PARTY_ALIAS_GROUPS.find(group => group.includes(normalized));
  return aliases?.[0] ?? normalized;
}

function extractThirdPartyNames(rawText: string): Set<string> {
  const parties = new Set<string>();
  const normalized = normalizeAutonomyGuardText(rawText);
  for (const aliases of THIRD_PARTY_ALIAS_GROUPS) {
    if (aliases.some(alias => new RegExp(`\\b${alias}\\b`, 'u').test(normalized))) {
      parties.add(aliases[0]!);
    }
  }
  // Unknown names are accepted only when grammar binds them to a third-party
  // role or to the dependency item itself. Treating every ALL-CAPS token as a
  // supplier made labels such as URGENT/IMPORTANT/CLIENT into false blockers.
  const contextualNamePatterns = [
    /\b(?:fournisseur|vendor|provider|prestataire|editeur|éditeur)\s+([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:from|de\s+la\s+part\s+(?:de|d['’]))\s*(?:(?:le|la|l['’]|the)\s+)?([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:chez|from|par|de la part de|fournisseur|vendor|provider|prestataire|editeur|éditeur)\s+(?:(?:le|la|l['’]|the)\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
    /\bwaiting\s+on\s+([\p{L}][\p{L}0-9&._-]{1,63})\b/giu,
    /\b(?:access|accès|acces|credential|credentials|identifiant|identifiants|endpoint|url|key|clé|cle|token)\s+(?:(?:API|api)\s+)?(?:de\s+|du\s+|d['’]\s*|from\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
    /\b([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\s+(?:API\s+)?(?:access|credential|credentials|endpoint|key|token|url)\b/gu,
    /\b([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\s+(?:doit(?:\s+encore)?|must|has\s+yet\s+to|is\s+still\s+outstanding)\b/gu,
    /\b(?:de|du|d['’]|from)\s+(?:(?:le|la|l['’]|the)\s+)?([A-ZÀ-Ý][\p{L}0-9&._-]{1,63})\b/gu,
  ];
  for (const pattern of contextualNamePatterns) {
    for (const match of rawText.matchAll(pattern)) {
      const value = match[1]!;
      if (!NON_PARTY_NAME_TOKENS.has(value.toUpperCase())) {
        parties.add(canonicalThirdPartyName(value));
      }
    }
  }
  parties.delete('');
  return parties;
}

function extractPendingDependencyKinds(text: string): Set<PendingDependencyKind> {
  const kinds = new Set<PendingDependencyKind>();
  if (/\b(?:access|acces|grant|autorisation|authorization|ouverture)\b/u.test(text)) kinds.add('access');
  if (/\b(?:credential|credentials|identifiant|identifiants|secret)\b/u.test(text)) kinds.add('credential');
  if (/\b(?:endpoint|url)\b/u.test(text)) kinds.add('endpoint');
  if (/\b(?:key|cle)\b/u.test(text)) kinds.add('key');
  if (/\b(?:vendor response|reponse|response|retour)\b/u.test(text)) kinds.add('response');
  if (/\btoken\b/u.test(text)) kinds.add('token');
  return kinds;
}

function objectiveEstablishesThirdPartyDependency(
  segments: readonly string[],
): PendingThirdPartyDependency[] {
  const byParty = new Map<string, Set<PendingDependencyKind>>();
  let contextualParties = new Set<string>();
  const pendingPattern = /\b(?:await(?:ing)?|waiting|pending|attend(?:s|ons|ez|re)?|en attente|patient(?:e|er|ons|ez)?|n['’]?\s*a\s+pas\s+encore\s+(?:fourni|envoye)|doit(?:\s+encore)?(?:\s+nous)?\s+(?:fournir|envoyer|parvenir)|must(?:\s+still)?\s+(?:provide|send)|reste a (?:recevoir|obtenir)|(?:est|sont)\s+attendu(?:e|es|s)?|il\s+manque|has\s+yet\s+to\s+(?:provide|send)|(?:is|are)\s+still\s+outstanding)\b/u;
  const explicitlyNotPendingPattern = /\b(?:no longer (?:waiting|pending|awaiting)|not (?:waiting|pending|awaiting)|n['’]?attend[^.!?;\n]{0,50}(?:plus|pas)|ne sommes (?:plus |pas )?en attente|n['’]?est (?:plus |pas )?en attente|ne (?:suis|sommes|sont) pas en attente|(?:nous\s+)?ne\s+devons\s+pas\s+attendre|sans\s+attendre|without\s+waiting)\b/u;
  const unresolvedReceiptPattern = /\b(?:(?:not|has\s+not|have\s+not|n|ne|non|pas|sans)\b[^.!?;\n]{0,50}\b(?:received|obtained|arrived|provided|supplied|available|ready|recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes)|pas\s+encore\s+(?:recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes))\b/u;
  const affirmativelyResolvedPattern = /\b(?:received|obtained|arrived|provided|supplied|available|ready|recu|recue|obtenu|obtenue|arrive|arrivee|fourni|fournie|fournis|fournies|disponible|disponibles|pret|prete|prets|pretes)\b/u;

  for (const segment of segments) {
    for (const rawClause of segment.split(/[.!?;\n]+/u)) {
      if (!rawClause.trim()) continue;
      const normalizedClause = normalizeAutonomyGuardText(rawClause);
      // A future condition is neither evidence that a dependency exists nor
      // evidence that it has resolved. Keep prior observed/pending state intact.
      if (/^(?:si|if)\b/u.test(normalizedClause)) continue;
      const clauseParties = extractThirdPartyNames(rawClause);
      if (clauseParties.size > 0) contextualParties = clauseParties;
      const kinds = extractPendingDependencyKinds(normalizedClause);
      if (kinds.size === 0) continue;
      const parties = clauseParties.size > 0
        ? clauseParties
        : contextualParties.size === 1 ? contextualParties : new Set<string>();
      if (parties.size === 0) continue;

      const explicitlyNotPending = explicitlyNotPendingPattern.test(normalizedClause);
      const unresolvedReceipt = unresolvedReceiptPattern.test(normalizedClause);
      const pending = unresolvedReceipt || pendingPattern.test(normalizedClause);
      // Pending wins over a contradictory positive receipt word. The only
      // higher-precedence resolution is an explicit statement that the item is
      // not/no-longer pending (for example "nous n'attendons plus").
      const resolved = explicitlyNotPending
        || !pending && affirmativelyResolvedPattern.test(normalizedClause);
      if (resolved) {
        for (const party of parties) {
          const existing = byParty.get(party);
          for (const kind of kinds) existing?.delete(kind);
          if (existing?.size === 0) byParty.delete(party);
        }
      } else if (pending) {
        for (const party of parties) {
          const existing = byParty.get(party) ?? new Set<PendingDependencyKind>();
          for (const kind of kinds) existing.add(kind);
          byParty.set(party, existing);
        }
      }
    }
  }

  return [...byParty].map(([party, kinds]) => ({ party, kinds }));
}

function isTrustedThirdPartyDependencyReceiptTool(toolName: string): boolean {
  return /^mcp__[^_]+__(?:connection|dependency|access|credential|provider|vendor)_status$/iu.test(toolName);
}

function hostObservedThirdPartyDependencies(
  toolName: string,
  result: string,
): PendingThirdPartyDependency[] {
  if (!result || result.length > 100_000) return [];
  if (!isTrustedThirdPartyDependencyReceiptTool(toolName)) return [];
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return [];
  const pending = receipt.pending === true
    || ['pending', 'awaiting_external', 'waiting_on_vendor', 'waiting_on_provider']
      .includes(String(receipt.status ?? receipt.state ?? '').toLowerCase());
  if (!pending) return [];
  const rawParty = [receipt.party, receipt.provider, receipt.vendor, receipt.externalParty]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 1);
  if (!rawParty) return [];
  const party = canonicalThirdPartyName(rawParty);
  if (!party || NON_PARTY_NAME_TOKENS.has(rawParty.trim().toUpperCase())) return [];
  const dependencyText = [
    receipt.kind,
    receipt.dependencyKind,
    receipt.item,
    receipt.message,
  ].filter((value): value is string => typeof value === 'string').join(' ');
  const kinds = extractPendingDependencyKinds(
    normalizeAutonomyGuardText(dependencyText).replace(/[_-]+/gu, ' '),
  );
  return kinds.size > 0 ? [{ party, kinds }] : [];
}

function hostObservedResolvedThirdPartyDependencies(
  toolName: string,
  result: string,
): PendingThirdPartyDependency[] {
  if (!result || result.length > 100_000) return [];
  if (!isTrustedThirdPartyDependencyReceiptTool(toolName)) return [];
  const receipt = contextualGmailToolReceipt(result);
  if (!receipt) return [];
  const resolved = receipt.pending === false
    || ['received', 'resolved', 'ready', 'complete', 'completed', 'available']
      .includes(String(receipt.status ?? receipt.state ?? '').toLowerCase());
  if (!resolved) return [];
  const rawParty = [receipt.party, receipt.provider, receipt.vendor, receipt.externalParty]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 1);
  if (!rawParty || NON_PARTY_NAME_TOKENS.has(rawParty.trim().toUpperCase())) return [];
  const dependencyText = [
    receipt.kind,
    receipt.dependencyKind,
    receipt.item,
    receipt.message,
  ].filter((value): value is string => typeof value === 'string').join(' ');
  const kinds = extractPendingDependencyKinds(
    normalizeAutonomyGuardText(dependencyText).replace(/[_-]+/gu, ' '),
  );
  return kinds.size > 0
    ? [{ party: canonicalThirdPartyName(rawParty), kinds }]
    : [];
}

function questionAndDecisionTexts(input: Record<string, unknown>): Array<{
  question: string;
  decisions: string;
}> {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const result: Array<{ question: string; decisions: string }> = [];
  for (const rawQuestion of questions) {
    if (!rawQuestion || typeof rawQuestion !== 'object') continue;
    const question = rawQuestion as Record<string, unknown>;
    const decisions: string[] = [];
    for (const rawOption of Array.isArray(question.options) ? question.options : []) {
      if (!rawOption || typeof rawOption !== 'object') continue;
      const option = rawOption as Record<string, unknown>;
      if (typeof option.label === 'string') decisions.push(option.label);
      if (typeof option.description === 'string') decisions.push(option.description);
    }
    result.push({
      question: typeof question.question === 'string' ? question.question : '',
      decisions: decisions.join(' '),
    });
  }
  return result;
}

function redundantlyAsksAboutEstablishedThirdPartyDependency(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  observedDependencies: readonly PendingThirdPartyDependency[] = [],
  observedResolvedDependencies: readonly PendingThirdPartyDependency[] = [],
): boolean {
  if (!REQUEST_USER_INPUT_TOOL_NAMES.has(toolName)) return false;
  let explicitlyRequestedQuestion = false;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    const normalized = normalizeAutonomyGuardText(segment);
    const revokesRepeatedQuestion = /\b(?:ne\s+(?:me\s+)?(?:re)?demande\s+plus|arrete\s+de\s+(?:me\s+)?(?:re)?demander|n(?:['’]\s*|\s+)utilise\s+plus\s+(?:le\s+)?request_user_input|do\s+not\s+ask(?:\s+me)?\s+again|don['’]?t\s+ask(?:\s+me)?\s+again|never\s+ask(?:\s+me)?\s+again|stop\s+asking(?:\s+me)?|do\s+not\s+use\s+request_user_input\s+again)\b/u.test(normalized);
    if (revokesRepeatedQuestion) break;
    const explicitlyRequestsQuestion = /\b(?:utilise|use)\s+(?:le\s+)?request_user_input\b/u.test(normalized)
      && /\b(?:demande(?:r)?|ask)\b[^.!?;\n]{0,100}\b(?:faut il|should|wait|attendre)\b/u.test(normalized);
    if (explicitlyRequestsQuestion) {
      explicitlyRequestedQuestion = true;
      break;
    }
  }
  if (explicitlyRequestedQuestion) return false;
  const dependenciesByParty = new Map<string, Set<PendingDependencyKind>>();
  for (const dependency of [
    ...objectiveEstablishesThirdPartyDependency(objectiveSegments),
  ]) {
    const kinds = dependenciesByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
    for (const kind of dependency.kinds) kinds.add(kind);
    dependenciesByParty.set(dependency.party, kinds);
  }
  for (const resolved of observedResolvedDependencies) {
    const kinds = dependenciesByParty.get(resolved.party);
    for (const kind of resolved.kinds) kinds?.delete(kind);
    if (kinds?.size === 0) dependenciesByParty.delete(resolved.party);
  }
  for (const dependency of observedDependencies) {
    const kinds = dependenciesByParty.get(dependency.party) ?? new Set<PendingDependencyKind>();
    for (const kind of dependency.kinds) kinds.add(kind);
    dependenciesByParty.set(dependency.party, kinds);
  }
  const dependencies = [...dependenciesByParty]
    .map(([party, kinds]) => ({ party, kinds }));
  if (dependencies.length === 0) return false;
  const dependencyChoice = /\b(?:wait|waiting|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|pause|defer|differer|reporter|postpone|later|plus tard|fournir|provide|enter|saisir|relance|relancer|contacter|contact|follow up|remind|rappeler)\b/u;
  const waitChoice = /\b(?:wait|waiting|attente|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|pause|defer|differer|reporter|postpone|later|plus tard)\b/u;
  const questionAsksDependencyChoice = /(?:\b(?:faut[- ]il|doit[- ]on|devons[- ]nous|souhaitez[- ]vous(?:\s+que\s+je)?|voulez[- ]vous(?:\s+que\s+je)?|should we|shall i|do you want me to|would you like (?:me|us) to|would you like to|what should (?:we|i))\b[^?]{0,120}|^\s*)\b(?:wait|attendre|patienter|rest(?:e|er)\s+en\s+attente|stand[-\s]+by|hold\s+off|sit\s+tight|n(?:['’]\s*|\s+)avance(?:r)?\s+pas|suspendre|defer|differer|reporter|postpone|fournir|provide|relancer|contacter|follow up)\b/u;
  const genericPendingChoiceQuestion = /\b(?:quelle\s+suite|que\s+faire|what\s+next|next\s+step)\b[^?]{0,80}\b(?:attente|waiting|pending)\b/u;
  const sameGenericThirdParty = /\b(?:ce|cet|cette|le|la|notre|the|our|same|meme)\s+(?:third party|tiers|vendor|fournisseur|provider|prestataire|editeur)\b/u;
  const anaphoricDependencyOwner = /\b(?:leur|leurs|sa|son|ses|cette|ce|cet|their|its|this|that)\s+(?:access|acces|credential|credentials|endpoint|key|cle|token|reponse|response|retour)\b/u;
  const explicitlyNamesAnotherWaitTarget = /\b(?:(?:wait|waiting|hold\s+off|sit\s+tight|postpone|defer)\b[^?;\n]{0,70}\b(?:tests?|test\s+suite|build|server|database|migration|deployment|job|command|process)|(?:attendre|patienter|reporter|suspendre|rest(?:e|er)\s+en\s+attente|n(?:['’]\s*|\s+)avance(?:r)?\s+pas)\b[^?;\n]{0,70}\b(?:tests?|suite\s+de\s+tests?|build|compilation|serveur|base\s+de\s+donnees|migration|deploiement|commande|processus))\b/u;
  // Waiting for an already-established dependency is not a user decision, but
  // replacing the blocked provider/integration is. Preserve that substantive
  // business fork instead of trapping the mission in the current wait state.
  const substantiveAlternativeChoice = /\b(?:(?:use|choose|adopt|select|switch\s+to|move\s+to|replace\s+(?:it|them)?\s*(?:with|by)|utiliser|choisir|adopter|selectionner|basculer\s+(?:vers|sur)|remplacer(?:\s+(?:le|la|les|lui|leur))?\s+par)\b[^?;\n]{0,70}\b(?:another|other|alternative|different|backup|autre|alternative?)\b[^?;\n]{0,40}\b(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur)|(?:change|switch|replace|changer|remplacer)\b[^?;\n]{0,40}\b(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur)|(?:another|other|alternative|different|backup|autre|alternative?)\s+(?:provider|vendor|supplier|third\s+party|solution|integration|connector|api|fournisseur|prestataire|tiers|editeur|connecteur))\b/u;

  return questionAndDecisionTexts(input).some(({ question, decisions }) => {
    const normalizedQuestion = normalizeAutonomyGuardText(question);
    const normalizedDecisions = normalizeAutonomyGuardText(decisions);
    if (!dependencyChoice.test(normalizedDecisions)
      && !questionAsksDependencyChoice.test(normalizedQuestion)
      && !genericPendingChoiceQuestion.test(normalizedQuestion)) return false;
    const rawCombined = `${question}\n${decisions}`;
    const combined = normalizeAutonomyGuardText(rawCombined);
    if (substantiveAlternativeChoice.test(combined)) return false;
    const questionParties = extractThirdPartyNames(rawCombined);
    const questionKinds = extractPendingDependencyKinds(combined);
    const waits = waitChoice.test(`${normalizedQuestion} ${normalizedDecisions}`);
    return dependencies.some((dependency) => {
      const sameParty = questionParties.size > 0
        ? questionParties.has(dependency.party)
        : dependencies.length === 1 && (
          sameGenericThirdParty.test(combined)
          || anaphoricDependencyOwner.test(combined)
          || waits && !explicitlyNamesAnotherWaitTarget.test(combined)
        );
      if (!sameParty) return false;
      const sameKind = [...questionKinds].some(kind => dependency.kinds.has(kind));
      return sameKind || waits && questionKinds.size === 0;
    });
  });
}

function canonicalExternalActionInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalExternalActionInput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => entry !== undefined && key !== '_intent' && key !== '_displayName')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalExternalActionInput(entry)]));
}

/** Bind a sensitive approval to the exact tool and payload without persisting payload text. */
export function hashSensitiveExternalActionOperation(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([toolName, canonicalExternalActionInput(input)]), 'utf8')
    .digest('hex');
}

/**
 * Minimal interface for PermissionManager that runPreToolUseChecks() depends on.
 * This keeps the pipeline testable without importing the full PermissionManager.
 */
export interface PermissionManagerLike {
  isCommandWhitelisted(command: string): boolean;
  isDangerousCommand(command: string): boolean;
  getBaseCommand(command: string): string;
  extractDomainFromNetworkCommand(command: string): string | null;
  isDomainWhitelisted(domain: string): boolean;
}

/**
 * Minimal interface for PrerequisiteManager.
 */
export interface PrerequisiteManagerLike {
  checkPrerequisites(toolName: string): PrerequisiteCheckResult;
  trackBashSkillRead(input: Record<string, unknown>): boolean;
  markSourceGuidesLoadedInContext?(filePaths: readonly string[]): void;
}

/** Built-in MCP servers that are always available (not user sources) */
const BUILT_IN_MCP_SERVERS = new Set(['session', 'craft-agents-docs']);

/** File write tools that require permission in ask mode */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const BUILTIN_READ_TOOLS = new Set([
  'Read', 'Find', 'Grep', 'Glob', 'LS', 'Ls', 'TodoRead', 'WebFetch', 'WebSearch',
]);
const REMOTE_COMMAND_TOOL_PATTERN = /(?:^|__)(?:ssh_(?:execute|exec)(?:_sudo)?|remote_(?:execute|exec)|run_command)$/i;
const MUTATION_HTTP_METHOD_PATTERN = /^(?:DELETE|PATCH|POST|PUT)$/i;
const STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS = new Set([
  'mcp__rbw-servers__ssh_session_start',
  'mcp__rbw-servers__ssh_download',
]);

function objectiveNamesRemoteEndpoint(
  endpoint: string,
  objectiveSegments: readonly string[],
): boolean {
  const canonicalEndpoint = endpoint.toLowerCase();
  if (!isCanonicalRemoteEndpoint(canonicalEndpoint)) return false;
  return objectiveSegments.some(segment => {
    // Extract the same ASCII-only identifier grammar from human prose. This
    // keeps case-insensitive aliases and sentence punctuation usable while a
    // distinct Unicode spelling or a longer dotted hostname cannot silently
    // authorize the configured endpoint.
    const identifiers: readonly string[] = segment.toLowerCase().match(
      /[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g,
    ) ?? [];
    return identifiers.includes(canonicalEndpoint);
  });
}

function isCanonicalRemoteEndpoint(endpoint: string): boolean {
  // Connector aliases are authority-bearing identifiers, not prose. Validate
  // the raw value before doing any human-text normalization: NFKD folding must
  // not turn a distinct Unicode alias (`pñs`, full-width `ｐｎｓ`) into the
  // authorized ASCII target. Separators remain available for dotted/qualified
  // aliases, but may not absorb sentence punctuation such as a trailing dot.
  return /^[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}$/.test(endpoint);
}

function structuredRemoteReadChannelSignals(segment: string): {
  normalized: string;
  namesStructuredChannel: boolean;
  excludesSsh: boolean;
  apiOnly: boolean;
} {
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const namesStructuredChannel = /\brbw[-_ ]?servers?\b|\bssh\s+structure\b|\bstructured\s+ssh\b/u.test(normalized);
  // A human may explicitly forbid local/native/CLI SSH while requiring the
  // audited rbw-servers transport. Remove only that fully qualified negative
  // clause before checking broad SSH prohibitions; an unqualified `sans SSH`
  // or `do not use SSH` remains authoritative and blocks the exception.
  const sshExclusionText = namesStructuredChannel
    ? normalized.replace(
       /\b(?:(?:sans|without|no)\s+(?:(?:local(?:e)?|nati(?:f|ve)|direct|cli)\s+ssh|ssh\s+(?:local(?:e)?|nati(?:f|ve)|direct|cli))|(?:do\s+not|don't)\s+(?:use\s+)?(?:(?:local|native|direct|cli)\s+ssh|ssh\s+(?:local|native|direct|cli))|(?:n[' ]?utilis(?:e|er|ez)\s+(?:pas|plus|jamais)|ne\s+(?:pas|plus|jamais)\s+utilis(?:e|er|ez))\s+(?:(?:le\s+)?(?:ssh\s+(?:local|natif|direct|cli)|(?:local|natif|direct|cli)\s+ssh)))\b/gu,
       ' ',
     )
     : normalized;
  const excludesSsh = /\b(?:sans|without|no)\s+(?:(?:le|the)\s+)?(?:ssh|rbw[-_ ]?servers?)\b/u.test(sshExclusionText)
    || /\b(?:do\s+not|don't|n[' ]?utilis(?:e|er|ez)\s+(?:pas|plus|jamais)|ne\s+(?:pas|plus|jamais)\s+utilis(?:e|er|ez))\b[^.!?;\n]{0,40}\b(?:ssh|rbw[-_ ]?servers?)\b/u.test(sshExclusionText);
  const apiOnly = /\b(?:(?:via|par|avec|using|through)\s+)?(?:(?:l[' ]|the\s+))?api\s+(?:uniquement|seulement|only)\b/u.test(normalized)
    || /\b(?:uniquement|seulement|only)\s+(?:via|par|avec|using|through)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized)
    || /\b(?:utilise|utiliser|utilisez|use|using)\s+(?:desormais\s+|now\s+)?(?:uniquement|seulement|only|exclusively)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized)
    || /\b(?:passe|passer|passez|go)\s+(?:desormais\s+|now\s+)?(?:uniquement\s+|only\s+)?(?:par|via|through)\s+(?:(?:l[' ]|the\s+))?api\b/u.test(normalized);
  return { normalized, namesStructuredChannel, excludesSsh, apiOnly };
}

function explicitlyAuthorizesStructuredRemoteReadChannel(segment: string): boolean {
  const { normalized, excludesSsh, apiOnly } = structuredRemoteReadChannelSignals(segment);
  if (excludesSsh || apiOnly) return false;
  return /\b(?:ssh|rbw[-_ ]?servers?)\b/u.test(normalized)
    || /\b(?:sur|via|on|through)\s+(?:(?:le|the)\s+)?(?:serveurs?|servers?)\b/u.test(normalized);
}

function explicitlyRestrictsStructuredRemoteReadChannel(segment: string): boolean {
  const { excludesSsh, apiOnly } = structuredRemoteReadChannelSignals(segment);
  return excludesSsh || apiOnly;
}

function targetBoundOperationalTechnicalReadAuthoritySegment(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): string | undefined {
  const server = typeof input.server === 'string' ? input.server.trim() : '';
  if (!server) return undefined;
  // The newest substantive human segment is an authority boundary. It must
  // fully restate the endpoint and audited channel; never search past a stop,
  // retargeting or partial amendment to resurrect an older signed grant.
  const segment = [...objectiveSegments].reverse().find(
    candidate => !isNonSubstantiveBoundedSoftwareFollowUp(candidate),
  );
  if (!segment
    || detectHighStakesEvidenceDomain(segment) !== undefined
    || !(isOperationalTechnicalContractLifecycleObjective(segment)
      || isConcreteOperationalSoftwareRestatement(segment))
    || !explicitlyAuthorizesStructuredRemoteReadChannel(segment)
    // Preserve the raw ASCII identity check before the polarity-aware folded
    // matcher; Unicode lookalikes such as `pñs` must never authorize `pns`.
    || !objectiveNamesRemoteEndpoint(server, [segment])
    || !explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(server, segment)) {
    return undefined;
  }
  return segment;
}

function hasTargetBoundOperationalTechnicalReadAuthority(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  return targetBoundOperationalTechnicalReadAuthoritySegment(input, objectiveSegments) !== undefined;
}

function normalizedRemoteProjectIdentity(value: string): string {
  const withoutDigestOrTag = value.split('@', 1)[0]!.replace(/:[^/]+$/, '');
  let identity = (withoutDigestOrTag.split('/').filter(Boolean).at(-1) ?? '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
  // These suffixes describe the role/artifact family rather than a sibling
  // project. Strip them repeatedly so `sample-app` binds to endpoint `sample`,
  // while `pns-other` remains distinct and fails closed.
  let previous = '';
  while (identity !== previous) {
    previous = identity;
    identity = identity.replace(/(?:application|service|server|worker|generator|gen|app)$/u, '');
  }
  return identity;
}

function remoteProjectTargetMatchesEndpoint(target: string, endpoint: string): boolean {
  return normalizedRemoteProjectIdentity(target)
    === endpoint.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function explicitDockerRegistryFromImageTarget(target: string): string | undefined {
  const firstSlash = target.indexOf('/');
  if (firstSlash <= 0) return undefined;
  const registry = target.slice(0, firstSlash).toLowerCase();
  // Docker treats the first component as a registry only when it is an exact
  // hostname/IP (or localhost), optionally followed by a literal port.
  const match = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*)(?::([1-9]\d{0,4}))?$/u.exec(registry);
  if (!match || !registry.includes('.') && !registry.includes(':') && registry !== 'localhost') {
    return undefined;
  }
  const port = match[2] === undefined ? undefined : Number(match[2]);
  return port !== undefined && port > 65_535 ? undefined : registry;
}

function objectiveExplicitlyAuthorizesDockerRegistry(
  registry: string,
  segment: string,
): boolean {
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const declaration = /\b(?:registre|registry)\s+(?:(?:docker|exacte?)\s+){0,2}(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::[1-9]\d{0,4})?)/gu;
  for (const match of normalized.matchAll(declaration)) {
    const candidate = match[1];
    if (!candidate || candidate !== registry || match.index === undefined) continue;
    const relativeIndex = match[0].lastIndexOf(candidate);
    const index = match.index + relativeIndex;
    if (relativeIndex >= 0
      && !boundedSoftwareTargetOccurrenceIsNegated(
        normalized,
        index,
        candidate.length,
      )) return true;
  }
  return false;
}

function remotePathMatchesOperationalObjective(
  remotePath: string,
  endpoint: string,
  segment: string,
): boolean {
  const roots = explicitBoundedSoftwareRemoteRoots(segment);
  if (roots.excluded.some(root => remotePathIsWithinRoot(remotePath, root))) return false;
  if (roots.authorized.length > 0) {
    return boundedSoftwareTupleAuthorizesRemotePath(segment, endpoint, remotePath);
  }
  const projectDirectory = remotePath.startsWith('/srv/')
    ? remotePath.slice('/srv/'.length).split('/')[0] ?? ''
    : '';
  return !!projectDirectory && remoteProjectTargetMatchesEndpoint(projectDirectory, endpoint);
}

function staticSourceInspectionRemotePath(command: string): string | undefined {
  const match = /(?:^|\s)(\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044})(?:\s|$)/u.exec(command);
  return match?.[1];
}

function boundedStructuredRemoteExecutionInput(input: Record<string, unknown>): boolean {
  if (Object.keys(input).some(key => ![
    'server', 'command', 'cwd', 'timeout', '_displayName', '_intent',
  ].includes(key))) return false;
  return input.timeout === undefined
    || (typeof input.timeout === 'number' && Number.isInteger(input.timeout)
      && input.timeout >= 1 && input.timeout <= 300_000);
}

/** Orion's DEV manager keeps task checkouts under /opt. Admit only its
 * canonical integration checkout for reads and a two-component task worktree
 * for reads or writes. The shared integration checkout is never an upload
 * destination. */
function managedDevOrionPath(path: string, taskOnly = false): boolean {
  const task = /^\/opt\/ia-webdev\/agent-dev\/worktrees\/orion\/[a-z0-9][a-z0-9-]{0,63}(?:\/|$)/u.test(path);
  return task || !taskOnly
    && /^\/opt\/ia-webdev\/agent-dev\/integration\/orion(?:\/|$)/u.test(path);
}

/** One task-bound Orion edit or named check through the audited DEV executor.
 * The sensitive-action classifier has already proved the whole shell graph is
 * a bounded implementation command; this adds the exact human target grant.
 * Keep script/control-file edits on the existing bounded upload path. */
function isBoundedOrionWorktreeCommand(
  toolName: string,
  input: Record<string, unknown>,
  boundedLifecycle: boolean,
  objectiveSegments: readonly string[],
): boolean {
  if (toolName !== 'mcp__rbw-servers__ssh_execute' || !boundedLifecycle
    || Object.keys(input).some(key => !['server', 'cwd', 'command', 'timeout', '_displayName', '_intent'].includes(key))
    || input.server !== 'dev' || typeof input.cwd !== 'string'
    || !/^\/opt\/ia-webdev\/agent-dev\/worktrees\/orion\/[a-z0-9][a-z0-9-]{0,63}$/u.test(input.cwd)
    || typeof input.command !== 'string') return false;
  const command = input.command;
  const namedCheck = /^bun (?:run )?(?:test|check|typecheck|verify|scripts\/[A-Za-z0-9_./-]+)(?::[a-z0-9][a-z0-9:-]{0,79})?(?: [A-Za-z0-9_./ -]+)?$/u.test(command);
  const sourceEdit = /^sed -i '[^'\r\n]{1,4096}' (?:apps|packages|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx)$/u.test(command);
  if (!namedCheck && !sourceEdit) return false;
  const latest = [...objectiveSegments].reverse().find(segment => (
    normalizeUserInstructionForChannelMatch(segment).length > 0
      && !isNonSubstantiveBoundedSoftwareFollowUp(segment)
  ));
  return !!latest && !isQuotedOrReportedBoundedSoftwareContract(latest)
    && !boundedSoftwareMutationIsRevoked(boundedSoftwareInstructionPhases(latest))
    && detectHighStakesEvidenceDomain(latest) === undefined
    && explicitlyAuthorizesStructuredRemoteReadChannel(latest)
    && explicitlyAuthorizesBoundedSoftwareMutationScope(latest, 'dev', input.cwd);
}

function boundedRemoteCwd(
  input: Record<string, unknown>,
  endpoint: string,
  segment: string,
): string | undefined {
  const raw = input.cwd;
  if (typeof raw !== 'string' || raw !== raw.trim()
    || !raw.startsWith('/srv/') && !(endpoint === 'dev' && managedDevOrionPath(raw))
    || raw.length > 2_048 || /[$`*?[\]{}~\0\r\n]/u.test(raw)) return undefined;
  const parts = raw.slice(1).split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return undefined;
  if (remotePathMatchesOperationalObjective(raw, endpoint, segment)) return raw;
  // Production resume prompts use one authenticated, literal tuple in this
  // exact form. Bind it directly rather than relying on prose phase pairing.
  const tuple = /P[ée]rim[eè]tre autoris[ée] exact\s*:\s*serveur\s+`([a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255})`\s*,\s*d[ée]p[oô]t\s+`(\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044})`/iu.exec(segment);
  return tuple?.[1]?.toLowerCase() === endpoint.toLowerCase() && tuple[2] === raw
    ? raw : undefined;
}

function resolveBoundedRemotePath(cwd: string, path: string): string | undefined {
  const resolved = path.startsWith('/') ? resolve(path) : resolve(cwd, path);
  if (!resolved.startsWith('/srv/') && !managedDevOrionPath(resolved)
    || resolved.length > 2_048
    || !remotePathIsWithinRoot(resolved, cwd)) return undefined;
  return resolved;
}

function isSignedResumeSegment(segment: string): boolean {
  return /^\[robb-resume:[A-Za-z0-9][A-Za-z0-9:._-]{1,300}\]$/mu.test(segment);
}

/** Resolve a closed live-resume grant only when no newer authenticated human
 * segment has replaced or revoked it. A target-free "continue" can preserve
 * the exact contract; every substantive later instruction owns the authority
 * boundary and must restate a new closed grant. */
function latestSignedResumeAuthoritySegment(
  objectiveSegments: readonly string[],
): string | undefined {
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    if (!segment.trim()) continue;
    if (isTargetFreeGenericContinuation(segment)) continue;
    return isSignedResumeSegment(segment) ? segment : undefined;
  }
  return undefined;
}

function objectiveSegmentPositivelyMentionsAny(
  segment: string,
  literals: readonly string[],
): boolean {
  let latest: { index: number; length: number } | undefined;
  for (const literal of literals) {
    const index = segment.lastIndexOf(literal);
    if (index >= 0 && (!latest || index > latest.index)) latest = { index, length: literal.length };
  }
  return !!latest
    && !boundedSoftwareTargetOccurrenceIsNegated(segment, latest.index, latest.length);
}

function resumedRemoteReadCommandMatchesObjective(
  command: string,
  cwd: string,
  segment: string,
): boolean {
  if (!isSignedResumeSegment(segment)) return false;

  const bunTest = /^bun run (test:[A-Za-z0-9:_-]{1,160})$/u.exec(command);
  if (bunTest) return objectiveSegmentPositivelyMentionsAny(segment, [`\`${command}\``]);

  const curl = /^curl --fail-with-body --silent --show-error --max-time ([1-9]\d{0,2}) (https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(\/[A-Za-z0-9_./-]{1,1024}))$/u.exec(command);
  if (curl) {
    const project = cwd.slice('/srv/workspace/'.length).split('/')[0];
    return cwd.startsWith('/srv/workspace/')
      && !!project
      && [...segment.matchAll(/https:\/\/([a-z0-9.-]+)(?=[:\/\s`])/gu)].some(match => (
        match[1] === curl[3]
        && objectiveSegmentPositivelyMentionsAny(segment, [match[0]])
      ))
      && objectiveSegmentPositivelyMentionsAny(segment, [
        `GET ${curl[4]}`,
        `\`${curl[4]}\``,
      ]);
  }

  const readlink = /^readlink -f ((?:\.\/)?[A-Za-z0-9_@%+=,./()\-]{1,1900}\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service))$/u.exec(command);
  if (readlink) return resolveBoundedRemotePath(cwd, readlink[1]!) !== undefined;

  const compose = /^docker compose -f ((?:\.\/)?[A-Za-z0-9_@%+=,./()\-]{1,1900}\.ya?ml) ps$/iu.exec(command);
  if (compose) return resolveBoundedRemotePath(cwd, compose[1]!) !== undefined;

  const envNames = /^docker inspect --format '\{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\}' ([a-z0-9][a-z0-9_.-]{0,127}) \| sed 's\/=\.\*\/\/' \| sort$/u.exec(command);
  if (envNames) {
    const project = cwd.slice('/srv/workspace/'.length).split('/')[0];
    return cwd.startsWith('/srv/workspace/') && !!project
      && (envNames[1] === project || envNames[1]!.startsWith(`${project}-`));
  }

  const hardenedGitPrefix = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager ';
  if (command === `${hardenedGitPrefix}log -1 --format='%H %cI %s'`) return true;
  return command.startsWith(hardenedGitPrefix)
    && !command.includes(' -C ')
    && isProvablyReadOnlyShellCommand(command);
}

function isBoundedJsonData(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'boolean'
    || typeof value === 'string' && value.length <= 8_192
    || typeof value === 'number' && Number.isFinite(value)) return true;
  if (depth >= 6 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= 128
    && value.every(item => isBoundedJsonData(item, depth + 1));
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 32 && entries.every(([key, item]) => (
      key.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key)
        && isBoundedJsonData(item, depth + 1)
    ));
  } catch {
    return false;
  }
}

function isBoundedSharePointColumnFacet(type: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facet = value as Record<string, unknown>;
  const keysAre = (allowed: readonly string[]) => (
    Object.keys(facet).every(key => allowed.includes(key))
  );
  const optionalBoolean = (key: string) => (
    facet[key] === undefined || typeof facet[key] === 'boolean'
  );
  const optionalBoundedInteger = (key: string, minimum: number, maximum: number) => (
    facet[key] === undefined
      || typeof facet[key] === 'number'
        && Number.isInteger(facet[key])
        && facet[key] >= minimum
        && facet[key] <= maximum
  );

  if (type === 'boolean') return Object.keys(facet).length === 0;
  if (type === 'choice') {
    return keysAre(['allowTextEntry', 'choices', 'displayAs'])
      && optionalBoolean('allowTextEntry')
      && (facet.choices === undefined || Array.isArray(facet.choices)
        && facet.choices.length > 0 && facet.choices.length <= 128
        && facet.choices.every(choice => typeof choice === 'string'
          && choice.length > 0 && choice.length <= 255 && !/\0/u.test(choice)))
      && (facet.displayAs === undefined
        || typeof facet.displayAs === 'string'
          && ['checkBoxes', 'dropDownMenu', 'radioButtons'].includes(facet.displayAs));
  }
  if (type === 'personOrGroup') {
    return keysAre(['allowMultipleSelection', 'chooseFromType', 'displayAs'])
      && optionalBoolean('allowMultipleSelection')
      && (facet.chooseFromType === undefined
        || typeof facet.chooseFromType === 'string'
          && ['peopleAndGroups', 'peopleOnly'].includes(facet.chooseFromType))
      && (facet.displayAs === undefined
        || typeof facet.displayAs === 'string' && [
          'account', 'department', 'id', 'name', 'nameWithPicture',
          'nameWithPictureAndDetails', 'nameWithPresence', 'sipAddress',
          'title', 'userName', 'workPhone',
        ].includes(facet.displayAs));
  }
  if (type === 'text') {
    return keysAre([
      'allowMultipleLines', 'appendChangesToExistingText', 'linesForEditing',
      'maxLength', 'textType',
    ])
      && optionalBoolean('allowMultipleLines')
      && optionalBoolean('appendChangesToExistingText')
      && optionalBoundedInteger('linesForEditing', 1, 1_000)
      && optionalBoundedInteger('maxLength', 1, 1_000_000)
      && (facet.textType === undefined
        || typeof facet.textType === 'string'
          && ['plain', 'richText'].includes(facet.textType));
  }
  if (type === 'dateTime') {
    return keysAre(['displayAs', 'format'])
      && (facet.displayAs === undefined
        || typeof facet.displayAs === 'string'
          && ['default', 'friendly', 'standard'].includes(facet.displayAs))
      && (facet.format === undefined
        || typeof facet.format === 'string'
          && ['dateOnly', 'dateTime'].includes(facet.format));
  }
  if (type === 'number') {
    const minimum = facet.minimum;
    const maximum = facet.maximum;
    return keysAre(['decimalPlaces', 'displayAs', 'maximum', 'minimum'])
      && (facet.decimalPlaces === undefined
        || typeof facet.decimalPlaces === 'string' && [
          'automatic', 'none', 'one', 'two', 'three', 'four', 'five',
        ].includes(facet.decimalPlaces))
      && (facet.displayAs === undefined
        || typeof facet.displayAs === 'string'
          && ['number', 'percentage'].includes(facet.displayAs))
      && (minimum === undefined || typeof minimum === 'number' && Number.isFinite(minimum))
      && (maximum === undefined || typeof maximum === 'number' && Number.isFinite(maximum))
      && !(typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum);
  }
  return false;
}

interface BoundedResumedSharePointCreationContract {
  segment: string;
  site: string;
  listName: string;
  driveId?: string;
  folderName?: string;
}

function boundedResumedSharePointCreationContract(
  objectiveSegments: readonly string[],
): BoundedResumedSharePointCreationContract | undefined {
  const segment = latestSignedResumeAuthoritySegment(objectiveSegments);
  if (!segment || !/Microsoft Graph\s*\/\s*API/u.test(segment)
    || !/Cr[ée]e par API/u.test(segment)
    || /\b(?:(?:ne|n['’])\s+cr[ée]\w*[^.!?;\n]{0,48}\b(?:pas|jamais|plus)|(?:do\s+not|don't|never)\s+create|sans\s+cr[ée]ation)\b/iu.test(segment)) return undefined;
  const site = /cible exacte[^`\r\n]{0,120}`([a-z0-9.-]+,[a-f0-9-]{36},[a-f0-9-]{36})`/iu.exec(segment)?.[1];
  const listName = /(?:liste|list)[^`\r\n]{0,220}(?:d[ée]di[ée]e?|dedicated)[^`\r\n]{0,80}`([^`\r\n]{1,255})`/iu.exec(segment)?.[1];
  if (!site || !listName) return undefined;
  return {
    segment,
    site,
    listName,
    driveId: /^Drive documentaire exact\s*:\s*`([A-Za-z0-9_!-]{10,255})`\s*$/imu.exec(segment)?.[1],
    folderName: /^Dossier documentaire exact\s*:\s*`([^`\r\n]{1,255})`\s*$/imu.exec(segment)?.[1],
  };
}

function isBoundedResumedSharePointCreation(
  toolName: string,
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
): boolean {
  if (toolName !== 'mcp__plc-microsoft-365__graph_request'
    || input.method !== 'POST'
    || Object.keys(input).some(key => ![
      'method', 'endpoint', 'body', '_displayName', '_intent',
    ].includes(key))) return false;
  const contract = boundedResumedSharePointCreationContract(objectiveSegments);
  if (!contract) return false;
  const { driveId, folderName, listName, site } = contract;
  const body = input.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !isBoundedJsonData(body)) return false;
  const record = body as Record<string, unknown>;
  if (typeof input.endpoint === 'string' && input.endpoint.startsWith('drives/')) {
    const folder = record.folder;
    return !!driveId && !!folderName
      && folderName === folderName.trim()
      && folderName !== '.' && folderName !== '..'
      && !/[\/\\\0]/u.test(folderName)
      && input.endpoint === `drives/${driveId}/root/children`
      && Object.keys(record).length === 3
      && record.name === folderName
      && record['@microsoft.graph.conflictBehavior'] === 'fail'
      && !!folder && typeof folder === 'object' && !Array.isArray(folder)
      && Object.keys(folder).length === 0;
  }
  if (input.endpoint !== `sites/${site}/lists`) return false;
  if (Object.keys(record).some(key => !['displayName', 'description', 'columns', 'list'].includes(key))
    || record.displayName !== listName
    || typeof record.description !== 'string' || record.description.length > 8_192) return false;
  const list = record.list;
  if (!list || typeof list !== 'object' || Array.isArray(list)
    || Object.keys(list).length !== 1
    || (list as Record<string, unknown>).template !== 'genericList') return false;
  // The list creation must be atomic. Allowing the empty-list retry would
  // strand the mission on later opaque `/lists/{id}/columns` mutations whose
  // discovered ID is not present in the authenticated human objective.
  if (!Array.isArray(record.columns) || record.columns.length === 0
    || record.columns.length > 100) return false;
  const typeKeys = new Set([
    'boolean', 'choice', 'personOrGroup', 'text', 'dateTime', 'number',
  ]);
  return record.columns.every(column => {
    if (!column || typeof column !== 'object' || Array.isArray(column)) return false;
    const item = column as Record<string, unknown>;
    if (Object.keys(item).some(key => ![
      'name', 'displayName', 'description', 'required', ...typeKeys,
    ].includes(key))) return false;
    if (typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.name)
      || typeof item.displayName !== 'string' || item.displayName.length > 255
      || item.description !== undefined && (typeof item.description !== 'string'
        || item.description.length > 4_096)
      || item.required !== undefined && typeof item.required !== 'boolean') return false;
    const selectedTypes = Object.keys(item).filter(key => typeKeys.has(key));
    return selectedTypes.length === 1
      && isBoundedSharePointColumnFacet(selectedTypes[0]!, item[selectedTypes[0]!]);
  });
}

function operationalInspectionMatchesObjective(
  inspection: BoundedTargetedRemoteOperationalInspection,
  endpoint: string,
  segment: string,
): boolean {
  if (inspection.kind === 'http') {
    if (inspection.followsRedirects || inspection.method !== 'GET') return false;
    let url: URL;
    try { url = new URL(inspection.url); } catch { return false; }
    if (url.protocol !== 'http:' || url.port !== '8888'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
      || url.username || url.password || url.search || url.hash
      || endpoint.toLowerCase() !== 'pns') return false;
    const route = /^\/api\/v1\/edoc-optimized\/status\/([1-9]\d{0,18})\/?$/u.exec(url.pathname);
    if (!route) return false;
    const identifiers: string[] = normalizeUserInstructionForChannelMatch(segment)
      .match(/[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g) ?? [];
    return identifiers.includes(route[1]!);
  }
  if (inspection.kind === 'docker-compose') {
    return remotePathMatchesOperationalObjective(inspection.path, endpoint, segment);
  }
  if (inspection.kind === 'docker-manifest') {
    const registry = explicitDockerRegistryFromImageTarget(inspection.target);
    return !!registry
      && objectiveExplicitlyAuthorizesDockerRegistry(registry, segment)
      && remoteProjectTargetMatchesEndpoint(inspection.target, endpoint);
  }
  if (inspection.output === 'unsafe') return false;
  const targets = inspection.targets;
  return targets.every((target) => {
    if (!remoteProjectTargetMatchesEndpoint(target, endpoint)) return false;
    // A locally named image (`sample-app:local`) is resolved only from the
    // target daemon and remains useful as deployment evidence. Once a target
    // carries an explicit registry qualifier, bind that registry exactly to
    // the human objective just like `docker manifest inspect`; matching only
    // the trailing project basename could otherwise attest the wrong image.
    const registry = explicitDockerRegistryFromImageTarget(target);
    return registry === undefined
      || objectiveExplicitlyAuthorizesDockerRegistry(registry, segment);
  });
}

/** The configured SSH connector may open an observational transport or copy a
 * technical source into this session's isolated data folder. Bind that read
 * authority to the explicitly named server; discovered source paths under the
 * target inherit it, but arbitrary destinations, secret-like files and every
 * remote write remain outside this exception. */
function isBoundedStructuredRemoteTechnicalRead(
  toolName: string,
  input: Record<string, unknown>,
  dataFolderPath: string | undefined,
  objectiveSegments: readonly string[],
): boolean {
  const rawServer = typeof input.server === 'string' ? input.server : '';
  const server = rawServer.trim();
  if (rawServer !== server || !isCanonicalRemoteEndpoint(server)) return false;
  const authoritySegment = targetBoundOperationalTechnicalReadAuthoritySegment(input, objectiveSegments);
  if (!authoritySegment) return false;
  if (toolName === 'mcp__rbw-servers__ssh_execute') {
    if (!boundedStructuredRemoteExecutionInput(input)) return false;
    const command = typeof input.command === 'string' ? input.command : '';
    const operationalInspection = classifyBoundedTargetedRemoteOperationalInspection(command);
    if (operationalInspection) {
      return operationalInspectionMatchesObjective(operationalInspection, server, authoritySegment);
    }
    if (isBoundedRemoteStaticSourceInspection(command)) {
      const remotePath = staticSourceInspectionRemotePath(command);
      return !!remotePath && remotePathMatchesOperationalObjective(
        remotePath,
        server,
        authoritySegment,
      );
    }
    const cwd = boundedRemoteCwd(input, server, authoritySegment);
    if (!cwd) return false;
    const sourcePaths = remoteStaticSourceInspectionLiteralPaths(command);
    if (sourcePaths) {
      return sourcePaths.every(sourcePath => !!resolveBoundedRemotePath(cwd, sourcePath));
    }
    const sourcePath = remoteStaticSourceInspectionLiteralPath(command);
    if (sourcePath) {
      const remotePath = resolveBoundedRemotePath(cwd, sourcePath);
      // `boundedRemoteCwd` already proved the exact server/root tuple and the
      // resolver confines this one literal source path below that root.
      return !!remotePath;
    }
    return resumedRemoteReadCommandMatchesObjective(
      command,
      cwd,
      authoritySegment,
    );
  }
  if (toolName === 'mcp__rbw-servers__ssh_session_start') {
    if (Object.keys(input).some(key => !['server', 'name', '_displayName', '_intent'].includes(key))) {
      return false;
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
  }
  if (toolName !== 'mcp__rbw-servers__ssh_download' || !dataFolderPath) return false;
  if (Object.keys(input).some(key => ![
    'server', 'remotePath', 'localPath', '_displayName', '_intent',
  ].includes(key))) return false;
  const remotePath = typeof input.remotePath === 'string' ? input.remotePath.trim() : '';
  const localPath = typeof input.localPath === 'string' ? input.localPath.trim() : '';
  const remoteSegments = remotePath.startsWith('/srv/')
    ? remotePath.slice('/srv/'.length).split('/')
    : [];
  if (!/^\/srv\/[A-Za-z0-9_@%+=:,./()\-]{1,2044}\.(?:c?js|mjs|ts|tsx|json|sql|ya?ml|toml|ini|conf|md|service)$/i.test(remotePath)
    || remoteSegments.length === 0
    || remoteSegments.some(segment => !segment || segment === '.' || segment === '..')
    || /(?:^|\/)(?:\.env(?:\.[^\/]*)?|\.ssh|secret[^\/]*|credentials?[^\/]*|private[_-]?key[^\/]*)(?=\/|$)/i.test(remotePath)) {
    return false;
  }
  if (!remotePathMatchesOperationalObjective(remotePath, server, authoritySegment)) return false;
  const dataRoot = resolve(dataFolderPath);
  const destination = resolve(localPath);
  if (destination === dataRoot || !isPathWithinDirectory(destination, dataRoot)) return false;
  try {
    // A replaced data root or a symlink/hardlink leaf could turn this local
    // observation artifact into a write outside the session (including the
    // installed application bundle). Keep the downgrade to read-only limited
    // to a real session directory and an ordinary confined destination.
    const rootStat = lstatSync(dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const canonicalRoot = realpathSync.native(dataRoot);
    if (isProtectedApplicationPath(canonicalRoot)) return false;
    if (existsSync(destination)) {
      const destinationStat = lstatSync(destination);
      if (!destinationStat.isFile()
        || destinationStat.isSymbolicLink()
        || destinationStat.nlink !== 1) return false;
    }
  } catch {
    return false;
  }
  return true;
}

const BOUNDED_SOFTWARE_REMOTE_PATH_PATTERN = /\/(?:srv|opt|var|etc|workspace|app|apps)(?:\/[A-Za-z0-9_@%+=:.-]+)+/g;
const BOUNDED_SOFTWARE_MUTATION_SOURCE = String.raw`(?:apply|applique|appliquer|correct|corrige|corriger|fix|implement|impl[ée]mente|impl[ée]menter|modify|modifie|modifier|replace|remplace|remplacer|update|mets?\s+[àa]\s+jour|upload|uploade|uploader|deploy|d[ée]ploie|d[ée]ployer|redeploy|red[ée]ploie|red[ée]ployer|rebuild|reconstruis?|start|d[ée]marre|d[ée]marrer|restart|red[ée]marre|red[ée]marrer)`;
const BOUNDED_SOFTWARE_MUTATION_PATTERN = new RegExp(
  String.raw`\b${BOUNDED_SOFTWARE_MUTATION_SOURCE}\b`,
  'iu',
);
const BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN = /\b(?:read[- ]only|lecture\s+seule)\b/iu;
const BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN = /(?:\b(?:sans|without)\s+(?:aucune?|any)\s+(?:modifications?|mutations?|[ée]critures?|writes?|changes?)\b|\b(?:aucune?|no)\s+(?:(?:nouvelle|nouvel|nouvelles|nouveaux|autre|autres|further|additional)\s+)?(?:modifications?|mutations?|[ée]critures?|writes?|changes?)\b|\b(?:ne|n['’])\s+(?:modifi\w*|chang\w*|[ée]cri\w*|t[ée]l[ée]vers\w*|upload\w*|d[ée]ploi\w*)\s+(?:(?:absolument|plus|pas|jamais)\s+)?rien\b|\b(?:do\s+not|don't|never)\s+(?:modify|change|write|upload|deploy)\s+(?:anything|anything\s+else)\b)/iu;
const BOUNDED_SOFTWARE_OBSERVATION_PHASE_PATTERN = /\b(?:inspect|inspecte|inspecter|diagnos|diagnostique|diagnostiquer|analyse|analyze|observe|check|verifie|v[ée]rifie|valide|validate|lis|lire|read)\w*\b/iu;
const BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN = /\b(?:cible|cibler|target|scope|p[ée]rim[eè]tre)\b/iu;
const BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN = /\b(?:serveur|server|h[oô]te|host)\s+[a-z0-9]/iu;

interface BoundedSoftwareRemoteRootOccurrence {
  path: string;
  index: number;
  rawLength: number;
  negated: boolean;
}

interface BoundedSoftwareRemoteEndpointOccurrence {
  endpoint: string;
  index: number;
  end: number;
}

interface BoundedSoftwareRemoteTargetTuple {
  endpoint: string;
  root: string;
}

function boundedSoftwareInstructionPhases(segment: string): string[] {
  const coarsePhases = segment.split(
    /[!?;\n]+|[.](?=\s|$)|,\s*(?=(?:puis|ensuite|then|afterwards)\b)|\b(?:puis|then)\b/iu,
  ).map(phase => phase.trim()).filter(Boolean);
  const mutationTransition = new RegExp(
    String.raw`\b(?:(?:et|and)(?:\s+(?:ensuite|afterwards))?|avant\s+de|before)\s+(?=\b${BOUNDED_SOFTWARE_MUTATION_SOURCE}\b)`,
    'giu',
  );
  return coarsePhases.flatMap((phase) => {
    const parts: string[] = [];
    let cursor = 0;
    for (const match of phase.matchAll(mutationTransition)) {
      if (match.index === undefined) continue;
      const nextStart = match.index + match[0].length;
      // Split only when the tail independently carries positive mutation
      // authority. A negative tail such as “and do not modify anything” is a
      // revocation, not a phase transition that may revive upload authority.
      if (!explicitlyAuthorizesBoundedSoftwareMutationClause(phase.slice(nextStart))) continue;
      const before = phase.slice(cursor, match.index).trim();
      if (before) parts.push(before);
      cursor = nextStart;
    }
    const tail = phase.slice(cursor).trim();
    if (tail) parts.push(tail);
    return parts;
  });
}

function boundedSoftwareMutationIsRevoked(phases: readonly string[]): boolean {
  if (!phases.some(explicitlyAuthorizesBoundedSoftwareMutationClause)) return true;
  return phases.some((phase) => {
    const readOnly = BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN.test(phase);
    const explicitRevocation = BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN.test(phase);
    if (!readOnly && !explicitRevocation) return false;
    const scopedObservation = BOUNDED_SOFTWARE_OBSERVATION_PHASE_PATTERN.test(phase)
      && !explicitlyAuthorizesBoundedSoftwareMutationClause(phase);
    // “Inspect first in read-only mode, then fix” constrains only the earlier
    // observation phase. A final “verify read-only” is likewise a verification
    // constraint, not a retroactive cancellation of the requested mutation.
    if (scopedObservation) return false;
    return true;
  });
}

function boundedSoftwareTargetOccurrenceIsNegated(
  text: string,
  start: number,
  length: number,
): boolean {
  const before = normalizeUserInstructionForChannelMatch(
    text.slice(Math.max(0, start - 96), start),
  );
  const after = normalizeUserInstructionForChannelMatch(
    text.slice(start + length, start + length + 64),
  );
  return /(?:\b(?:not|no|never|without|except|excluding|exclude|forbidden|outside|hors|sauf|sans|pas|jamais|ni|exclu|interdit)\b|\b(?:do\s+not|don't)\b|\b(?:ne|n')\b[^,.!?;\n]{0,48}\b(?:pas|jamais|ni)\b)[^,.!?;\n]{0,48}$/u.test(before)
    || /^(?:(?:server|serveur|root|racine)\s+)?(?:(?:is|est|reste|doit\s+etre|must\s+be)\s+)?(?:explicitement\s+|explicitly\s+)?(?:excluded|exclu(?:e|es|s)?|forbidden|interdit(?:e|es|s)?|hors\s+perimetre|out\s+of\s+scope)\b/u.test(after);
}

function explicitlyAuthorizesBoundedSoftwareMutationClause(clause: string): boolean {
  if (!BOUNDED_SOFTWARE_MUTATION_PATTERN.test(clause)) return false;
  const normalized = normalizeUserInstructionForChannelMatch(clause);
  return !/\b(?:do\s+not|don't|never|sans)\b[^.!?;\n]{0,120}\b(?:apply|correct|fix|implement|modify|replace|update|upload|deploy|redeploy|rebuild|start|restart)\b/u.test(normalized)
    && !/\b(?:ne|n)\b[^.!?;\n]{0,120}\b(?:pas|jamais|plus|rien)\b/u.test(normalized)
    && !/\b(?:apply|applique\w*|correct|corrig\w*|fix|implement\w*|modify|modifi\w*|replace|remplac\w*|update|upload\w*|deploy\w*|deploi\w*|redeploy\w*|redeploi\w*|rebuild|reconstrui\w*|start|demarr\w*|restart|redemarr\w*)\b[^.!?;\n]{0,24}\b(?:nothing|rien|pas|jamais)\b/u.test(normalized);
}

function boundedSoftwareRemotePathIsDirectlyQuoted(
  segment: string,
  index: number,
  rawLength: number,
): boolean {
  const before = segment[index - 1];
  const after = segment[index + rawLength];
  return (before === '`' && after === '`')
    || (before === '"' && after === '"')
    || (before === "'" && after === "'")
    || (before === '«' && after === '»')
    || (before === '“' && after === '”')
    || (before === '‘' && after === '’');
}

function explicitBoundedSoftwareRemoteRootOccurrences(
  segment: string,
): BoundedSoftwareRemoteRootOccurrence[] {
  const occurrences: BoundedSoftwareRemoteRootOccurrence[] = [];
  for (const match of segment.matchAll(BOUNDED_SOFTWARE_REMOTE_PATH_PATTERN)) {
    const rawPath = match[0];
    const index = match.index;
    if (index === undefined) continue;
    // A period/comma at an unquoted prose boundary terminates the locator; the
    // same character inside a directly quoted path remains part of the path.
    // Do not alter the accepted path alphabet or normalize punctuation inside
    // the locator itself.
    const path = boundedSoftwareRemotePathIsDirectlyQuoted(
      segment,
      index,
      rawPath.length,
    ) ? rawPath : rawPath.replace(/[.,]+$/u, '');
    const parts = path.split('/').slice(1);
    if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) continue;
    occurrences.push({
      path,
      index,
      rawLength: rawPath.length,
      negated: boundedSoftwareTargetOccurrenceIsNegated(segment, index, rawPath.length),
    });
  }
  return occurrences;
}

function explicitBoundedSoftwareRemoteRoots(segment: string): {
  authorized: string[];
  excluded: string[];
} {
  const authorized: string[] = [];
  const excluded: string[] = [];
  for (const occurrence of explicitBoundedSoftwareRemoteRootOccurrences(segment)) {
    (occurrence.negated ? excluded : authorized).push(occurrence.path);
  }
  return { authorized, excluded };
}

function explicitBoundedSoftwareRemoteEndpointOccurrences(
  clause: string,
): BoundedSoftwareRemoteEndpointOccurrence[] {
  const occurrences: BoundedSoftwareRemoteEndpointOccurrence[] = [];
  const pattern = /\b(?:serveur|server|h[oô]te|host)\s+(?:exacte?\s+)?([a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255})/giu;
  for (const match of clause.matchAll(pattern)) {
    const endpoint = match[1]?.toLowerCase();
    if (!endpoint || match.index === undefined || !isCanonicalRemoteEndpoint(endpoint)) continue;
    const relativeIndex = match[0].toLowerCase().lastIndexOf(endpoint);
    const index = match.index + relativeIndex;
    if (relativeIndex < 0
      || boundedSoftwareTargetOccurrenceIsNegated(clause, index, endpoint.length)) continue;
    occurrences.push({ endpoint, index, end: index + endpoint.length });
  }
  return occurrences;
}

function explicitBoundedSoftwareRemoteTargetTuples(
  segment: string,
): BoundedSoftwareRemoteTargetTuple[] {
  const tuples: BoundedSoftwareRemoteTargetTuple[] = [];
  for (const clause of boundedSoftwareInstructionPhases(segment)) {
    const endpoints = explicitBoundedSoftwareRemoteEndpointOccurrences(clause);
    const roots = explicitBoundedSoftwareRemoteRootOccurrences(clause)
      .filter(root => !root.negated);
    if (endpoints.length === 0 || roots.length === 0) continue;

    if (endpoints.length === 1) {
      for (const root of roots) tuples.push({ endpoint: endpoints[0]!.endpoint, root: root.path });
      continue;
    }

    // With several endpoints, bind only a locally expressed pair. This avoids
    // treating two explicit pairs as the Cartesian product of all endpoints
    // and roots. Ambiguous shared-root prose remains fail-closed.
    for (const root of roots) {
      const following = endpoints.find((endpoint) => {
        if (endpoint.index < root.index + root.rawLength) return false;
        const relation = normalizeUserInstructionForChannelMatch(
          clause.slice(root.index + root.rawLength, endpoint.index),
        );
        return /^(?:sur|on)\s+(?:(?:le|la|the)\s+)?$/u.test(relation);
      });
      if (following) {
        tuples.push({ endpoint: following.endpoint, root: root.path });
        continue;
      }
      const preceding = [...endpoints].reverse().find((endpoint) => {
        if (endpoint.end > root.index) return false;
        const relation = normalizeUserInstructionForChannelMatch(
          clause.slice(endpoint.end, root.index),
        );
        return /^(?:[,=:]\s*)?(?:(?:dans|in|at|on|sur|sous|under|a|racine|root|path|chemin)\s*)?$/u.test(relation);
      });
      if (preceding) tuples.push({ endpoint: preceding.endpoint, root: root.path });
    }
  }
  return tuples.filter((tuple, index, all) => all.findIndex(candidate => (
    candidate.endpoint === tuple.endpoint && candidate.root === tuple.root
  )) === index);
}

function explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(
  endpoint: string,
  segment: string,
): boolean {
  if (!objectiveNamesRemoteEndpoint(endpoint, [segment])) return false;
  const normalized = normalizeUserInstructionForChannelMatch(segment);
  const identifiers = [...normalized.matchAll(
    /[a-z0-9](?:[a-z0-9_-]|[.:](?=[a-z0-9])){0,255}/g,
  )].filter(match => match[0] === endpoint.toLowerCase() && match.index !== undefined);
  return identifiers.length > 0
    && identifiers.every(match => !boundedSoftwareTargetOccurrenceIsNegated(
      normalized,
      match.index!,
      match[0].length,
    ));
}

function remotePathIsWithinRoot(remotePath: string, root: string): boolean {
  return remotePath === root || remotePath.startsWith(`${root}/`);
}

function boundedSoftwareTupleAuthorizesRemotePath(
  segment: string,
  endpoint: string,
  remotePath: string,
): boolean {
  const canonicalEndpoint = endpoint.toLowerCase();
  return explicitBoundedSoftwareRemoteTargetTuples(segment).some(tuple => (
    tuple.endpoint === canonicalEndpoint && remotePathIsWithinRoot(remotePath, tuple.root)
  ));
}

function explicitlyAuthorizesBoundedSoftwareMutationScope(
  segment: string,
  endpoint: string,
  remotePath: string,
): boolean {
  const clauses = boundedSoftwareInstructionPhases(segment);
  if (boundedSoftwareMutationIsRevoked(clauses)) return false;
  const declaredScopes = clauses.filter((clause) => {
    return BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN.test(clause)
      && explicitBoundedSoftwareRemoteTargetTuples(clause).length > 0;
  });
  const matchingDeclaredScopes = declaredScopes.filter((clause) => {
    return explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(endpoint, clause)
      && boundedSoftwareTupleAuthorizesRemotePath(clause, endpoint, remotePath);
  });

  return clauses.some((clause) => {
    if (!explicitlyAuthorizesBoundedSoftwareMutationClause(clause)) return false;
    const roots = explicitBoundedSoftwareRemoteRoots(clause);
    if (explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(endpoint, clause)
      && boundedSoftwareTupleAuthorizesRemotePath(clause, endpoint, remotePath)) {
      return true;
    }
    // A unique explicit scope declaration (“Cible … serveur + racine”) may
    // bind a later mutation clause only while that clause does not introduce
    // another endpoint or root. This preserves the concrete Orion wording but
    // prevents cross-pairing “Inspect dev/root-a. Fix pns/root-b.”.
    return roots.authorized.length === 0
      && roots.excluded.length === 0
      && !BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(clause)
      && declaredScopes.length === 1
      && matchingDeclaredScopes.length === 1;
  });
}

function isNonSubstantiveBoundedSoftwareFollowUp(segment: string): boolean {
  const normalized = normalizeUserInstructionForChannelMatch(segment)
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
  // A current stop or retarget overrides the previous execution scope.
  if (/^(?:(?:merci de|please) )?(?:arrete\w*|stop|cancel|annule\w*)\b|\bne (?:poursui\w*|continu\w*|reprend\w*)[^.!?;]{0,40}\b(?:pas|plus|jamais)\b|\b(?:cible|target|serveur|server|repertoire|directory) (?:devient|becomes)\b/u.test(normalized)) return false;
  if (/\b(?:sans|without|no)\s+(?:ssh|navigateur|browser|api)\b|\/srv\/|\b(?:continue\w*|reprend\w*|poursui\w*)\b[^.!?;]{0,40}\b(?:sur|on|dans|in|vers|to)\s+\S+/u.test(normalized)) return false;
  if (isTargetFreeGenericContinuation(segment)) return true;
  if (/^(?:ou en (?:es tu|sommes nous)|(?:quel(?:le)?s? (?:est|sont) )?(?:(?:le|la|les) )?(?:statut|avancement)|(?:(?:peux tu|pouvez vous|pourrais tu|pourriez vous) )?(?:(?:me|nous) )?(?:donner|donne|donnez|faire|fais|faites) (?:(?:moi|nous) )?(?:un|le) (?:point davancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/u.test(normalized)) {
    return true;
  }
  if (explicitlyAuthorizesStructuredRemoteReadChannel(segment) || BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(segment)) {
    return false;
  }
  const hasRevocation = BOUNDED_SOFTWARE_EXPLICIT_MUTATION_REVOCATION_PATTERN.test(segment)
    || /\b(?:ne\s+(?:modifi\w*|touche\w*|chang\w*|synchronis\w*|committ\w*|d[ée]ploi\w*)|don?['’]t\s+(?:modify|touch|change|sync|commit|deploy))\b/iu.test(segment)
    || BOUNDED_SOFTWARE_READ_ONLY_PHASE_PATTERN.test(segment);
  const hasScopeOrEndpoint = BOUNDED_SOFTWARE_SCOPE_DECLARATION_PATTERN.test(segment)
    || BOUNDED_SOFTWARE_ENDPOINT_DECLARATION_PATTERN.test(segment)
    || /\b(?:api|navigateur|browser|site|base|db|bdd)\s+(?:uniquement|only)\b/iu.test(segment);
  const isQuoted = isQuotedOrReportedBoundedSoftwareContract(segment);
  const isHighStakes = detectHighStakesEvidenceDomain(segment) !== undefined;
  if (!hasRevocation && !hasScopeOrEndpoint && !isQuoted && !isHighStakes) {
    if (/\b(?:corrige\w*|fix\w*|r[ée]pare\w*|relance\w*|rerun\w*|continue\w*|it[èe]re\w*|v[ée]rifie\w*|check\w*|test\w*|reprend\w*|poursui\w*|fais\w*|applique\w*|pourquoi\b|avance\w*|termine\w*|finish\w*)\b/iu.test(segment)) {
      return true;
    }
  }
  return false;
}

const PORTABLE_SESSION_PATH_TOKEN = '{{SESSION_PATH}}';
const BOUNDED_OSS_ATOMIC_WRITE_TOOL = 'mcp__rbw-agents-oss__oss_write_file';

function pathUsesSymbolicLinkBelowBoundary(path: string, boundary: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedBoundary = resolve(boundary);
  const canonicalBoundary = realpathSync.native(resolvedBoundary);
  const canonicalPath = realpathSync.native(resolvedPath);
  const lexicallyWithin = (target: string, base: string): boolean => {
    const candidate = relative(base, target);
    return candidate === '' || !candidate.startsWith('..') && !isAbsolute(candidate);
  };
  const inspectionBoundary = lexicallyWithin(resolvedPath, resolvedBoundary)
    ? resolvedBoundary
    : canonicalBoundary;
  const inspectionPath = lexicallyWithin(resolvedPath, inspectionBoundary)
    ? resolvedPath
    : canonicalPath;
  if (!lexicallyWithin(inspectionPath, inspectionBoundary)) return true;
  let current = inspectionPath;
  while (current !== inspectionBoundary) {
    if (lstatSync(current).isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
  return lstatSync(inspectionBoundary).isSymbolicLink();
}

function explicitPortableSessionDataRoots(segment: string): string[] {
  const roots = [...segment.matchAll(/`(\{\{SESSION_PATH\}\}\/data\/[^`\r\n]+)`/gu)]
    .map(match => match[1])
    .filter((value): value is string => {
      if (typeof value !== 'string'
        || !value.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/data/`)) return false;
      const suffix = value.slice(PORTABLE_SESSION_PATH_TOKEN.length);
      return posix.normalize(suffix) === suffix
        && !/[$`*?[\]{}~\\\0\r\n]/u.test(suffix)
        && !suffix.split('/').some((part, index) => index > 0
          && (!part || part === '.' || part === '..'));
    });
  return [...new Set(roots)];
}

/** A fully restated recovery contract can appear as inert payload inside a
 * report, example or analysis request. Those wrappers must not become fresh
 * upload authority merely because the embedded text contains every required
 * endpoint, path and mutation verb. Keep direct top-level contracts valid. */
function isQuotedOrReportedBoundedSoftwareContract(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (/```|~~~/u.test(trimmed)
    || /(?:^|\r?\n)\s*>/u.test(trimmed)
    || /^(?:[«“„])/u.test(trimmed)) return true;

  const normalized = normalizeUserInstructionForChannelMatch(trimmed);
  const resumeMarkers = [...normalized.matchAll(/\[robb-resume:[^\]]+\]/gu)];
  if (resumeMarkers.length > 1 || (resumeMarkers[0]?.index ?? 0) > 0) return true;
  const unwrapped = normalized.replace(/^\[robb-resume:[^\]]+\]\s*/u, '');

  return /^(?:(?:analyse|analyze|review|audite|audit|evalue|evaluate|explique|explain|resume|summarize)\b.{0,160}\b(?:prompt|instruction|texte|text|demande|request)\b|(?:(?:le|ce|un|the|this|a)\s+)?(?:rapport|report|exemple|example|sample|citation|quote|documentation|reference)\b|(?:voici|here is|ci dessous|below)\b.{0,120}\b(?:exemple|example|sample|prompt|instruction|citation|quote|rapport|report)\b|(?:a titre d exemple|pour reference(?: uniquement)?|for reference(?: only)?|quoted text|texte cite)\b)/u.test(unwrapped);
}

/** Direct upload authority for one current, fully restated software recovery
 * mission. Endpoint, destination root, audited channel and mutation verb all
 * come from the same newest human segment. This does not downgrade the tool's
 * external-mutation effect and therefore never bypasses evidence, permission,
 * application-protection or secret-transfer checks. */
function isBoundedStructuredRemoteTechnicalUpload(
  toolName: string,
  input: Record<string, unknown>,
  dataFolderPath: string | undefined,
  objectiveSegments: readonly string[],
  authenticatedUserAuthorizationSegments: readonly string[] = [],
): string | undefined {
  if (toolName !== 'mcp__rbw-servers__ssh_upload' || !dataFolderPath
    || Object.keys(input).some(key => ![
      'server', 'localPath', 'remotePath', '_displayName', '_intent',
    ].includes(key))) return undefined;
  const server = typeof input.server === 'string' ? input.server.trim() : '';
  const requestedLocalPath = typeof input.localPath === 'string' ? input.localPath.trim() : '';
  const remotePath = typeof input.remotePath === 'string' ? input.remotePath.trim() : '';
  if (!server || server !== input.server || !isCanonicalRemoteEndpoint(server)
    || !requestedLocalPath || requestedLocalPath !== input.localPath
    || !remotePath || remotePath !== input.remotePath
    || remotePath.length > 2_048
    || !remotePath.startsWith('/srv/')
      && !(server === 'dev' && managedDevOrionPath(remotePath, true))
    || /[$`*?[\]{}~\0\r\n]/u.test(remotePath)
    || remotePath.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..'))
    || isSensitiveRemoteTransferSource({ localPath: requestedLocalPath })
    || isSensitiveRemoteTransferSource({ localPath: remotePath })) {
    return undefined;
  }

  const sessionPath = resolve(dataFolderPath, '..');
  let localPath = requestedLocalPath;
  const portableSessionSource = requestedLocalPath.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/`);
  if (portableSessionSource) {
    const suffix = requestedLocalPath.slice(PORTABLE_SESSION_PATH_TOKEN.length);
    if (!suffix.startsWith('/data/') || posix.normalize(suffix) !== suffix
      || /[$`*?[\]{}~\\\0\r\n]/u.test(suffix)) return undefined;
    localPath = resolve(sessionPath, `.${suffix}`);
  } else if (requestedLocalPath.includes(PORTABLE_SESSION_PATH_TOKEN)) {
    return undefined;
  }

  const newestApplicableSegment = [...objectiveSegments].reverse().find(segment => (
    normalizeUserInstructionForChannelMatch(segment).length > 0
      && !isNonSubstantiveBoundedSoftwareFollowUp(segment)
  ));
  if (!newestApplicableSegment
    || isQuotedOrReportedBoundedSoftwareContract(newestApplicableSegment)
    || detectHighStakesEvidenceDomain(newestApplicableSegment) !== undefined
    || !isConcreteOperationalSoftwareRestatement(newestApplicableSegment)
    || !explicitlyAuthorizesStructuredRemoteReadChannel(newestApplicableSegment)
    || !explicitlyAuthorizesBoundedSoftwareRemoteEndpoint(server, newestApplicableSegment)
    || !explicitlyAuthorizesBoundedSoftwareMutationScope(newestApplicableSegment, server, remotePath)) return undefined;
  // Pi expands {{SESSION_PATH}} before PreToolUse. Bind both the model-facing
  // token form and that real runtime absolute form to the one declared source
  // root, otherwise an absolute sibling under the same session data directory
  // could inherit this upload authority.
  const declaredSourceRoots = explicitPortableSessionDataRoots(newestApplicableSegment!);
  if (declaredSourceRoots.length > 1) return undefined;
  const declaredSourceRoot = declaredSourceRoots.length === 1
    ? resolve(
      sessionPath,
      `.${declaredSourceRoots[0]!.slice(PORTABLE_SESSION_PATH_TOKEN.length)}`,
    )
    : undefined;

    const remoteRoots = explicitBoundedSoftwareRemoteRoots(newestApplicableSegment!);
    if (remoteRoots.excluded.some(root => remotePathIsWithinRoot(remotePath, root))
      || !remoteRoots.authorized.some(root => remotePathIsWithinRoot(remotePath, root))
      || !boundedSoftwareTupleAuthorizesRemotePath(
        newestApplicableSegment!,
        server,
        remotePath,
      )) {
      return undefined;
    }


  try {
    const configuredDataRoot = resolve(dataFolderPath);
    const source = resolve(localPath);
    const dataRoot = realpathSync.native(configuredDataRoot);
    if (!isPathWithinDirectory(source, configuredDataRoot)
      && !isPathWithinDirectory(source, dataRoot)) return undefined;
    if (isProtectedApplicationPath(dataRoot)) return undefined;
    let canonicalDeclaredSourceRoot = dataRoot;
    if (declaredSourceRoot) {
      const declaredRootStat = lstatSync(declaredSourceRoot);
      if (!declaredRootStat.isDirectory() || declaredRootStat.isSymbolicLink()) return undefined;
      if (pathUsesSymbolicLinkBelowBoundary(declaredSourceRoot, configuredDataRoot)) return undefined;
      canonicalDeclaredSourceRoot = realpathSync.native(declaredSourceRoot);
      if (!isPathWithinDirectory(canonicalDeclaredSourceRoot, dataRoot)) return undefined;
    }
    const sourceStat = lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) return undefined;
    const canonicalSource = realpathSync.native(source);
    return isPathWithinDirectory(canonicalSource, canonicalDeclaredSourceRoot)
      && !pathUsesSymbolicLinkBelowBoundary(source, declaredSourceRoot ?? configuredDataRoot)
      && !isSensitiveRemoteTransferSource({ localPath: canonicalSource })
      && !isProtectedApplicationPath(canonicalSource)
      ? canonicalSource : undefined;
  } catch {
    return undefined;
  }
}

function commandFromInput(input: Record<string, unknown>): string | undefined {
  return [input.command, input.cmd, input.script].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

const NON_BROWSER_CHANNEL_PATTERN = /(?:\bapi\b|\bconnect(?:eur|or)s?\b|\bdatabase\b|\bdb\b|\bbase\s+de\s+donnees?\b|\bsql\b|\bssh\b|\bserveurs?\b|\bservers?\b)/u;
const BROWSER_INTERFACE_PATTERN = /(?:\bbrowsers?\b|\bnavigateurs?\b|\binterfaces?\b|\bui\b)/u;
const BROWSER_LIFECYCLE_COMMANDS = new Set(['--help', '-h', 'help', 'release', 'close', 'hide']);

function normalizeUserInstructionForChannelMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019]/gu, "'")
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function isBrowserLifecycleCommand(command: unknown): boolean {
  if (Array.isArray(command)) {
    if (command.length < 1 || command.length > 2
      || !command.every((part): part is string => typeof part === 'string')) return false;
    const operation = command[0]?.trim().toLowerCase();
    if (!operation || !BROWSER_LIFECYCLE_COMMANDS.has(operation)) return false;
    return command.length === 1 || operation === 'release' || operation === 'close' || operation === 'hide';
  }
  if (typeof command !== 'string') return false;

  const trimmed = command.trim();
  if (/^(?:--help|-h|help)$/iu.test(trimmed)) return true;
  // Keep this exception deliberately narrower than the browser executor. A
  // batch or malformed command stays subject to the channel guard.
  return /^(?:release|close|hide)(?:\s+(?:[^\s;'"\r\n]+|"[^"\r\n;]*"|'[^'\r\n;]*'))?$/iu.test(trimmed);
}

function preserveIndicesWithoutApiInterfaces(normalized: string): string {
  return normalized.replace(
    /\b(?:(?:api|connect(?:eur|or)s?|database|base\s+de\s+donnees?|serveurs?|servers?)\s+interfaces?|interfaces?\s+(?:api|connect(?:eur|or)s?|database|serveurs?|servers?))\b/gu,
    match => ' '.repeat(match.length),
  );
}

function isNegatedDirectiveStart(value: string, index: number): boolean {
  const prefix = value.slice(Math.max(0, index - 48), index);
  return /(?:\bdo\s+not|\bdon't|\bnot|\bnever|\bwithout|\bavoid|\bpas|\bne\s+(?:pas|jamais|plus)|\bn'|\b(?:evite|eviter)(?:\s+d[' ]?)?)\s*$/u.test(prefix);
}

function lastPatternMatchIndex(
  value: string,
  patterns: readonly RegExp[],
  rejectNegatedStart = false,
): number {
  let latest = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (const match of value.matchAll(matcher)) {
      const index = match.index ?? -1;
      if (index < 0 || rejectNegatedStart && isNegatedDirectiveStart(value, index)) continue;
      latest = Math.max(latest, index);
    }
  }
  return latest;
}

function lastBrowserHandoffIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const purpose = /(?:\bauth(?:entication|entification)?\b|\bauthentifi(?:cation|e|er|ez)?\b|\blog[ -]?in\b|\bsign[ -]?in\b|\bconnexion\b|\bconnect(?:e|er|ez|ion)?\b|\bidentifi(?:cation|e|er|ez)\b|\bhandoff\b|\bpass(?:e|er|ez)?\s+(?:moi\s+)?la\s+main\b|\brepr(?:ends?|endre)\s+la\s+main\b|\bvalidation\s+visuelle?\b|\bcontrole\s+visuel\b|\bverif(?:y|ication|ier|ie|iez)\s+visuell?e?\b|\bvisually\b|\bvisual\s+(?:check|validation|verification)\b)/u;
  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  const openPattern = /\b(?:open|reopen|ouvre|ouvrir|rouvre|rouvrir|reouvre|reouvrir)\b/gu;
  let latest = -1;
  for (const match of browserText.matchAll(openPattern)) {
    const index = match.index ?? -1;
    if (index < 0 || isNegatedDirectiveStart(browserText, index)) continue;
    const tail = browserText.slice(index, index + 180);
    const purposeMatch = purpose.exec(tail);
    if (!purposeMatch) continue;
    const directTarget = new RegExp(`^[^.!?;]{0,60}\\b${browser}\\b`, 'u').test(tail);
    const contextualTarget = /^[^.!?;]{0,24}\b(?:it|this|le|la|lui|celui-ci|celle-ci)\b/u.test(tail);
    // Rank the complete scoped directive at its purpose, not merely at its
    // opening verb. Otherwise the nested phrase “browser only” starts a few
    // characters later and incorrectly wins as unrestricted browser authority.
    if (directTarget || contextualTarget) {
      latest = Math.max(latest, index + purposeMatch.index);
    }
  }
  return latest;
}

function lastBrowserExclusionIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  const target = `(?:(?:(?:a|an|the|le|la|les|un|une)\\s+|l[' ])?)${browser}\\b`;
  return lastPatternMatchIndex(browserText, [
    new RegExp(`\\b(?:non|not|no)\\s+(?:pas\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:never|without|avoid)\\s+(?:(?:use|using|open|opening)\\s+)?${target}`, 'gu'),
    new RegExp(`\\bsans\\s+(?:(?:utiliser|ouvrir|passer\\s+par)\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:evite|eviter)\\s+(?:(?:d[' ]?)?(?:utiliser|ouvrir)\\s+)?${target}`, 'gu'),
    new RegExp(`\\b(?:au\\s+lieu\\s+de|plutot\\s+que|rather\\s+than|instead\\s+of)\\s+(?:(?:using|use|opening|open|utiliser|ouvrir)\\s+)?${target}`, 'gu'),
    new RegExp(`\\bpas\\s+(?:de\\s+)?${target}`, 'gu'),
    new RegExp(`(?:\\bne\\s+(?:pas|jamais|plus)\\s+(?:utiliser|ouvrir)|\\bn'(?:utilise|ouvre)\\s+(?:pas|jamais|plus))\\s+${target}`, 'gu'),
    new RegExp(`\\bdo\\s+not\\s+(?:use|open)\\s+${target}`, 'gu'),
    new RegExp(`\\bdon't\\s+(?:use|open)\\s+${target}`, 'gu'),
    new RegExp(`\\b${browser}\\b\\s+(?:(?:est|is)\\s+)?(?:strictement\\s+)?(?:interdit|interdite|forbidden|proscrite?|exclu(?:e|s)?|unavailable|broken|inaccessible|down|indisponible|casse|hors\\s+service)\\b`, 'gu'),
    new RegExp(`\\b${browser}\\b\\s+(?:is\\s+not\\s+available|ne\\s+(?:fonctionne|marche)\\s+pas)\\b`, 'gu'),
  ]);
}

function lastBrowserRequestIndex(normalized: string): number {
  const browserText = preserveIndicesWithoutApiInterfaces(normalized);
  if (!BROWSER_INTERFACE_PATTERN.test(browserText)) return -1;

  const browser = '(?:browsers?|navigateurs?|interfaces?|ui)';
  let latest = lastPatternMatchIndex(browserText, [
    new RegExp(`\\b(?:via|through|dans|in|avec|using)\\s+(?:le\\s+|la\\s+|the\\s+|l[' ])?${browser}\\b`, 'gu'),
    new RegExp(`\\b${browser}\\s+(?:uniquement|seulement|only|exclusively)\\b`, 'gu'),
  ], true);
  const actionPattern = /\b(?:open|reopen|use|using|ouvre|ouvrir|rouvre|rouvrir|reouvre|reouvrir|utilise|utiliser|utilisez)\b/gu;
  for (const match of browserText.matchAll(actionPattern)) {
    const index = match.index ?? -1;
    if (index < 0 || isNegatedDirectiveStart(browserText, index)) continue;
    const tail = browserText.slice(index, index + 80);
    if (new RegExp(`^[^.!?;]{0,60}\\b${browser}\\b`, 'u').test(tail)) {
      latest = Math.max(latest, index);
    }
  }
  return latest;
}

function lastNonBrowserChannelIndex(normalized: string): number {
  const channel = '(?:api|connect(?:eur|or)s?|database|db|base\\s+de\\s+donnees?|sql|ssh|serveurs?|servers?)';
  const structuredChannel = NON_BROWSER_CHANNEL_PATTERN.test(normalized)
    ? lastPatternMatchIndex(normalized, [
    new RegExp(`\\b(?:via|through|par|avec|using)\\s+(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:utilise|utiliser|utilisez|use|using)\\s+(?:(?:uniquement|seulement|directement|only|exclusively|directly)\\s+)?(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:call|invoke|query|appelle|appeler|appelez|invoque|invoquer|interroge|interroger)\\s+(?:l[' ]|the\\s+)?${channel}\\b(?:\\s+(?:directly|directement))?`, 'gu'),
    new RegExp(`\\b(?:execute|run|executer|executez|lance|lancer|lancez)\\b[^.!?;]{0,40}\\b(?:on|via|through|sur|par)\\s+(?:le\\s+|the\\s+)?(?:serveurs?|servers?|ssh)\\b`, 'gu'),
    new RegExp(`\\b(?:passe|passer|passez|go)\\s+(?:uniquement\\s+|only\\s+)?(?:par|through|via)\\s+(?:l[' ]|le\\s+|la\\s+|the\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b(?:concentre(?:-toi|\\s+toi)?|focus)\\s+(?:uniquement\\s+|only\\s+)?(?:sur|on)\\s+(?:(?:la|the)\\s+)?(?:partie\\s+|side\\s+)?${channel}\\b`, 'gu'),
    new RegExp(`\\b${channel}\\s+(?:uniquement|seulement|only|exclusively)\\b`, 'gu'),
      ], true)
    : -1;
  // A closure may deliberately allow either a local read or an equivalent
  // structured observation without naming the connector. "Structured" is a
  // machine-readable channel here, not permission to substitute a browser UI.
  const boundedLocalOrStructuredRead = lastPatternMatchIndex(normalized, [
    /\b(?:seulement|uniquement|only)\s+(?:une?\s+|an?\s+)?(?:observation|lecture|inspection|read)\s+(?:locale?|local)\s+(?:ou|or)\s+(?:structuree?|structured)(?:\s+(?:strictement|strictly))?\s+(?:en\s+)?(?:lecture\s+seule|read\s+only)\b/gu,
    /\b(?:only|seulement|uniquement)\s+(?:a\s+|une?\s+)?(?:local|locale?)\s+(?:or|ou)\s+(?:structured|structuree?)\s+(?:strictly\s+|strictement\s+)?(?:read\s+only|lecture\s+seule)\s+(?:observation|read|inspection|lecture)\b/gu,
  ], true);
  return Math.max(structuredChannel, boundedLocalOrStructuredRead);
}

export type BrowserChannelDirective = 'non-browser' | 'browser-handoff' | 'browser' | 'none';

function classifyBrowserChannelDirective(instruction: string): BrowserChannelDirective {
  const normalized = normalizeUserInstructionForChannelMatch(instruction);
  const candidates: Array<{ index: number; priority: number; directive: BrowserChannelDirective }> = [
    { index: lastNonBrowserChannelIndex(normalized), priority: 0, directive: 'non-browser' },
    { index: lastBrowserExclusionIndex(normalized), priority: 1, directive: 'non-browser' },
    // A positive combined request such as "use API and browser" wins a tie.
    { index: lastBrowserRequestIndex(normalized), priority: 2, directive: 'browser' },
    // Authentication handoff and final visual validation are deliberately
    // narrower than operational browser authority. They may open/read the UI,
    // but must never enable a generic API-to-browser fallback or browser
    // mutation merely because their wording appears after an API-only clause.
    { index: lastBrowserHandoffIndex(normalized), priority: 3, directive: 'browser-handoff' },
  ];
  const matches = candidates.filter(match => match.index >= 0);
  matches.sort((left, right) => right.index - left.index || right.priority - left.priority);
  return matches[0]?.directive ?? 'none';
}

export function resolveBrowserChannelDirective(
  currentUserRequest: string | undefined,
  objectiveAuthorizationSegments: readonly string[] | undefined,
): BrowserChannelDirective {
  // Authenticated objective segments are the authority boundary. In delegated
  // sessions currentUserRequest can be a model-authored child prompt, so it
  // must never supersede a persisted human root constraint. Only fall back to
  // the raw current request when the host supplied no authenticated segments.
  const candidates = objectiveAuthorizationSegments !== undefined
    ? [...objectiveAuthorizationSegments].reverse()
    : [currentUserRequest];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate && normalizeUserInstructionForChannelMatch(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const directive = classifyBrowserChannelDirective(normalized);
    if (directive !== 'none') return directive;
  }
  return 'none';
}

function isBrowserKeyboardText(toolName: string, input: Record<string, unknown>): boolean {
  return isCanonicalBrowserToolName(toolName) && containsBrowserKeyboardText(input.command);
}

function explicitlyNamesGmailBrowserMutation(command: unknown): boolean {
  const text = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string').join(' ')
    : typeof command === 'string' ? command : '';
  return /(?:^|[^a-z0-9])(?:gmail|mail\.google\.com)(?:[^a-z0-9]|$)/iu.test(text);
}

const CANONICAL_CONTEXTUAL_GMAIL_MUTATION_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
  'mcp__google-contacts__gmail_reply_bound',
  'mcp__google-contacts__gmail_reply_all',
  // These two are never authorized as the final contextual path, but their
  // dedicated recovery diagnostic is more precise than the generic fallback.
  'mcp__google-contacts__gmail_reply',
  'mcp__google-contacts__gmail_send',
]);

const CONTEXTUAL_GMAIL_COMPLETION_OBSERVATION_TOOLS = new Set([
  'mcp__google-contacts__gmail_connection_healthcheck',
  'mcp__google-contacts__gmail_search',
  'mcp__google-contacts__gmail_search_exact',
  'mcp__google-contacts__gmail_resolve_url',
  'mcp__google-contacts__gmail_get_message',
  'mcp__google-contacts__gmail_get_message_by_url',
  'mcp__google-contacts__gmail_get_unread',
  'mcp__google-contacts__gmail_list_messages',
  'mcp__google-contacts__gmail_recipients_preflight',
  'mcp__google-contacts__gmail_send_preflight',
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
  'mcp__google-contacts__gmail_mark_read_preflight',
  'mcp__google-contacts__gmail_mark_unread_preflight',
  'mcp__google-contacts__gmail_trash_preflight',
  'mcp__google-contacts__gmail_delete_draft_preflight',
  'mcp__google-contacts__gmail_create_draft_preflight',
  'mcp__google-contacts__gmail_verify_sent_message',
  'mcp__google-contacts__gmail_verify_draft',
]);
const SET_COMPLETION_CRITERIA_TOOL_PATTERN = /^(?:mcp__session__|session__)?set_completion_criteria$/;

function containsOnlyContextualGmailCompletionObservations(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!SET_COMPLETION_CRITERIA_TOOL_PATTERN.test(toolName)
    || !Array.isArray(input.criteria)
    || input.criteria.length === 0) return false;
  return input.criteria.every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const criterion = value as Record<string, unknown>;
    return typeof criterion.toolName === 'string'
      && CONTEXTUAL_GMAIL_COMPLETION_OBSERVATION_TOOLS.has(criterion.toolName);
  });
}

function explicitlyNamesNonCanonicalContextualGmailMutation(
  toolName: string,
  input: Record<string, unknown>,
  toolEffect: ToolEffectDescriptor,
): boolean {
  // Registration is host-owned, but MCP read-only annotations describe only
  // the registration call itself. They must never hide a mutating nested
  // criterion from the contextual Gmail guard.
  if (SET_COMPLETION_CRITERIA_TOOL_PATTERN.test(toolName)) {
    return !containsOnlyContextualGmailCompletionObservations(toolName, input);
  }
  if (CANONICAL_CONTEXTUAL_GMAIL_MUTATION_TOOLS.has(toolName)
    || isCanonicalBrowserToolName(toolName)
    || toolEffect.kind === 'read') return false;

  const command = commandFromInput(input) ?? '';
  if ((toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName))
    && (/(?:^|[^a-z0-9])(?:send[_-]?(?:gmail(?:[_-]?reply)?|mail)|gmail[_-]?(?:reply|send)|mail[_-]?reply|dispatch[_-]?reply|smtp|smtplib|sendmail|gmail\s+api|mail\.google\.com|googleapis\.com\/gmail)(?:[^a-z0-9]|$)/iu.test(command)
      || /tell\s+(?:application|app)\s+\\*["']mail\\*["'][^\n]{0,200}\b(?:send|reply)\b/iu.test(command))) {
    return true;
  }

  if (!toolName.startsWith('mcp__') && !toolName.startsWith('api_')) return false;
  const normalizedToolName = toolName.toLowerCase();
  let serializedInput = '';
  try {
    serializedInput = JSON.stringify(input).toLowerCase();
  } catch {
    return true;
  }
  return /(?:^|__|[_-])(?:gmail|email|mail|mailer|smtp|reply)(?:$|__|[_-])/u.test(normalizedToolName)
    || /(?:gmail[_-]?(?:reply|send)|send[_-]?email|reply[_-]?(?:all|email|message)|gmail\.googleapis\.com\/gmail\/v\d+\/[^"\s]+\/messages\/send|smtplib|sendmail)/u.test(serializedInput);
}

const OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS = new Set([
  'open',
  'navigate',
  'read',
  'snapshot',
  'screenshot',
  'screenshot-region',
  'get',
  'get-clipboard',
  'find',
  'search',
  'console',
  'network',
  'wait',
  'resume',
  'downloads',
  'scroll',
  'back',
  'forward',
  'focus',
  'windows',
]);

type BrowserObjectiveAuthority = 'not-browser' | 'observational' | 'mutation-or-unknown';

function classifyBrowserObjectiveAuthority(
  toolName: string,
  input: Record<string, unknown>,
): BrowserObjectiveAuthority {
  if (isCanonicalBrowserToolName(toolName)) {
    return isObservationalBrowserCommand(input.command)
      ? 'observational'
      : 'mutation-or-unknown';
  }

  const leafName = toolName.split('__').at(-1)?.trim().toLowerCase();
  if (!leafName?.startsWith('browser_')) return 'not-browser';

  const operation = leafName.slice('browser_'.length).replaceAll('_', '-');
  if (!OBSERVATIONAL_LEGACY_BROWSER_OPERATIONS.has(operation)) {
    return 'mutation-or-unknown';
  }
  if (operation === 'navigate') {
    const target = [input.url, input.href, input.target]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    return target && isObservationalBrowserCommand(['navigate', target])
      ? 'observational'
      : 'mutation-or-unknown';
  }
  if (operation === 'downloads') {
    const action = typeof input.action === 'string' ? input.action.trim().toLowerCase() : 'list';
    return action === 'list' || action === 'wait' ? 'observational' : 'mutation-or-unknown';
  }
  return 'observational';
}

/**
 * Host-owned connector observations. These exact tools acquire data or start a
 * read-only connection handshake; they do not change remote business records.
 * Their input schemas are checked here because neither a tool name nor
 * untrusted MCP annotations prove the effect of an arbitrary invocation.
 */
function isHostOwnedConnectorObservation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const keys = Object.keys(input);
  const displayOnly = (key: string) => key === '_displayName' || key === '_intent';
  if (toolName === 'mcp__session__wait_sessions') {
    return Array.isArray(input.sessionIds)
      && input.sessionIds.length > 0
      && input.sessionIds.length <= 8
      && input.sessionIds.every(id => typeof id === 'string' && id.length > 0)
      && (input.mode === undefined || input.mode === 'first' || input.mode === 'all')
      && (input.timeoutMs === undefined
        || typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs)
          && input.timeoutMs >= 0 && input.timeoutMs <= 120_000)
      && (input.afterCursors === undefined
        || typeof input.afterCursors === 'object' && input.afterCursors !== null
          && !Array.isArray(input.afterCursors)
          && Object.values(input.afterCursors).every(cursor => typeof cursor === 'string'))
      && keys.every(key => ['sessionIds', 'mode', 'timeoutMs', 'afterCursors'].includes(key)
        || displayOnly(key));
  }
  if (toolName === 'mcp__rbw-agents-oss__oss_list_files') {
    return typeof input.path === 'string'
      && (input.path === '/srv/rbw-agents-oss'
        || input.path.startsWith('/srv/rbw-agents-oss/'))
      && !input.path.split('/').includes('..')
      && (input.maxDepth === undefined
        || typeof input.maxDepth === 'number' && Number.isInteger(input.maxDepth)
          && input.maxDepth >= 0 && input.maxDepth <= 8)
      && keys.every(key => key === 'path' || key === 'maxDepth' || displayOnly(key));
  }
  if (toolName === 'mcp__rbw-servers__ssh_sync') {
    // The verified local mcp-ssh-manager connector maps this exact preview to
    // rsync --dry-run. Actual syncs and ambiguous inputs remain mutations.
    const localSource = typeof input.source === 'string'
      && input.source.startsWith('local:') ? input.source.slice(6) : '';
    const remoteDestination = typeof input.destination === 'string'
      && input.destination.startsWith('remote:') ? input.destination.slice(7) : '';
    const localPath = /^\/[A-Za-z0-9._/-]+$/u.test(localSource)
      || /^\{\{SESSION_PATH\}\}\/data\/[A-Za-z0-9._/-]+$/u.test(localSource);
    const remotePath = /^\/[A-Za-z0-9._/-]+$/u.test(remoteDestination);
    const noTraversal = (path: string) => !path.split('/').includes('..');
    return typeof input.server === 'string'
      && /^[A-Za-z0-9._-]{1,64}$/u.test(input.server)
      && input.dryRun === true && input.delete === false
      && localPath && remotePath
      && localSource.length <= 2_000 && remoteDestination.length <= 2_000
      && noTraversal(localSource) && noTraversal(remoteDestination)
      && (input.exclude === undefined || Array.isArray(input.exclude)
        && input.exclude.length <= 32
        && input.exclude.every(pattern => typeof pattern === 'string'
          && pattern.length <= 128 && /^[A-Za-z0-9_*?.-]+$/u.test(pattern)))
      && ['compress', 'verbose', 'checksum'].every(key => input[key] === undefined
        || typeof input[key] === 'boolean')
      && (input.timeout === undefined || typeof input.timeout === 'number'
        && Number.isInteger(input.timeout) && input.timeout > 0 && input.timeout <= 300_000)
      && keys.every(key => ['server', 'source', 'destination', 'dryRun', 'delete',
        'exclude', 'compress', 'verbose', 'checksum', 'timeout'].includes(key)
        || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__drive_download_file') {
    return typeof input.fileId === 'string'
      && /^[A-Za-z0-9_-]{10,}$/.test(input.fileId)
      && keys.every(key => key === 'fileId' || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__gmail_search_exact') {
    return typeof input.query === 'string'
      && input.query.trim().length > 0 && input.query.length <= 2_000
      && keys.every(key => key === 'query' || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__gmail_reply_preflight'
    || toolName === 'mcp__google-contacts__gmail_reply_all_preflight') {
    const recipientBound = toolName.endsWith('__gmail_reply_preflight');
    return typeof input.messageId === 'string'
      && /^[0-9a-f]{12,32}$/iu.test(input.messageId)
      && typeof input.body === 'string'
      && input.body.trim().length > 0
      && !input.body.includes('\0')
      && (input.isHtml === undefined || typeof input.isHtml === 'boolean')
      && (input.expectedSenderEmail === undefined
        || typeof input.expectedSenderEmail === 'string'
          && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedSenderEmail))
      && (recipientBound
        ? typeof input.expectedRecipientEmail === 'string'
          && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedRecipientEmail)
        : input.expectedRecipientEmail === undefined)
      && keys.every(key => (
        key === 'messageId' || key === 'body' || key === 'isHtml'
          || key === 'expectedSenderEmail'
          || recipientBound && key === 'expectedRecipientEmail'
          || displayOnly(key)
      ));
  }
  if (toolName === 'mcp__atria-sellsy__atria_sellsy_authenticate') {
    return keys.every(displayOnly);
  }
  if (toolName === 'mcp__atria-sellsy__atria_sellsy_oauth_start') {
    if (typeof input.scopes !== 'string'
      || !keys.every(key => key === 'scopes' || displayOnly(key))) return false;
    const scopes = input.scopes.trim().split(/\s+/u);
    const allowed = new Set([
      'companies.read', 'contacts.read', 'individuals.read',
      'invoices.read', 'subscriptions.read', 'items.read',
      'payments.read', 'credit-notes.read', 'estimates.read',
      'opportunities.read', 'tasks.read', 'activities.read', 'search.read',
    ]);
    return scopes.length > 0 && scopes.length <= allowed.size
      && new Set(scopes).size === scopes.length
      && scopes.every(scope => allowed.has(scope));
  }
  return false;
}

export function classifyToolEffect(
  toolName: string,
  input: Record<string, unknown>,
  permissionsContext?: PermissionsContext,
  declared?: DeclaredToolCapabilities,
): ToolEffectDescriptor {
  if (BUILTIN_READ_TOOLS.has(toolName)) {
    return { kind: 'read', reversibility: 'not-applicable', idempotent: true, source: 'builtin' };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'local-write', reversibility: 'unknown', source: 'builtin' };
  }

  const config = permissionsContext
    ? permissionsConfigCache.getMergedConfig(permissionsContext)
    : undefined;
  const isMcpTool = toolName.startsWith('mcp__');
  const nameSemantics = classifyToolNameMutationSemantics(toolName);

  // A destructive hint can only make the decision more restrictive, so it is
  // safe to honor even when it came from an untrusted remote MCP server.
  if (isMcpTool && declared?.destructive === true) {
    return {
      kind: 'external-mutation',
      reversibility: 'irreversible',
      idempotent: declared.idempotent,
      openWorld: declared.openWorld,
      source: 'mcp-annotations',
    };
  }

  if (isMcpTool && isHostOwnedConnectorObservation(toolName, input)) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: true,
      source: 'host-connector-contract',
    };
  }

  // Explicit keyboard delivery can affect a remote desktop; neither a legacy
  // browser read allowlist nor remote readOnly annotations can downgrade it.
  if (isBrowserKeyboardText(toolName, input)) {
    return { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' };
  }

  const command = commandFromInput(input);
  if ((toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName)) && command && config) {
    // The mutable user permission file is not the only source of truth for
    // operational reads. Keep a small host-owned grammar for exact GET/HEAD,
    // docker/systemd/GitHub inspections so an `ssh_execute` transport cannot
    // become a sensitive mutation merely because its leaf name says execute.
    const remoteCommandTransport = REMOTE_COMMAND_TOOL_PATTERN.test(toolName);
    // A workspace permission regex is user-extensible and has no access to
    // the objective/server binding. Never let such a broad `sed -n` rule turn
    // a remote source path into a generic read; runPreToolUseChecks applies
    // the narrower host-owned target/channel/path grant later.
    const remoteStaticSourceCandidate = remoteCommandTransport
      && containsRemoteStaticSourceInspectionCandidate(command);
    const readOnly = !remoteStaticSourceCandidate
      && isReadOnlyBashCommandWithConfig(command, config)
      || (remoteCommandTransport && isReadOnlyRegisteredShellObservation(command));
    if (readOnly) {
      return {
        kind: 'read',
        reversibility: 'not-applicable',
        idempotent: true,
        openWorld: remoteCommandTransport,
        source: 'input-semantics',
      };
    }
    return {
      kind: toolName === 'Bash' ? 'unknown' : 'external-mutation',
      reversibility: 'unknown',
      openWorld: remoteCommandTransport,
      source: 'input-semantics',
    };
  }

  const action = [input.action, input.operation]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : undefined;
  if (
    (method && MUTATION_HTTP_METHOD_PATTERN.test(method))
    || (action && classifyToolNameMutationSemantics(action) === 'mutation')
  ) {
    return {
      kind: isMcpTool || toolName.startsWith('api_') ? 'external-mutation' : 'unknown',
      reversibility: 'unknown',
      openWorld: isMcpTool || toolName.startsWith('api_'),
      source: 'input-semantics',
    };
  }

  // A connector preflight can contain the mutation it validates in its name
  // (`gmail_send_preflight`). Admit it as a read only when both the semantic
  // shape is explicitly non-executing and a host-owned permission pattern
  // authorizes that exact connector family. Neither condition alone is trust.
  if (
    isMcpTool
    && nameSemantics !== 'ambiguous-compound'
    && isClearlyReadOnlyToolAction(toolName)
    && config?.readOnlyMcpPatterns.some(pattern => pattern.test(toolName))
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: true,
      openWorld: declared?.openWorld,
      source: 'permissions-config',
    };
  }

  // Explicit host-parsed mutation tokens win over remote MCP annotations.
  // A server must not be able to label upload/write/delete as trusted read-only
  // and thereby bypass Explore mode or the target-bound mutation contract.
  if ((isMcpTool || toolName.startsWith('api_')) && nameSemantics === 'mutation') {
    return {
      kind: 'external-mutation',
      reversibility: 'unknown',
      idempotent: declared?.idempotent,
      openWorld: declared?.openWorld ?? true,
      source: 'input-semantics',
    };
  }

  if (
    isMcpTool
    && declared?.trusted === true
    && declared.readOnly === true
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: declared.idempotent,
      openWorld: declared.openWorld,
      source: 'mcp-annotations',
    };
  }

  if (toolName.startsWith('api_') || toolName.includes('__api_')) {
    const effectiveMethod = method ?? 'GET';
    return effectiveMethod === 'GET'
      ? { kind: 'read', reversibility: 'not-applicable', idempotent: true, openWorld: true, source: 'input-semantics' }
      : { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' };
  }

  // permissions.json is host-owned. Retain its explicitly supported MCP
  // reads, but only after explicit mutation semantics above have been ruled
  // out. Remote MCP annotations alone never reach this branch as authority.
  if (
    isMcpTool
    && nameSemantics === 'neutral'
    && config?.readOnlyMcpPatterns.some(pattern => pattern.test(toolName))
  ) {
    return {
      kind: 'read',
      reversibility: 'not-applicable',
      idempotent: declared?.idempotent,
      openWorld: declared?.openWorld,
      source: 'permissions-config',
    };
  }

  return { kind: 'unknown', reversibility: 'unknown', source: 'unknown' };
}

/**
 * Centralized PreToolUse pipeline.
 *
 * Synchronous except for the final result — all async work (source activation,
 * user prompting) is handled by the calling agent based on the result type.
 *
 * Pipeline:
 * 1. Permission mode check (shouldAllowToolInMode)
 * 2. Source blocking (inactive MCP sources)
 * 3. Prerequisite check (guide.md before source tools)
 * 4. call_llm interception
 * 5. Input transforms (paths, config validation, skills, metadata)
 * 6. Sensitive external-action confirmation (all non-safe modes, before whitelists)
 * 7. Ask-mode prompt decision
 *
 * @returns A discriminated union that the agent translates to its SDK format
 */
function withPermissionModeContext(reason: string, sessionId: string, effectiveMode: PermissionMode): string {
  if (reason.includes('Effective mode:')) return reason;

  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const modeDisplayName = PERMISSION_MODE_CONFIG[effectiveMode]?.displayName ?? effectiveMode;
  return [
    reason,
    '',
    `Effective mode: ${modeDisplayName}`,
    `Last mode change: ${diagnostics.lastChangedBy} at ${diagnostics.lastChangedAt} (modeVersion=${diagnostics.modeVersion})`,
  ].join('\n');
}

function readOnlyRemoteObservationRepairReason(repair: ReadOnlyRemoteObservationRepair): string {
  if (repair === 'git-hardening') {
    return [
      'Objective authority could not prove this Git inspection read-only because repository configuration can execute filesystem, hook, pager, formatting, or signature helpers; this is a recoverable invocation issue, not a request for broader user permission.',
      'Retry the same supported read-only Git operation with the exact prefix `git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager`.',
      'Use only the supported metadata/search operations (rev-parse, branch --show-current, merge-base, ls-files, grep, or non-patch log). Git status, diff, show and patch/stat log output remain blocked because repository attributes and filters can execute helpers; inspect worktree state or content with target-bound Read/rg/cmp instead. Do not add other Git configuration, pager, formatting, or helper options.',
    ].join(' ');
  }
  if (repair === 'split-composite') {
    return [
      'Objective authority could not prove this composite remote command read-only because its loop or compound shell shape leaves the effective scope unresolved; this is a recoverable command-shape issue, not a request for broader user permission.',
      'Retry by splitting it into separate `ssh_execute` calls, each containing one literal read-only inspection. Expand loops into individual literal `test`/`ls` checks and avoid mixing fallback control flow with the observation.',
    ].join(' ');
  }
  return [
    'Objective authority cannot prove that this opaque remote validation script is read-only or bound to the authorized project; this is a recoverable evidence-shape issue, not missing SSH credentials or a request for broader user permission.',
    'Do not run the script through another host or fallback channel. Replace it with direct, literal `ssh_execute` observations of the same target, one supported read-only command per call, or register and run the exact target-bound checks individually.',
  ].join(' ');
}

/**
 * Canonicalize only inert JSON data. Accessors, exotic prototypes, sparse
 * arrays, symbols, cycles and non-JSON scalars are rejected rather than read.
 * This is an exact capability key: case, whitespace, omitted/default fields
 * and array order remain significant.
 */
export function canonicalTerminalReconciliationToolInput(value: unknown): string | undefined {
  let nodes = 0;
  const seen = new Set<object>();
  const encode = (item: unknown, depth: number): string | undefined => {
    if (++nodes > 4_096 || depth > 64) return undefined;
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(item) : undefined;
    if (typeof item !== 'object' || seen.has(item)) return undefined;
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) return undefined;
        const own = Reflect.ownKeys(item);
        if (own.some(key => typeof key !== 'string'
          || key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key))) return undefined;
        const values: string[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
          const encoded = encode(descriptor.value, depth + 1);
          if (encoded === undefined) return undefined;
          values.push(encoded);
        }
        return `[${values.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const record = item as Record<string, unknown>;
      const keys = Reflect.ownKeys(record);
      if (keys.some(key => typeof key !== 'string')) return undefined;
      // These two root fields are display metadata stripped by the normal
      // tool pipeline and never reach the operation. Ignore them on both the
      // persisted and replay side; every operational field stays exact.
      for (const key of keys as string[]) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') return undefined;
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      }
      const ordered = (keys as string[])
        .filter(key => depth !== 0 || key !== '_intent' && key !== '_displayName')
        .sort((left, right) => left.localeCompare(right));
      const entries: string[] = [];
      for (const key of ordered) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !('value' in descriptor)) return undefined;
        const encoded = encode(descriptor.value, depth + 1);
        if (encoded === undefined) return undefined;
        entries.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(item);
    }
  };
  const encoded = encode(value, 0);
  return encoded !== undefined && encoded.length <= 65_536 ? encoded : undefined;
}

/** Reserved transport field injected only after the terminal allowlist passes. */
export const TERMINAL_RECONCILIATION_CAPABILITY_FIELD = '_hostTerminalReconciliationCapability';

function terminalReconciliationCoordinationTool(toolName: string): boolean {
  return /^(?:mcp__session__|session__)?(?:set_completion_criteria|spawn_session|wait_sessions)$/u.test(toolName);
}

/**
 * Bind the host-only policy key to one exact executable coordination input.
 * The handler receives only this digest, never the key, so a capability for
 * objective A or payload A cannot be retargeted to objective/payload B.
 */
export function deriveTerminalReconciliationInvocationCapability(
  capabilityKey: string | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!capabilityKey || !terminalReconciliationCoordinationTool(toolName)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, TERMINAL_RECONCILIATION_CAPABILITY_FIELD);
  if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) return undefined;
  const operationalInput = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') return undefined;
    if (key === TERMINAL_RECONCILIATION_CAPABILITY_FIELD) continue;
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !field.enumerable || !('value' in field)) return undefined;
    operationalInput[key] = field.value;
  }
  const inputJson = canonicalTerminalReconciliationToolInput(operationalInput);
  if (inputJson === undefined) return undefined;
  return createHash('sha256')
    .update(capabilityKey, 'utf8')
    .update('\0', 'utf8')
    .update(toolName, 'utf8')
    .update('\0', 'utf8')
    .update(inputJson, 'utf8')
    .digest('base64url');
}

function terminalReconciliationToolAllowed(
  policy: TerminalReconciliationPolicy,
  toolName: string,
  input: Record<string, unknown>,
  toolEffect: ToolEffectDescriptor,
): boolean {
  // The model can never present a host capability. Only this pipeline adds it
  // after all policy, source, prerequisite and input-transform checks pass.
  if (Object.prototype.hasOwnProperty.call(input, TERMINAL_RECONCILIATION_CAPABILITY_FIELD)) return false;
  // Browser state is live and cannot be an immutable evidence replay. This
  // remains forbidden even when an external Playwright/Puppeteer source calls
  // the operation trusted, read-only and idempotent, or the exact invocation
  // appears in the persisted replay list.
  if (isBrowserToolNameOrAlias(toolName)) return false;
  const inertUiMetadata = (key: string): boolean => {
    if (key !== '_intent' && key !== '_displayName') return false;
    const value = input[key];
    return typeof value === 'string' && value.length <= 4_096;
  };
  if (/^(?:mcp__session__|session__)?set_completion_criteria$/u.test(toolName)) {
    return policy.allowInitialCriteriaRegistration
      && canonicalTerminalReconciliationToolInput(input) !== undefined
      && Object.keys(input).every(key => (
        key === 'criteria' || key === 'procedure' || inertUiMetadata(key)
      ));
  }
  if (/^(?:mcp__session__|session__)?spawn_session$/u.test(toolName)) {
    return policy.allowReviewerSpawn && input.role === 'reviewer'
      && typeof input.prompt === 'string' && input.prompt.trim().length > 0
      && (input.permissionMode === undefined || input.permissionMode === 'safe')
      && Object.keys(input).every(key => (
        key === 'prompt' || key === 'name' || key === 'role' || key === 'permissionMode'
        || inertUiMetadata(key)
      ));
  }
  if (/^(?:mcp__session__|session__)?wait_sessions$/u.test(toolName)) {
    const sessionIds = input.sessionIds;
    if (canonicalTerminalReconciliationToolInput(input) === undefined
      || !Array.isArray(sessionIds)
      || sessionIds.length < 1 || sessionIds.length > 8
      || new Set(sessionIds).size !== sessionIds.length
      || sessionIds.some(id => typeof id !== 'string'
        || !policy.waitReviewerSessionIds.includes(id))) return false;
    if (input.afterCursors !== undefined) {
      if (!input.afterCursors || typeof input.afterCursors !== 'object'
        || Array.isArray(input.afterCursors)
        || Object.keys(input.afterCursors).some(id => !sessionIds.includes(id))) return false;
    }
    if (input.mode !== undefined && input.mode !== 'first' && input.mode !== 'all') return false;
    return Object.keys(input).every(key => (
      key === 'sessionIds' || key === 'timeoutMs' || key === 'afterCursors' || key === 'mode'
      || inertUiMetadata(key)
    ));
  }
  if (toolEffect.kind !== 'read') return false;
  const toolInputJson = canonicalTerminalReconciliationToolInput(input);
  return toolInputJson !== undefined && policy.readReplays.some(replay => (
    replay.toolName === toolName && replay.toolInputJson === toolInputJson
  ));
}

/**
 * Pi expands portable session-path tokens immediately before PreToolUse. Keep
 * the connector's executable input untouched, but compare that one host-owned
 * expansion against the authenticated symbolic Gmail contract. No other
 * absolute path, alias, sibling session, or multi-attachment payload is made
 * equivalent by this normalization.
 */
function structuredGmailSendDiagnosticInput(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  dataFolderPath: string | undefined,
): Record<string, unknown> {
  if (!dataFolderPath
    || !Array.isArray(input.attachmentPaths)
    || input.attachmentPaths.length !== 1
    || typeof input.attachmentPaths[0] !== 'string') return input;

  let expectedAttachmentPath: string | undefined;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    if (!/\[robb-resume(?::|\])/iu.test(segment)) continue;
    const payload = parseStructuredGmailSendResumeSegment(segment);
    if (payload?.attachmentPaths.length === 1) {
      expectedAttachmentPath = payload.attachmentPaths[0];
    }
    break;
  }
  if (!expectedAttachmentPath?.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/`)) {
    return input;
  }

  const sessionPath = resolve(dataFolderPath, '..');
  const directlyExpandedPath = sessionPath + expectedAttachmentPath.slice(
    PORTABLE_SESSION_PATH_TOKEN.length,
  );
  const actualAttachmentPath = input.attachmentPaths[0];
  if (actualAttachmentPath !== directlyExpandedPath) return input;

  return { ...input, attachmentPaths: [expectedAttachmentPath] };
}

export function runPreToolUseChecks(ctx: PreToolUseInput): PreToolUseCheckResult {
  const {
    toolName,
    input,
    sessionId,
    toolUseId,
    runtimeId,
    sourceActivationReentry = false,
    permissionApprovalReentry = false,
    permissionMode,
    workspaceRootPath,
    workspaceId,
    plansFolderPath,
    dataFolderPath,
    workingDirectory,
    executionIsolation,
    missionCapabilityLock,
    activeSourceSlugs,
    allSourceSlugs,
    hasSourceActivation,
    externalActionPolicy = 'confirm',
    objectiveMutationAuthorized,
    objectiveSensitiveActionAuthorized,
    objectiveAuthorizationSegments,
    authenticatedUserAuthorizationSegments,
    objectiveTerminalReconciliationPolicy,
    permissionManager,
    prerequisiteManager,
    preloadedSourceGuidePaths,
    backendMetadata,
    currentUserRequest,
    onDebug,
  } = ctx;

  const handoffBlock = yoloHumanHandoffBlock(
    toolName, getPermissionModeDiagnostics(sessionId).permissionMode, externalActionPolicy, ctx.humanInputAllowed,
  );
  if (handoffBlock) return { type: 'block', reason: handoffBlock };

  // Build permissions context for custom permissions.json rules
  const permissionsContext: PermissionsContext = {
    workspaceRootPath,
    activeSourceSlugs,
  };
  const acceptedAuthorizationSegments = objectiveAuthorizationSegments !== undefined
    ? objectiveAuthorizationSegments
    : currentUserRequest ? [currentUserRequest] : [];
  // Closed structured Gmail bodies are payload data. Preserve the raw view
  // only for exact Gmail payload/fingerprint checks; every other authority,
  // channel and remote-scope classifier consumes this policy-safe view.
  const policyAuthorizationSegments = externalActionAuthorityPolicySegments(
    acceptedAuthorizationSegments,
  );
  const targetScopedContextualGmailSegments = contextualGmailTargetScopedAuthorizationSegments(
    policyAuthorizationSegments,
    authenticatedUserAuthorizationSegments ?? [],
    toolName,
    input,
  );
  const policyCurrentUserRequest = currentUserRequest === undefined
    ? undefined
    : externalActionAuthorityPolicySegments([currentUserRequest])[0];
  const contextualGmailPreflightTool = CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName);
  const contextualGmailBoundTool = CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName);
  const contextualGmailLifecycleTool = contextualGmailPreflightTool || contextualGmailBoundTool;
  if (contextualGmailLifecycleTool
    && contextualGmailSessionsPendingFinalCleanup.has(sessionId)) {
    return {
      type: 'block',
      reason: 'Validation failed: this session is being permanently destroyed. No new Gmail preflight or bound reply may start while its exact runtime cleanup is pending.',
    };
  }
  if (contextualGmailPreflightTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a Gmail reply preflight requires one host-issued toolUseId so its result can be correlated without invalidating or replacing existing exact-once authority. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  if (contextualGmailBoundTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a bound Gmail reply requires one host-issued toolUseId so its signed preflight attestation can be reserved and consumed exactly once. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  let contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined;
  if (contextualGmailLifecycleTool && toolUseId) {
    const claimKey = `${sessionId}:${toolUseId}`;
    const objectiveFingerprint = contextualGmailObjectiveFingerprint(acceptedAuthorizationSegments);
    const operationHash = hashSensitiveExternalActionOperation(toolName, input);
    const existingClaim = contextualGmailToolUseClaims.get(claimKey);
    const validSourceActivationReentry = sourceActivationReentry
      && existingClaim?.phase === 'awaiting-source-reentry'
      && !existingClaim.sourceActivationReentryConsumed
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    const validPermissionApprovalReentry = permissionApprovalReentry
      && !!existingClaim
      && (existingClaim.phase === 'claimed' || existingClaim.phase === 'admitted')
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    if (!existingClaim) {
      contextualGmailToolUseClaim = {
        objectiveFingerprint,
        operationHash,
        phase: 'claimed',
        sourceActivationReentryConsumed: false,
        toolName,
      };
      contextualGmailToolUseClaims.set(claimKey, contextualGmailToolUseClaim);
    } else if (validSourceActivationReentry) {
      existingClaim.phase = 'claimed';
      existingClaim.sourceActivationReentryConsumed = true;
      contextualGmailToolUseClaim = existingClaim;
    } else if (validPermissionApprovalReentry) {
      contextualGmailToolUseClaim = existingClaim;
    } else {
      existingClaim.phase = 'poisoned';
      pendingContextualGmailPreflights.delete(claimKey);
      contextualGmailPreflightAttestations.delete(sessionId);
      const collidingInFlight = inFlightContextualGmailReplies.get(sessionId);
      if (collidingInFlight?.toolUseId === toolUseId) collidingInFlight.poisoned = true;
      return {
        type: 'block',
        reason: 'Validation failed: this host-issued Gmail lifecycle toolUseId was already claimed. The id is now poisoned because delayed terminal results cannot be attributed to one occurrence; use a new canonical tool call id after any in-flight reply reaches a terminal result or the runtime is safely restarted.',
      };
    }
  }
  const inFlightContextualGmailReply = contextualGmailLifecycleTool
    ? inFlightContextualGmailReplies.get(sessionId)
    : undefined;
  if (inFlightContextualGmailReply
    && !(permissionApprovalReentry && inFlightContextualGmailReply.toolUseId === toolUseId
      && inFlightContextualGmailReply.toolName === toolName
      && inFlightContextualGmailReply.operationHash
        === hashSensitiveExternalActionOperation(toolName, input))) {
    return {
      type: 'block',
      reason: contextualGmailPreflightTool
        ? 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result, then run one fresh canonical preflight; an absence check made while the prior mutation is unresolved cannot authorize a later reply.'
        : 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result before attempting any later reply; do not start a second mutation or use another send path.',
    };
  }
  const shellCommand = commandFromInput(input);
  const classifiedToolEffect = classifyToolEffect(
    toolName,
    input,
    permissionsContext,
    ctx.declaredToolCapabilities,
  );
  const boundedStructuredRemoteTechnicalRead = ctx.declaredToolCapabilities?.destructive !== true
    && isBoundedStructuredRemoteTechnicalRead(
      toolName,
      input,
      dataFolderPath,
      policyAuthorizationSegments,
    );
  // An upload is intentionally an external mutation. A correct MCP
  // `destructiveHint` must strengthen its effect classification, not erase an
  // otherwise exact human authorization for this server/root pair. The
  // bounded grammar below still controls authority and every mutation,
  // application-protection, evidence and permission gate remains active.
  const boundedStructuredRemoteTechnicalUploadLocalPath = isBoundedStructuredRemoteTechnicalUpload(
    toolName,
    input,
    dataFolderPath,
    policyAuthorizationSegments,
    authenticatedUserAuthorizationSegments,
  );
  const boundedStructuredRemoteTechnicalUpload =
    boundedStructuredRemoteTechnicalUploadLocalPath !== undefined;
  const boundedResumedSharePointCreation = isBoundedResumedSharePointCreation(
    toolName,
    input,
    policyAuthorizationSegments,
  );
  const resumedSharePointCreationContract = toolName === 'mcp__plc-microsoft-365__graph_request'
    ? boundedResumedSharePointCreationContract(policyAuthorizationSegments)
    : undefined;
  if (resumedSharePointCreationContract
    && ['DELETE', 'PATCH', 'POST', 'PUT'].includes(String(input.method).toUpperCase())
    && !boundedResumedSharePointCreation) {
    return {
      type: 'block',
      reason: [
        'Closed SharePoint creation contract mismatch: this Graph mutation was not executed.',
        'Retry only one complete contract shape: an atomic site-bound generic-list POST containing every column, or the exact signed drive-bound folder POST with an empty folder object and conflictBehavior "fail".',
        'Supported column facets are boolean, choice, personOrGroup, text, dateTime, and number with their bounded Graph fields.',
        'Do not retry an empty/partial list, split column creation, another site/drive/folder, replacement conflict behavior, multiple column facets, or unknown fields. Reconcile by Graph GET before any retry.',
      ].join(' '),
    };
  }
  const structuredRemoteStaticSourceCandidate = toolName === 'mcp__rbw-servers__ssh_execute'
    && !!shellCommand
    && isRemoteStaticSourceInspectionCandidate(shellCommand);
  const structuredRemoteOperationalInspectionCandidate = toolName === 'mcp__rbw-servers__ssh_execute'
    && !!shellCommand
    && !!classifyBoundedTargetedRemoteOperationalInspection(shellCommand);
  const rejectedTargetBoundStructuredRemoteTechnicalRead =
    (structuredRemoteOperationalInspectionCandidate
      || (STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS.has(toolName)
          || structuredRemoteStaticSourceCandidate)
        && hasTargetBoundOperationalTechnicalReadAuthority(input, policyAuthorizationSegments))
    && !boundedStructuredRemoteTechnicalRead;
  // These two connector operations can only inherit read authority from the
  // closed host grammar above. A trusted/readOnly MCP annotation describes the
  // remote server's claim, not the destination path or the complete payload,
  // and therefore cannot downgrade an unbounded download/session invocation.
  const unboundedStructuredRemoteLifecycleEffect: ToolEffectDescriptor | undefined =
    STRUCTURED_REMOTE_READ_LIFECYCLE_TOOLS.has(toolName) && classifiedToolEffect.kind === 'read'
      ? toolName === 'mcp__rbw-servers__ssh_download'
        ? { kind: 'local-write', reversibility: 'unknown', openWorld: true, source: 'input-semantics' }
        : { kind: 'external-mutation', reversibility: 'unknown', openWorld: true, source: 'input-semantics' }
      : undefined;
  const toolEffect: ToolEffectDescriptor = boundedStructuredRemoteTechnicalRead
    ? { kind: 'read', reversibility: 'not-applicable', idempotent: true, openWorld: true, source: 'input-semantics' }
    : unboundedStructuredRemoteLifecycleEffect ?? classifiedToolEffect;
  // Presence of this policy is the lock. Decide before source activation,
  // prerequisites, permission prompts or generic read allowances can create a
  // side effect or interruption. Only exact host capabilities proceed.
  if (objectiveTerminalReconciliationPolicy
    && !terminalReconciliationToolAllowed(
      objectiveTerminalReconciliationPolicy,
      toolName,
      input,
      toolEffect,
    )) {
    return {
      type: 'block',
      reason: 'Terminal reconciliation is host-locked to exact persisted read replays and exact reviewer coordination. This tool or input is outside that immutable allowlist; reuse admissible receipts and finish the structured outcome without another action, permission request, alternate channel, or broader read.',
    };
  }
  const classifiedSensitiveAction = classifySensitiveExternalAction(toolName, input);
  // A generic remote-command name such as ssh_execute is not itself evidence
  // of mutation. Preserve the host's stricter parsed-command proof when it has
  // established that this exact invocation is read-only.
  // A connector annotation cannot turn an intrinsically mutating write tool
  // into a read and thereby skip its signed path/session contract. Remote MCP
  // metadata is descriptive here; the host-owned tool identity is decisive.
  const sensitiveAction = classifiedSensitiveAction?.category === 'external_mutation'
    && toolEffect.kind === 'read'
    && toolName !== BOUNDED_OSS_ATOMIC_WRITE_TOOL
    && classifiedSensitiveAction.boundedRemoteReadSideEffect !== true
    ? null : classifiedSensitiveAction;
  const boundedOrionWorktreeCommand = sensitiveAction?.category === 'external_mutation'
    && isBoundedOrionWorktreeCommand(
      toolName,
      input,
      sensitiveAction.boundedRemoteImplementationLifecycle === true,
      policyAuthorizationSegments,
    );
  const signedOssAtomicWriteSessionId = classifiedSensitiveAction?.boundedOssAtomicWrite
    ? signedOssAtomicWriteAuthorizedSessionId(
      classifiedSensitiveAction,
      policyAuthorizationSegments,
    )
    : undefined;
  if (signedOssAtomicWriteSessionId !== undefined
    && signedOssAtomicWriteSessionId !== sessionId) {
    return {
      type: 'block',
      reason: 'Signed OSS write contract session mismatch: this exact capability belongs to another durable session and cannot be copied or replayed here.',
    };
  }
  const browserChannelDirective = resolveBrowserChannelDirective(
    policyCurrentUserRequest,
    objectiveAuthorizationSegments === undefined ? undefined : policyAuthorizationSegments,
  );
  const browserToolCall = isBrowserToolNameOrAlias(toolName);
  const boundedBrowserHandoffObservation = browserChannelDirective === 'browser-handoff'
    && classifyBrowserObjectiveAuthority(toolName, input) === 'observational';
  if (browserToolCall
    && !isBrowserLifecycleCommand(input.command)
    && (browserChannelDirective === 'non-browser'
      || browserChannelDirective === 'browser-handoff' && !boundedBrowserHandoffObservation)) {
    const reason = browserChannelDirective === 'browser-handoff'
      ? [
          'User channel constraint: the browser is authorized only for the explicit authentication handoff or final visual validation, not for operational work.',
          'Only a closed observational browser call is allowed in that bounded phase. Browser clicks, form input, uploads, evaluation and other mutations remain disabled; do not use the browser as an API or connector fallback.',
          'Continue the operation through the requested non-browser channel. Browser help/release/close/hide lifecycle commands remain available.',
        ].join(' ')
      : [
          'User channel constraint: the latest applicable human instruction explicitly excludes the browser/interface or binds this work to an API, connector, database, SSH, or server path.',
          'browser_tool is disabled for this turn. Continue without the browser through the requested non-browser channel when one is specified, and do not retry the browser fallback.',
          'A later explicit user instruction to use the browser can lift this constraint, including a bounded authentication handoff or final visual validation. Browser help/release/close/hide lifecycle commands remain available.',
        ].join(' ');
    onDebug?.(`User channel constraint: blocking ${toolName}`);
    return { type: 'block', reason };
  }
  const contextualGmailObjective = contextualGmailObjectiveFingerprint(acceptedAuthorizationSegments);
  const observedDependencyState = observedThirdPartyDependencies.get(sessionId);
  const currentObservedDependencies = observedDependencyState
    && observedDependencyState.expiresAt > Date.now()
    && observedDependencyState.objectiveFingerprint === contextualGmailObjective
    ? observedDependencyState.dependencies
    : [];
  if (observedDependencyState && currentObservedDependencies.length === 0) {
    observedThirdPartyDependencies.delete(sessionId);
  }
  const observedResolvedDependencyState = observedResolvedThirdPartyDependencies.get(sessionId);
  const currentObservedResolvedDependencies = observedResolvedDependencyState
    && observedResolvedDependencyState.expiresAt > Date.now()
    && observedResolvedDependencyState.objectiveFingerprint === contextualGmailObjective
    ? observedResolvedDependencyState.dependencies
    : [];
  if (observedResolvedDependencyState && currentObservedResolvedDependencies.length === 0) {
    observedResolvedThirdPartyDependencies.delete(sessionId);
  }
  const observedRead = observedContextualGmailReads.get(sessionId);
  if (observedRead && (observedRead.expiresAt <= Date.now()
    || observedRead.objectiveFingerprint !== contextualGmailObjective)) {
    observedContextualGmailReads.delete(sessionId);
  }
  const observedContextualGmailPreflight = contextualGmailReplyPreflightAttestationFromObjective(
    toolName,
    input,
    targetScopedContextualGmailSegments,
  );
  if (contextualGmailPreflightTool
    && targetScopedContextualGmailSegments !== policyAuthorizationSegments
    && !observedContextualGmailPreflight
    && input.expectedSenderEmail !== undefined) {
    return {
      type: 'block',
      reason: 'Validation failed: this selected Gmail reply did not specify a From identity. Omit expectedSenderEmail and retry the same read-only preflight using the connected Gmail profile; the signed connector receipt will report its actual sender. Do not ask the user for another authorization or an internal message ID.',
    };
  }
  let eligibleContextualGmailPreflight: ContextualGmailReplyPreflightIntent | undefined;
  if (observedContextualGmailPreflight) {
    const read = observedContextualGmailReads.get(sessionId);
    const matchingRead = read && read.expiresAt > Date.now()
      && read.objectiveFingerprint === contextualGmailObjective
      && read.messageId === observedContextualGmailPreflight.messageId;
    const exactHumanAnchor = contextualGmailObjectiveProvidesClosedExactHumanAnchor(
      targetScopedContextualGmailSegments,
      observedContextualGmailPreflight,
    );
    if (matchingRead || exactHumanAnchor) {
      eligibleContextualGmailPreflight = observedContextualGmailPreflight;
    }
  }
  const contextualGmailPreflightAttestation = currentContextualGmailPreflightAttestation(
    sessionId,
    contextualGmailObjective,
  );
  if (redundantlyAsksPermissionForSellsyReadOnlyOAuth(toolName, input)) {
    return {
      type: 'block',
      reason: 'Input request rejected: a read-only Sellsy OAuth handshake is already an admitted connector observation. Start mcp__atria-sellsy__atria_sellsy_oauth_start with only read scopes, then use the provider callback if it actually requires account consent or MFA. Do not ask for an additional Robb Agents permission.',
    };
  }
  if (redundantlyAsksAboutEstablishedThirdPartyDependency(
    toolName,
    input,
    policyAuthorizationSegments,
    currentObservedDependencies,
    currentObservedResolvedDependencies,
  )) {
    return {
      type: 'block',
      reason: 'Input request rejected: the accepted objective already establishes that this exact access item is pending from an identified third party. Finish all independent safe work, report the precise external dependency and its evidence, and keep any already-authorized monitor active. Do not ask the user to choose the same wait state again.',
    };
  }
  const structuredGmailSendDiagnostic = sensitiveAction
    ? structuredGmailSendAuthorizationDiagnostic(
      toolName,
      structuredGmailSendDiagnosticInput(
        input,
        acceptedAuthorizationSegments,
        dataFolderPath,
      ),
      acceptedAuthorizationSegments,
    )
    : { decision: 'not-applicable' as const, mismatchCategories: [] };
  const structuredGmailSendDecision = structuredGmailSendDiagnostic.decision;
  let contextualGmailPolicySegments = targetScopedContextualGmailSegments;
  if (structuredGmailSendDecision === 'authorized') {
    for (let index = acceptedAuthorizationSegments.length - 1; index >= 0; index -= 1) {
      if (parseStructuredGmailSendResumeSegment(acceptedAuthorizationSegments[index] ?? '')) {
        // The closed marker is a new-send authority boundary. Historical
        // thread-reply context before it cannot reclassify this exact send,
        // while same-segment and later reply directives remain visible.
        contextualGmailPolicySegments = targetScopedContextualGmailSegments.slice(index);
        break;
      }
    }
  }
  const contextualReplyRecovery = sensitiveAction
    ? contextualGmailReplyRecoveryReason(
      toolName,
      input,
      contextualGmailPolicySegments,
      contextualGmailPreflightAttestation,
    )
    : undefined;
  const contextualReplyAuthorizedByObjective = !!sensitiveAction
    && !contextualReplyRecovery
    && isContextualGmailReplyAuthorizedByObjective(
      toolName,
      input,
      contextualGmailPolicySegments,
      contextualGmailPreflightAttestation,
    );
  // A structured restart is a closed payload contract. If the current Gmail
  // mutation diverges from it, neither the generic objective matcher nor a
  // later permission prompt may widen that exact human authorization.
  if (structuredGmailSendDecision === 'invalid') {
    const mismatchCategories = structuredGmailSendDiagnostic.mismatchCategories.length > 0
      ? structuredGmailSendDiagnostic.mismatchCategories.join(', ')
      : 'closed-contract-mismatch';
    return {
      type: 'block',
      reason: `Objective authority: this Gmail send does not exactly match the authenticated structured payload. Mismatch categories (field names only; no values reflected): ${mismatchCategories}. Canonical input contract: include exact "to", "sendAsEmail", "subject", "body", and "attachmentPaths" values from the authenticated payload, with "attachmentPaths" either empty or containing its one bounded session PDF, plus "isHtml": false; "cc" and "bcc" may be omitted or must be empty strings. Optional "requireKnownContacts", "allowExternal", and "checkContacts" must be booleans; optional "_displayName" and "_intent" must be strings. Do not include "from", "replyTo", aliases, or any unknown field. Reconcile with reads and retry only that canonical payload; do not request broader permission.`,
    };
  }
  const uploadRequiresBoundedObjectiveAuthority = toolName === 'mcp__rbw-servers__ssh_upload'
    && !!dataFolderPath;
  const sensitiveActionAuthorizedByObjective = sensitiveAction
    ? !contextualReplyRecovery && (
      boundedStructuredRemoteTechnicalUpload && sensitiveAction.category !== 'secret_transfer'
      || boundedOrionWorktreeCommand
      || boundedResumedSharePointCreation
      || !uploadRequiresBoundedObjectiveAuthority && (structuredGmailSendDecision === 'authorized'
        || structuredGmailSendDecision === 'not-applicable' && (
        isSensitiveExternalActionAuthorizedByObjective(
          sensitiveAction,
          policyAuthorizationSegments,
          authenticatedUserAuthorizationSegments,
        ) || contextualReplyAuthorizedByObjective
      )))
    : false;
  const sensitiveActionHasUnresolvedRemoteScope = !!sensitiveAction
    && hasUnresolvedRemoteScopeTarget(sensitiveAction);
  const sensitiveActionHasUnresolvedTarget = !!sensitiveAction
    && hasUnresolvedSensitiveExternalActionTarget(sensitiveAction);
  const sensitiveActionOtherwiseAuthorizedByObjective = !!sensitiveAction
    && isSensitiveExternalActionOtherwiseAuthorizedByObjective(
      sensitiveAction,
      policyAuthorizationSegments,
    );
  const browserObjectiveAuthority = classifyBrowserObjectiveAuthority(toolName, input);
  const contextualGmailReplyMentioned = hasContextualGmailReplyMention(
    contextualGmailPolicySegments,
  );
  setContextualGmailBrowserMutationGuard(sessionId, contextualGmailReplyMentioned);

  // Catch only an explicitly Gmail-targeted browser fallback before execution.
  // Generic words such as "send" also occur in ticket/CMS UIs. Opaque and
  // generic refs are checked by browser-tool-runtime against the actual
  // session-bound URL, so unrelated form/CMS mutations remain available.
  if (browserObjectiveAuthority === 'mutation-or-unknown'
    && contextualGmailReplyMentioned
    && explicitlyNamesGmailBrowserMutation(input.command)) {
    return {
      type: 'block',
      reason: 'Validation failed: this accepted objective contains a contextual Gmail reply, so an explicit Gmail/send/reply browser mutation cannot be used as a fallback. Continue with read-only browser inspection if needed, then use only gmail_reply_preflight + gmail_reply_bound or gmail_reply_all_preflight + gmail_reply_all with their signed closed payload.',
    };
  }

  if (contextualGmailReplyMentioned
    && explicitlyNamesNonCanonicalContextualGmailMutation(toolName, input, toolEffect)) {
    return {
      type: 'block',
      reason: 'Validation failed: this accepted objective contains a contextual Gmail reply, so Gmail/email send or reply mutations through Bash, scripts, APIs, or non-canonical MCP tools are disabled. Use the successful Gmail read plus only gmail_reply_preflight + gmail_reply_bound or gmail_reply_all_preflight + gmail_reply_all with the signed closed payload.',
    };
  }

  // Host invariant, before modes, whitelists, trusted-source hints or objective gates.
  // The kernel sandbox is the boundary for scripts/obfuscated commands; this gives
  // direct file tools a useful explanation and also covers host-side MCP handlers.
  if (toolEffect.kind !== 'read' || FILE_WRITE_TOOLS.has(toolName)) {
    const targets = [
      input.file_path,
      input.path,
      input.notebook_path,
      input.destination,
      input.outputFile,
      input.localPath,
    ];
    for (const target of targets) {
      if (typeof target === 'string' && isProtectedApplicationPath(resolve(workingDirectory ?? workspaceRootPath, expandPath(target)))) {
        return { type: 'block', reason: APPLICATION_PROTECTION_REASON };
      }
    }
  }

  // Once this exact server has inherited the objective's technical read
  // authority, the payload must satisfy the complete host-owned grammar. Do
  // not let broader mutation authority, Execute mode, or trusted/readOnly MCP
  // annotations turn a malformed path, destination, session shape, or hidden
  // field into an allowed call. An unrelated objective remains on the normal
  // effect/permission path rather than being captured by this exception.
  if (rejectedTargetBoundStructuredRemoteTechnicalRead) {
    return {
      type: 'block',
      reason: 'Structured SSH read validation failed: this session, download, source read, loopback route/port, image, manifest, or compose target is not positively and exactly bound to the current human objective. Use only the documented fields and the explicitly named server/project; redirects, sibling projects, secret-like paths, local SSH, browser fallback, and broader destinations remain blocked.',
    };
  }

  // A fully redacted multi-category operation provides neither an inspectable
  // command nor a concrete target for informed consent. Never turn it into an
  // opaque prompt (or an Execute-policy auto-allow); require the agent to split
  // it into separately classifiable operations first.
  if (sensitiveAction?.requiresInspectableSplit) {
    return {
      type: 'block',
      reason: 'Sensitive compound operation is not inspectable as one action. Split it into separate operations with a concrete target for each, then request authorization for each operation independently.',
    };
  }

  // Diagnose repairable read-only remote command shapes before permission
  // modes and objective gates return. This changes only the refusal reason;
  // the unsupported invocation remains blocked at every boundary.
  const observationRepairCandidate = shellCommand
    ? classifyReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const nestedSshObservationRepair = shellCommand
    ? classifyNestedSshReadOnlyRemoteObservationRepair(shellCommand)
    : undefined;
  const localSshTransport = !!shellCommand
    && /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
    && containsLocalSshTransportInvocation(shellCommand);
  const remoteObservationRepair = REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    ? observationRepairCandidate
    : /(?:^|[_:.])(?:bash|shell|exec_command)(?:$|[_:.])/i.test(toolName)
        && (nestedSshObservationRepair || observationRepairCandidate === 'git-hardening')
      ? nestedSshObservationRepair ?? observationRepairCandidate
      : undefined;
  if (localSshTransport) {
    const repairGuidance = nestedSshObservationRepair
      ? `${readOnlyRemoteObservationRepairReason(nestedSshObservationRepair)} `
      : '';
    return {
      type: 'block',
      reason: `${repairGuidance}Local SSH transport through Bash/shell is disabled. Use the configured ssh_execute tool for the exact server and remote command. Do not bypass a structured SSH refusal through local Bash/ssh; keep the server, working directory, command, and audit trail in the registered ssh_execute transport.`,
    };
  }
  // A recoverable remote observation is, by definition, outside the closed
  // host read grammar. Block it before Execute mode or a broad workspace
  // allowlist can turn the diagnostic into an implicit grant. Commands that
  // already satisfy the read grammar never produce a repair classification.
  if (REMOTE_COMMAND_TOOL_PATTERN.test(toolName)
    && remoteObservationRepair
    && toolEffect.kind !== 'read'
    && !(sensitiveAction?.boundedRemoteImplementationLifecycle === true
      && sensitiveActionAuthorizedByObjective)) {
    return {
      type: 'block',
      reason: readOnlyRemoteObservationRepairReason(remoteObservationRepair),
    };
  }

  // Canonical mode source of truth for this session.
  // Keep incoming permissionMode only for mismatch diagnostics.
  const diagnostics = getPermissionModeDiagnostics(sessionId);
  const effectivePermissionMode = diagnostics.permissionMode;

  if (permissionMode !== effectivePermissionMode) {
    onDebug?.(
      `[ModeSync] sessionId=${sessionId} incomingMode=${permissionMode} effectiveMode=${effectivePermissionMode} ` +
      `modeVersion=${diagnostics.modeVersion} changedBy=${diagnostics.lastChangedBy} changedAt=${diagnostics.lastChangedAt}`
    );
  }

  // ============================================================
  // 1. PERMISSION MODE CHECK
  // ============================================================
  if (isBrowserKeyboardText(toolName, input) && effectivePermissionMode === 'safe') {
    return { type: 'block', reason: withPermissionModeContext('Keyboard text delivery to a browser/remote receiver is blocked in Explore mode.', sessionId, effectivePermissionMode) };
  }

  const modeResult = toolEffect.kind === 'read'
    ? { allowed: true as const }
    : shouldAllowToolInMode(
      toolName,
      input,
      effectivePermissionMode,
      { plansFolderPath, dataFolderPath, permissionsContext }
    );

  if (!modeResult.allowed) {
    const reason = remoteObservationRepair
      ? readOnlyRemoteObservationRepairReason(remoteObservationRepair)
      : modeResult.reason;
    const reasonWithContext = withPermissionModeContext(reason, sessionId, effectivePermissionMode);
    onDebug?.(`Permission mode ${effectivePermissionMode}: blocking ${toolName} — ${reasonWithContext}`);
    return { type: 'block', reason: reasonWithContext };
  }

  // ============================================================
  // 2. TASK TOOL ISOLATION (persistent host-side boundary)
  // ============================================================
  if (executionIsolation) {
    const isolationInput = expandToolPaths(toolName, input, onDebug).input;
    const isolationDecision = enforceTaskToolIsolation({
      toolName,
      input: isolationInput,
      workspaceRootPath,
      workingDirectory,
      isolation: executionIsolation,
      missionCapabilityLock,
    });
    if (!isolationDecision.allowed) {
      const reason = `Task execution isolation: ${isolationDecision.reason ?? 'blocked'}`;
      onDebug?.(`Task isolation: blocking ${toolName} — ${reason}`);
      return { type: 'block', reason };
    }
  }

  // ============================================================
  // 3. SOURCE BLOCKING (inactive MCP sources)
  // ============================================================
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1];
    if (parts.length >= 3 && serverName && !BUILT_IN_MCP_SERVERS.has(serverName)) {
      const isActive = activeSourceSlugs.includes(serverName);
      if (!isActive) {
        const sourceExists = allSourceSlugs.includes(serverName);
        if (objectiveTerminalReconciliationPolicy) {
          return {
            type: 'block',
            reason: `Terminal reconciliation cannot activate inactive source "${serverName}". Source activation is a configuration mutation outside the exact read-replay capability; reuse preserved evidence or finish with the truthful policy blocker.`,
          };
        }
        if (contextualGmailToolUseClaim) {
          contextualGmailToolUseClaim.phase = 'awaiting-source-reentry';
        }
        onDebug?.(`Source "${serverName}" not active (exists=${sourceExists}, hasActivation=${hasSourceActivation})`);
        return {
          type: 'source_activation_needed',
          sourceSlug: serverName,
          sourceExists,
        };
      }
    }
  }

  // ============================================================
  // 4. PREREQUISITE CHECK (guide.md before source tools)
  // ============================================================
  if (prerequisiteManager) {
    if (preloadedSourceGuidePaths?.length) {
      prerequisiteManager.markSourceGuidesLoadedInContext?.(preloadedSourceGuidePaths);
    }

    // Permit a bounded acquisition command; only its successful result earns credit.
    if (toolName === 'Bash' && prerequisiteManager.trackBashSkillRead(input)) {
      // Fall through without clearing the prerequisite before execution.
    } else {
      const prereqResult = prerequisiteManager.checkPrerequisites(toolName);
      if (!prereqResult.allowed) {
        return { type: 'block', reason: prereqResult.blockReason!, source: 'prerequisite' };
      }
    }
  }

  const oversizedCatalogGuidance = oversizedRbwOssCatalogReadGuidance(toolName, input);
  if (oversizedCatalogGuidance) {
    onDebug?.(`Bounded connector read: blocking whole OSS catalog read for ${String(input.path)}`);
    return {
      type: 'block',
      reason: `The requested OSS file is a known oversized catalog and this connector read has no enforced offset or byte limit. ${oversizedCatalogGuidance}`,
    };
  }

  // ============================================================
  // 5. HIGH-STAKES EVIDENCE GATE
  // ============================================================
  const spawnSessionTool = /^(?:mcp__session__|session__)?spawn_session$/.test(toolName);
  const readOnlyReviewerSpawn = spawnSessionTool && input.role === 'reviewer'
    && (input.permissionMode === undefined || input.permissionMode === 'safe');
  const sendAgentMessageTool = /^(?:mcp__session__|session__)?send_agent_message$/.test(toolName);
  const objectiveCoordinationTool = /^(?:mcp__session__|session__)?(?:set_completion_criteria|update_plan|wait_sessions)$/.test(toolName)
    || readOnlyReviewerSpawn;
  const unprovenShellMutation = toolEffect.kind === 'unknown'
    && (toolName === 'Bash' || REMOTE_COMMAND_TOOL_PATTERN.test(toolName));
  const unknownExternalMutation = toolEffect.kind === 'unknown'
    && ((toolName.startsWith('mcp__') && !BUILT_IN_MCP_SERVERS.has(toolName.split('__')[1] ?? ''))
      || toolName.startsWith('api_') || toolName.includes('__api_'));
  const objectiveMutationBlocked = objectiveMutationAuthorized === false
    && (toolEffect.kind === 'local-write' || toolEffect.kind === 'external-mutation'
      || unprovenShellMutation || unknownExternalMutation || sensitiveAction !== null
      || spawnSessionTool && !readOnlyReviewerSpawn || sendAgentMessageTool
      || browserObjectiveAuthority === 'mutation-or-unknown')
    && !objectiveCoordinationTool;
  const sensitiveObjectiveAuthority = objectiveSensitiveActionAuthorized
    ?? objectiveMutationAuthorized;
  const objectiveRequestsExactExternalConfirmation = !!sensitiveAction
    && !!objectiveAuthorizationSegments
    && isSensitiveExternalActionConfirmationRequestedByObjective(
      sensitiveAction,
      objectiveAuthorizationSegments,
    );
  // An explicit "stop immediately before this exact action and ask" contract
  // may reach the host's scoped permission UI. It never authorizes execution
  // itself, and all other observational/forbidden mutations remain blocked.
  const exactExternalConfirmationCanSupplyAuthority = objectiveRequestsExactExternalConfirmation
    && effectivePermissionMode !== 'safe';
  const sensitiveActionBlocked = !!sensitiveAction && (sensitiveObjectiveAuthority === false
    || sensitiveObjectiveAuthority === true && !sensitiveActionAuthorizedByObjective);
  const objectiveAuthorityBlocksCurrentTool = objectiveMutationBlocked
    && !exactExternalConfirmationCanSupplyAuthority;
  const unresolvedExternalConfirmationCanSupplyAuthority = sensitiveActionHasUnresolvedRemoteScope
    && sensitiveActionOtherwiseAuthorizedByObjective
    && sensitiveObjectiveAuthority !== false
    && effectivePermissionMode !== 'safe'
    && !remoteObservationRepair;
  const sensitiveAuthorityBlocksCurrentTool = !!contextualReplyRecovery || sensitiveActionBlocked
    && !exactExternalConfirmationCanSupplyAuthority
    && !unresolvedExternalConfirmationCanSupplyAuthority;
  if ((objectiveAuthorityBlocksCurrentTool || sensitiveAuthorityBlocksCurrentTool) && remoteObservationRepair) {
    return {
      type: 'block',
      reason: readOnlyRemoteObservationRepairReason(remoteObservationRepair),
    };
  }
  if (objectiveAuthorityBlocksCurrentTool) {
    return {
      type: 'block',
      reason: 'Objective authority: the current accepted user objective is observational or response-only and does not authorize an external mutation. Continue with reads or answer from the evidence already gathered; do not request broader permission or treat this as a policy blocker.',
    };
  }
  if (sensitiveAuthorityBlocksCurrentTool) {
    return {
      type: 'block',
      reason: contextualReplyRecovery
        ?? 'Objective authority: the current accepted human objective does not explicitly authorize this sensitive external action and its exact target. Continue only with the authorized local work or target; do not request broader permission or treat this as a policy blocker.',
    };
  }

  // Typed reads remain available for evidence acquisition. Every known
  // mutation, plus an unknown external MCP/API effect, is fail-closed: a tool
  // name containing `search`, `check`, or another read-like token is not proof
  // that invoking it is observational.
  if (toolEffect.kind !== 'read') {
    const safeModeDecision = shouldAllowToolInMode(
      toolName,
      input,
      'safe',
      { plansFolderPath, dataFolderPath, permissionsContext },
    );
    const unknownExternalEffect = toolEffect.kind === 'unknown' && (
      (toolName.startsWith('mcp__') && !BUILT_IN_MCP_SERVERS.has(toolName.split('__')[1] ?? ''))
      || toolName.startsWith('api_')
      || toolName.includes('__api_')
    );
    if (
      toolEffect.kind === 'local-write'
      || toolEffect.kind === 'external-mutation'
      || unknownExternalEffect
      || !safeModeDecision.allowed
    ) {
      const evidenceDecision = readOnlyReviewerSpawn
        ? { allowed: true as const }
        : checkObjectiveEvidenceBeforeMutation(sessionId, toolName, toolEffect.kind);
      if (!evidenceDecision.allowed) {
        onDebug?.(`Objective evidence gate: blocking ${toolName}`);
        return { type: 'block', reason: evidenceDecision.reason };
      }
    }
  }

  // ============================================================
  // 6. CALL_LLM / SPAWN_SESSION INTERCEPTION
  // ============================================================
  if (toolName === 'mcp__session__call_llm') {
    return { type: 'call_llm_intercept', input };
  }
  if (toolName === 'mcp__session__spawn_session') {
    if (objectiveTerminalReconciliationPolicy) {
      const normalizedSpawnInput = stripToolMetadata(toolName, input, onDebug).input;
      const invocationCapability = deriveTerminalReconciliationInvocationCapability(
        objectiveTerminalReconciliationPolicy.invocationCapabilityKey,
        toolName,
        normalizedSpawnInput,
      );
      if (!invocationCapability) {
        return {
          type: 'block',
          reason: 'Terminal reconciliation could not bind this reviewer dispatch to the current host objective revision. No child was created.',
        };
      }
      return {
        type: 'spawn_session_intercept',
        input: {
          ...normalizedSpawnInput,
          [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: invocationCapability,
        },
      };
    }
    return { type: 'spawn_session_intercept', input };
  }

  // ============================================================
  // 6. INPUT TRANSFORMS
  // ============================================================
  let currentInput = input;
  let wasModified = false;

  // 5a. Path expansion
  const pathResult = expandToolPaths(toolName, currentInput, onDebug);
  if (pathResult.modified) {
    currentInput = pathResult.input;
    wasModified = true;
  }

  // Portable session tokens are model-facing only. Once the exact bounded
  // upload has passed every authority and local realpath check above, hand the
  // connector the canonical absolute source path rather than a literal token.
  if (boundedStructuredRemoteTechnicalUploadLocalPath !== undefined
    && currentInput.localPath !== boundedStructuredRemoteTechnicalUploadLocalPath) {
    currentInput = {
      ...currentInput,
      localPath: boundedStructuredRemoteTechnicalUploadLocalPath,
    };
    wasModified = true;
  }

  // 5b. Config-domain Bash guard (block direct labels/automations path operations unless using craft-agent)
  if (FEATURE_FLAGS.craftAgentsCli && toolName === 'Bash') {
    const configDomainBashRedirect = getConfigDomainBashRedirect(currentInput, workspaceRootPath, workingDirectory);
    if (configDomainBashRedirect) {
      return { type: 'block', reason: configDomainBashRedirect.message };
    }
  }

  // 5c. Config file validation
  const configResult = validateConfigWrite(toolName, currentInput, workspaceRootPath, onDebug);
  if (!configResult.valid) {
    return { type: 'block', reason: configResult.error! };
  }

  // 5d. Config file CLI redirect (labels + automations)
  if (FEATURE_FLAGS.craftAgentsCli) {
    const cliRedirect = getConfigCliRedirect(toolName, currentInput, workspaceRootPath, workingDirectory);
    if (cliRedirect) {
      return { type: 'block', reason: cliRedirect.message };
    }
  }

  // 5e. Skill qualification
  if (toolName === 'Skill') {
    const skillResult = qualifySkillName(
      currentInput,
      workspaceId,
      workspaceRootPath,
      workingDirectory,
      onDebug
    );
    if (skillResult.modified) {
      currentInput = skillResult.input;
      wasModified = true;
    }
  }

  // 5f. Metadata stripping
  const metadataResult = stripToolMetadata(toolName, currentInput, onDebug);
  if (metadataResult.modified) {
    currentInput = metadataResult.input;
    wasModified = true;
  }

  // 5g. RTK Bash rewrite (last input transform — flows into both 'modify' and 'prompt' results).
  // Permission decisions above and the ask-mode prompt below operate on the
  // ORIGINAL `input` parameter, so the LLM still believes it ran the original
  // command and our permission system gates the original command — only the
  // SDK's actual execution sees the rewritten form.
  if (!objectiveTerminalReconciliationPolicy && ctx.rtkContext?.enabled && ctx.rtkContext.path) {
    const rtkResult = rewriteBashWithRtk(
      toolName,
      currentInput,
      ctx.rtkContext.path,
      ctx.rtkContext.exclude,
      onDebug,
      { dataFolderPath: ctx.dataFolderPath, workingDirectory },
    );
    if (rtkResult.modified) {
      currentInput = rtkResult.input;
      wasModified = true;
    }
  }

  // The capability key applies to the executable input, not merely the model
  // payload. Built-in path/skill/RTK transforms may not move a terminal read
  // outside its exact persisted replay. Stripping the two inert UI metadata
  // fields remains admissible because canonicalization excludes only them.
  if (objectiveTerminalReconciliationPolicy
    && !terminalReconciliationToolAllowed(
      objectiveTerminalReconciliationPolicy,
      toolName,
      currentInput,
      toolEffect,
    )) {
    return {
      type: 'block',
      reason: 'Terminal reconciliation input normalization changed an operational field outside the exact host capability. The transformed invocation was not executed.',
    };
  }

  // ============================================================
  // 7. SENSITIVE EXTERNAL-ACTION CONFIRMATION
  // ============================================================
  // Safe mode remains non-interactive and blocks. Ask always retains the
  // dedicated confirmation boundary. Execute does too unless the host opts the
  // workspace into `allow-in-execute`; the default remains fail-closed. This
  // deliberately runs before ask-mode/session whitelists.
  if (isBrowserKeyboardText(toolName, input)
    && !(effectivePermissionMode === 'allow-all' && externalActionPolicy === 'allow-in-execute')) {
    if (ctx.humanInputAllowed === false) return { type: 'block',
      reason: `YOLO: this receiver requires authority unavailable to this session. No keyboard event was delivered. ${YOLO_AUTONOMY_GUIDANCE}` };
    return {
      type: 'prompt', promptType: 'mcp_mutation',
      description: 'Deliver keyboard text to the focused browser/remote receiver',
      command: 'type-keys (text omitted)',
      reason: 'Keyboard events may change a remote application and require the existing external-action authority.',
      impact: 'Text is delivered without Enter, but the receiving application can react to each key.',
      requiresExplicitConfirmation: true,
    };
  }
  if (sensitiveAction) {
    if (effectivePermissionMode === 'safe') {
      const reason = withPermissionModeContext(
        `${sensitiveAction.description}\n\nSensitive external actions are blocked in Explore mode.`,
        sessionId,
        effectivePermissionMode,
      );
      onDebug?.(`Sensitive external action: blocking ${toolName} in safe mode`);
      return { type: 'block', reason };
    }

    const policyAllowsExecute = effectivePermissionMode === 'allow-all'
      && externalActionPolicy === 'allow-in-execute'
      && !objectiveRequestsExactExternalConfirmation
      && !sensitiveActionHasUnresolvedTarget;
    if (policyAllowsExecute) {
      onDebug?.(
        `Sensitive external action: workspace policy allows ${sensitiveAction.category} in Execute`,
      );
    } else {
      const explicitlyAuthorized = !objectiveRequestsExactExternalConfirmation && (objectiveAuthorizationSegments !== undefined
        ? sensitiveActionAuthorizedByObjective
        : isSensitiveExternalActionExplicitlyAuthorized(sensitiveAction, currentUserRequest));
      if (!explicitlyAuthorized) {
        if (ctx.humanInputAllowed === false) {
          return { type: 'block',
            reason: `YOLO cannot admit this exact external action: its target is unresolved or the accepted objective expressly withholds execution pending confirmation. No permission request was opened. ${YOLO_AUTONOMY_GUIDANCE}` };
        }
        onDebug?.(`Sensitive external action: confirmation required for ${sensitiveAction.category}`);
        return {
          type: 'prompt',
          promptType: sensitiveAction.promptType,
          description: sensitiveAction.description,
          command: sensitiveAction.commandPreview,
          modifiedInput: wasModified ? currentInput : undefined,
          reason: sensitiveAction.reason,
          impact: sensitiveAction.impact,
          sensitiveActionCategory: sensitiveAction.category,
          sensitiveActionTargets: sensitiveAction.targetCandidates,
          sensitiveActionOperationHash: hashSensitiveExternalActionOperation(toolName, currentInput),
          requiresExplicitConfirmation: true,
        };
      }
      onDebug?.(`Sensitive external action: current request explicitly authorizes ${sensitiveAction.category} target`);
    }
  }

  // Commit the exact-once reservation before Ask mode can return a prompt.
  // Backends resume an approved prompt directly, without re-running this
  // pipeline, so delaying the reservation until RESULT would leave the signed
  // attestation reusable. A denial reports executed:false and restores it.
  if (!permissionApprovalReentry && contextualReplyAuthorizedByObjective
    && contextualGmailPreflightAttestation && toolUseId) {
    const generation = contextualGmailPreflightGenerations.get(sessionId);
    if (generation === undefined
      || contextualGmailPreflightAttestation.bindingExpiresAtMs <= Date.now()
      || !contextualGmailToolUseClaim
      || contextualGmailToolUseClaim.phase === 'poisoned') {
      return {
        type: 'block',
        reason: 'Validation failed: the signed Gmail preflight or host tool-use claim is no longer current and cannot be consumed safely. Run one fresh canonical preflight before retrying the reply.',
      };
    }
    contextualGmailPreflightAttestations.delete(sessionId);
    reservedContextualGmailReplyAttestations.set(`${sessionId}:${toolUseId}`, {
      expiresAt: contextualGmailPreflightAttestation.bindingExpiresAtMs,
      generation,
      value: contextualGmailPreflightAttestation,
      objectiveFingerprint: contextualGmailObjective,
    });
    inFlightContextualGmailReplies.set(sessionId, {
      generation,
      invalidated: false,
      operationHash: hashSensitiveExternalActionOperation(toolName, currentInput),
      poisoned: false,
      possiblyExecuted: false,
      runtimeId,
      toolName,
      toolUseId,
    });
    contextualGmailToolUseClaim.phase = 'admitted';
  }

  // ============================================================
  // 8. ASK MODE PROMPT DECISION
  // ============================================================
  if (effectivePermissionMode === 'ask') {
    const promptInfo = shouldPromptInAskMode(
      toolName,
      input, // Use original input for permission decisions (before stripping)
      permissionManager,
      permissionsContext,
      plansFolderPath,
      onDebug,
      toolEffect,
    );
    if (promptInfo) {
      if (ctx.humanInputAllowed === false) return { type: 'block',
        reason: `YOLO: ${toolName} requires authority unavailable to this delegated session. No tool was executed and no permission request was opened. ${YOLO_AUTONOMY_GUIDANCE}` };
      const adminWrappedInput =
        promptInfo.promptType === 'admin_approval' &&
        promptInfo.command &&
        typeof currentInput.command === 'string' &&
        process.platform === 'darwin'
          ? { ...currentInput, command: wrapCommandForMacAdminPrompt(promptInfo.command) }
          : undefined;

      return {
        type: 'prompt',
        promptType: promptInfo.promptType,
        description: promptInfo.description,
        command: promptInfo.command,
        modifiedInput: adminWrappedInput ?? (wasModified ? currentInput : undefined),
        appName: promptInfo.appName,
        reason: promptInfo.reason,
        impact: promptInfo.impact,
        requiresSystemPrompt: promptInfo.requiresSystemPrompt,
        rememberForMinutes: promptInfo.rememberForMinutes,
        commandHash: promptInfo.commandHash,
        approvalTtlSeconds: promptInfo.approvalTtlSeconds,
      };
    }
  }

  // ============================================================
  // RESULT
  // ============================================================
  if (eligibleContextualGmailPreflight && !permissionApprovalReentry) {
    const generation = nextContextualGmailPreflightGeneration(sessionId);
    // Only a preflight that has passed every host gate becomes an attempt.
    // This keeps source-activation/prompt re-entry with the same call id from
    // looking like a second invocation while still invalidating older receipts
    // before the actual connector call can return failure or ambiguity.
    contextualGmailPreflightAttestations.delete(sessionId);
    if (toolUseId) {
      const pendingKey = `${sessionId}:${toolUseId}`;
      pendingContextualGmailPreflights.delete(pendingKey);
      pendingContextualGmailPreflights.set(pendingKey, {
        expiresAt: Date.now() + CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS,
        generation,
        intent: eligibleContextualGmailPreflight,
        policySegments: targetScopedContextualGmailSegments,
        objectiveFingerprint: contextualGmailObjective,
      });
      if (contextualGmailToolUseClaim) contextualGmailToolUseClaim.phase = 'admitted';
    }
  }
  if (objectiveTerminalReconciliationPolicy
    && terminalReconciliationCoordinationTool(toolName)) {
    const invocationCapability = deriveTerminalReconciliationInvocationCapability(
      objectiveTerminalReconciliationPolicy.invocationCapabilityKey,
      toolName,
      currentInput,
    );
    if (!invocationCapability) {
      return {
        type: 'block',
        reason: 'Terminal reconciliation could not bind this coordination call to the current host objective revision. The tool was not executed.',
      };
    }
    currentInput = {
      ...currentInput,
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: invocationCapability,
    };
    wasModified = true;
  }
  if (wasModified) {
    return { type: 'modify', input: currentInput };
  }
  return { type: 'allow' };
}

// ============================================================
// ASK-MODE PROMPT DECISION (centralized across backends)
// ============================================================

interface PromptInfo {
  promptType: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval';
  description: string;
  command?: string;
  appName?: string;
  reason?: string;
  impact?: string;
  requiresSystemPrompt?: boolean;
  rememberForMinutes?: number;
  commandHash?: string;
  approvalTtlSeconds?: number;
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

function toDisplayName(token: string): string {
  return token.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function classifyAdminApproval(command: string): PromptInfo | null {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();
  const tokens = normalized.split(/\s+/);

  if (tokens[0] === 'brew' && tokens[1] === 'install' && tokens[2] === '--cask' && tokens[3]) {
    const appToken = tokens[3];
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask install: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to complete post-install steps.',
      impact: 'May install files in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  if (tokens[0] === 'brew' && tokens[1] === 'upgrade' && tokens[2] === '--cask' && tokens[3]) {
    const appToken = tokens[3];
    return {
      promptType: 'admin_approval',
      description: `Admin approval required for cask upgrade: ${appToken}`,
      command: trimmed,
      appName: toDisplayName(appToken),
      reason: 'Homebrew needs admin access to replace app files in protected locations.',
      impact: 'May replace app binaries in /Applications and system-managed directories.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 10,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  const packageFlagIndex = tokens.indexOf('-pkg');
  const targetFlagIndex = tokens.indexOf('-target');
  if (
    tokens[0] === 'installer'
    && packageFlagIndex >= 0
    && Boolean(tokens[packageFlagIndex + 1])
    && targetFlagIndex > packageFlagIndex
    && tokens[targetFlagIndex + 1] === '/'
  ) {
    return {
      promptType: 'admin_approval',
      description: 'Admin approval required for macOS installer package',
      command: trimmed,
      appName: 'Installer Package',
      reason: 'The installer writes files to protected system locations.',
      impact: 'May install system services, app files, or startup items.',
      requiresSystemPrompt: process.platform === 'darwin',
      rememberForMinutes: 5,
      commandHash: hashCommand(trimmed),
      approvalTtlSeconds: 120,
    };
  }

  return null;
}

function wrapCommandForMacAdminPrompt(command: string): string {
  // Escape for AppleScript shell string: \ -> \\, " -> \", $ -> \$
  const escaped = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$');

  return `osascript -e 'do shell script "${escaped}" with administrator privileges'`;
}

/**
 * Determine if user approval is needed in 'ask' mode.
 *
 * Returns prompt info if user should be asked, null if auto-allowed.
 * This is the single source of truth for ask-mode decisions across all agents.
 * `shouldAllowToolInMode()` always returns `{allowed: true}` in ask mode, so
 * the prompt decision lives here rather than being inferred from a permission
 * check.
 */
export function shouldPromptInAskMode(
  toolName: string,
  input: Record<string, unknown>,
  permissionManager: PermissionManagerLike,
  permissionsContext: PermissionsContext,
  plansFolderPath?: string,
  onDebug?: (message: string) => void,
  toolEffect?: ToolEffectDescriptor,
): PromptInfo | null {

  if (toolEffect?.kind === 'read') {
    onDebug?.(`Auto-allowing typed read-only tool: ${toolName}`);
    return null;
  }

  // --- File writes ---
  if (FILE_WRITE_TOOLS.has(toolName)) {
    if (permissionManager.isCommandWhitelisted(toolName)) {
      onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
      return null;
    }
    const filePath = (input.file_path as string) || (input.notebook_path as string) || 'unknown';
    return {
      promptType: 'file_write',
      description: `${toolName}: ${filePath}`,
      command: filePath,
    };
  }

  // --- Bash commands ---
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const baseCommand = permissionManager.getBaseCommand(command);

    const adminPrompt = classifyAdminApproval(command);
    if (adminPrompt) {
      return adminPrompt;
    }

    // Auto-allow read-only commands using full AST-based validation
    // (same pipeline as Explore mode — catches redirects, substitutions, pipes to write commands)
    const mergedConfig = permissionsConfigCache.getMergedConfig(permissionsContext);
    if (isReadOnlyBashCommandWithConfig(command, mergedConfig)) {
      onDebug?.(`Auto-allowing read-only command: ${baseCommand}`);
      return null;
    }

    // Check session whitelist (not dangerous)
    if (permissionManager.isCommandWhitelisted(baseCommand) &&
        !permissionManager.isDangerousCommand(baseCommand)) {
      onDebug?.(`Auto-allowing "${baseCommand}" (previously approved)`);
      return null;
    }

    // Check domain whitelist for curl/wget
    if (['curl', 'wget'].includes(baseCommand)) {
      const domain = permissionManager.extractDomainFromNetworkCommand(command);
      if (domain && permissionManager.isDomainWhitelisted(domain)) {
        onDebug?.(`Auto-allowing ${baseCommand} to "${domain}" (domain whitelisted)`);
        return null;
      }
    }

    return {
      promptType: 'bash',
      description: `Execute: ${command}`,
      command,
    };
  }

  // --- MCP mutations ---
  if (toolName.startsWith('mcp__')) {
    // Check if it would be blocked in safe mode (= it's a mutation)
    const safeModeResult = shouldAllowToolInMode(
      toolName, input, 'safe', { plansFolderPath }
    );
    if (!safeModeResult.allowed) {
      // It's a mutation — check whitelist
      if (permissionManager.isCommandWhitelisted(toolName)) {
        onDebug?.(`Auto-allowing "${toolName}" (previously approved)`);
        return null;
      }
      const serverAndTool = toolName.replace('mcp__', '').replace(/__/g, '/');
      return {
        promptType: 'mcp_mutation',
        description: `MCP: ${serverAndTool}`,
        command: toolName,
      };
    }
    // Read-only MCP tool — no prompt needed
    return null;
  }

  // --- API mutations ---
  if (toolName.startsWith('api_')) {
    const method = ((input?.method as string) || 'GET').toUpperCase();
    const path = input?.path as string | undefined;

    if (method !== 'GET') {
      const apiDescription = `${method} ${path || ''}`;

      // Check permissions.json whitelist
      if (isApiEndpointAllowed(method, path, permissionsContext)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (whitelisted in permissions.json)`);
        return null;
      }

      // Check session whitelist
      if (permissionManager.isCommandWhitelisted(apiDescription)) {
        onDebug?.(`Auto-allowing API "${apiDescription}" (previously approved)`);
        return null;
      }

      return {
        promptType: 'api_mutation',
        description: `API: ${apiDescription}`,
        command: apiDescription,
      };
    }
  }

  return null;
}
