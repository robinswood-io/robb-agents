import { type PermissionMode } from "../../mode-manager.ts";
import type { PrerequisiteCheckResult } from "../prerequisite-manager.ts";
import type { TerminalReconciliationPolicy } from "../../backend/types.ts";
import { type SensitiveExternalActionCategory } from "../sensitive-external-action.ts";
import type { SessionExecutionIsolation } from "../../../tasks/durable-execution.ts";

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
  toolUseId?: string | undefined;
  /** Stable identity of the backend runtime executing this turn. */
  runtimeId?: string | undefined;
  /** Host-only marker for Pi's one synchronous re-check after it activates an MCP source. */
  sourceActivationReentry?: boolean | undefined;
  /** Host-only marker for the same backend tool call after a permission wait. */
  permissionApprovalReentry?: boolean | undefined;
  /** Current permission mode */
  permissionMode: PermissionMode;
  /** Absolute path to workspace root */
  workspaceRootPath: string;
  /** Workspace ID or slug for skill qualification */
  workspaceId: string;
  /** Plans folder path for the session (writes allowed in explore mode) */
  plansFolderPath?: string | undefined;
  /** Data folder path (writes allowed in explore mode for transform_data output) */
  dataFolderPath?: string | undefined;
  /** Working directory override (for skill resolution) */
  workingDirectory?: string | undefined;
  /** Persisted host-enforced isolation for a Conductor child session. */
  executionIsolation?: SessionExecutionIsolation | undefined;
  /** Host-only evaluated capability lease for a specialized Mission. */
  missionCapabilityLock?: import("../../../sessions/types.ts").MissionCapabilityLock | undefined;
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
  externalActionPolicy?: 'confirm' | 'allow-in-execute' | undefined;
  /** Live host policy, including a bound ancestor's no-human requirement. */
  humanInputAllowed?: boolean | undefined;
  /** Host-derived from the persisted active objective, never from tool prose. */
  objectiveMutationAuthorized?: boolean | undefined;
  /** Mutation authority inherited from the authenticated root objective. A
   * spawned prompt cannot grant this capability to itself. */
  objectiveSensitiveActionAuthorized?: boolean | undefined;
  /** Authenticated human objective segments, kept separate so action words and
   * targets from unrelated amendments cannot be combined into authorization. */
  objectiveAuthorizationSegments?: readonly string[] | undefined;
  /** Exact host-derived structured-answer segments. Public objective text can
   * never populate this provenance channel, even if it copies its marker. */
  authenticatedUserAuthorizationSegments?: readonly string[] | undefined;
  /** Host-owned terminal lock and its complete positive tool allowlist. */
  objectiveTerminalReconciliationPolicy?: TerminalReconciliationPolicy | undefined;
  /** PermissionManager for session-scoped whitelists */
  permissionManager: PermissionManagerLike;
  /** PrerequisiteManager for guide.md checking */
  prerequisiteManager?: PrerequisiteManagerLike | undefined;
  /**
   * Source guide files whose full contents were preloaded into the model's
   * current context. Host-owned context builders may provide these to avoid a
   * synthetic first-call rejection.
   */
  preloadedSourceGuidePaths?: readonly string[] | undefined;
  /** Backend metadata (e.g. Pi forwards intent / displayName via input.metadata) */
  backendMetadata?: { intent?: string; displayName?: string } | undefined;
  /** Raw current request. Never overrides authenticated objective segments when they are present. */
  /** Snapshot getters may explicitly report that no current request is available. */
  currentUserRequest?: string | undefined;
  /** Capability hints supplied by the registered MCP definition, never by model input. */
  declaredToolCapabilities?: DeclaredToolCapabilities | undefined;
  /** RTK Bash-rewrite context (undefined when toggle is off or rtk binary missing) */
  rtkContext?: import("../rtk-rewrite.ts").RtkContext | undefined;
  /** Debug callback */
  onDebug?: ((message: string) => void) | undefined;
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
