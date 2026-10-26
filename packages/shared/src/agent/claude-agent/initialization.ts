import { type PostInitResult } from "../backend/types.ts";
import { getLlmConnection } from "../../config/storage.ts";
import { getValidClaudeOAuthToken } from "../../auth/state.ts";
import { clearClaudeBedrockRoutingEnvVars, resolveAuthEnvVars } from "../../config/llm-connections.ts";
import { loadProjectById, getProjectAssetsPath, listProjectAssets, getProjectMemoryPath, loadProjectMemory } from "../../projects/storage.ts";
import { getCredentialManager } from "../../credentials/index.ts";
import { debug } from "../../utils/debug.ts";
import type { ClaudeAgent } from '../claude-agent.ts';

/**
   * Look up the bound project (if any) and return a snapshot for system-prompt injection.
   * Resolution silently no-ops when the session is unbound or the project no longer exists,
   * so this never blocks a chat() call.
   */
export function resolveProjectContext(transportOwner: ClaudeAgent): import("../../projects/types.ts").ProjectPromptContext | null {
    const projectId = transportOwner["config"].session?.projectId;
    if (!projectId)
        return null;
    try {
        const project = loadProjectById(transportOwner["workspaceRootPath"], projectId);
        if (!project)
            return null;
        const slug = project.config.slug;
        return {
            name: project.config.name,
            description: project.config.description,
            details: project.config.details,
            assetsPath: getProjectAssetsPath(transportOwner["workspaceRootPath"], slug),
            assets: listProjectAssets(transportOwner["workspaceRootPath"], slug).map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                sizeBytes: a.sizeBytes,
            })),
            memoryPath: getProjectMemoryPath(transportOwner["workspaceRootPath"], slug),
            memoryContent: loadProjectMemory(transportOwner["workspaceRootPath"], slug, 5000, { includeStructured: false }) ?? undefined,
        };
    }
    catch (error) {
        debug(`[resolveProjectContext] Failed to load project ${projectId}:`, error);
        return null;
    }
}

/**
   * Post-construction auth setup.
   * Fetches credentials and sets process.env before the SDK subprocess spawns.
   * The subprocess spawns lazily on first chat(), so postInit() is early enough.
   */
export async function postInit(transportOwner: ClaudeAgent): Promise<PostInitResult> {
    const slug = transportOwner["config"].connectionSlug;
    if (!slug) {
        return { authInjected: false, authWarning: 'No connection slug available', authWarningLevel: 'error' };
    }
    const connection = transportOwner["config"].sealedLlmConnection ?? getLlmConnection(slug);
    if (!connection) {
        return { authInjected: false, authWarning: `Connection not found: ${slug}`, authWarningLevel: 'error' };
    }
    // Clear all auth env vars first for clean state.
    // Claude subprocesses must never inherit Bedrock-routing toggles from a
    // previous connection or parent process environment.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    clearClaudeBedrockRoutingEnvVars();
    // Resolve auth env vars via shared utility
    const manager = getCredentialManager();
    const result = await resolveAuthEnvVars(connection, slug, manager, getValidClaudeOAuthToken, transportOwner["config"].expectedLlmCredentialBindingId);
    if (!result.success) {
        return { authInjected: false, authWarning: result.warning, authWarningLevel: 'error' };
    }
    // Preserve the authenticated per-instance snapshot. SDK options merge
    // these values after process.env, so another agent's postInit cannot swap
    // this governed route's endpoint or credential.
    transportOwner["config"].envOverrides = {
        ...transportOwner["config"].envOverrides,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
        ...result.envVars,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: transportOwner["getModel"](),
    };
    // Apply env vars to process.env (for SDK subprocess) and envOverrides (per-session isolation)
    for (const [key, value] of Object.entries(result.envVars)) {
        process.env[key] = value;
    }
    // Built-in content summaries inherit the selected task model.
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = transportOwner["getModel"]();
    return { authInjected: true };
}

export async function getToken(transportOwner: ClaudeAgent): Promise<string | null> {
    // Only return token if explicitly provided via config
    // Sources handle their own authentication
    return transportOwner["config"].mcpToken ?? null;
}
