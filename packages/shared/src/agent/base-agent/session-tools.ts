import { parseSpawnSessionInput, SPAWN_SESSION_ROLE_HELP } from "@craft-agent/session-tools-core";
import { omitUndefined } from "../../utils/json.ts";
import { expandPath } from "../../utils/paths.ts";
import { assertExistingWorkingDirectory } from "../spawn-helpers.ts";
import { buildCallLlmRequest, type LLMQueryResult } from "../llm-tool.ts";
import { loadAllSources } from "../../sources/storage.ts";
import { getSessionPath } from "../../sessions/storage.ts";
import { buildTitlePrompt, buildRegenerateTitlePrompt, validateTitle } from "../../utils/title-generator.ts";
import type { BaseAgent } from '../base-agent.ts';
import type { SpawnSessionRequest, SpawnSessionResult, SpawnSessionHelpResult } from './shared.ts';
import type { BaseAgentGenerateTitleOptionsPayload } from './protocol.ts';

/**
   * Pre-execute a call_llm request: resolve attachments, validate model, run query.
   * Shared across all backends. Codex overrides validateCallLlmModel() for provider filtering.
   */
export async function preExecuteCallLlm(transportOwner: BaseAgent, input: Record<string, unknown>): Promise<LLMQueryResult> {
    const sessionPath = getSessionPath(transportOwner["config"].workspace.rootPath, transportOwner["_sessionId"]);
    const modelSubstitutionAllowed = false;
    const requestInput = modelSubstitutionAllowed
        ? input
        : (() => {
            const { model: _ignoredModelOverride, ...inheritedRouteInput } = input;
            return inheritedRouteInput;
        })();
    const request = await buildCallLlmRequest(requestInput, {
        backendName: transportOwner["backendName"],
        sessionPath,
        validateModel: transportOwner["validateCallLlmModel"]?.bind(transportOwner),
    });
    // Attachment resolution may yield. Preserve a denied admission snapshot
    // and also honor Auto -> Manual (or ON -> OFF) before dispatch.
    if (!modelSubstitutionAllowed || !false) {
        request.model = transportOwner["getModel"]();
    }
    return transportOwner["queryLlm"](request);
}

/** Workspace routing is opt-in and must fail closed if the live host getter
   * is absent or cannot read its configuration. */


  /** A workspace Auto setting never outranks an explicit session model pin.
   * Missing host wiring falls back to the persisted session snapshot. Getter
   * failures fail closed so an auxiliary call cannot escape a manual route. */


  /** Read the host-owned pin independently from the workspace Auto switch so
   * subprocess snapshots remain correct while Auto is temporarily disabled. */
export function modelRoutePinned(transportOwner: BaseAgent): boolean {
    try {
        return transportOwner["config"].isModelRoutePinned?.()
            ?? transportOwner["config"].session?.modelRoutePinned === true;
    }
    catch {
        return true;
    }
}

/**
   * Pre-execute a spawn_session request: handle help mode or delegate to onSpawnSession.
   * Shared across all backends.
   */
export async function preExecuteSpawnSession(transportOwner: BaseAgent, input: Record<string, unknown>): Promise<SpawnSessionResult | SpawnSessionHelpResult> {
    // This backend interception path does not execute the registry handler:
    // validate the same schema before any host callback can persist a child.
    const parsed = parseSpawnSessionInput(input);
    if (parsed.help) {
        return transportOwner["getSpawnSessionHelp"]();
    }
    // Spawn mode — validate and delegate
    const prompt = parsed.prompt;
    if (!prompt?.trim()) {
        throw new Error('prompt is required when not in help mode. Call with help=true to see available options.');
    }
    if (!transportOwner["onSpawnSession"]) {
        throw new Error('spawn_session is not available in this context.');
    }
    const workingDirectory = parsed.workingDirectory ? expandPath(parsed.workingDirectory) : undefined;
    const request = omitUndefined<SpawnSessionRequest>({
        ...parsed,
        prompt,
        workingDirectory,
    });
    // Reject remote or stale paths before the host creates a stored child.
    if (request.workingDirectory) {
        await assertExistingWorkingDirectory(request.workingDirectory);
    }
    return transportOwner["onSpawnSession"](request);
}

/**
   * Get available sources and role guidance for spawn_session help mode.
   */
export function getSpawnSessionHelp(transportOwner: BaseAgent): SpawnSessionHelpResult {
    const allSources = loadAllSources(transportOwner["config"].workspace.rootPath);
    const activeSlugs = transportOwner["sourceManager"].getActiveSlugs();
    return {
        roleHelp: SPAWN_SESSION_ROLE_HELP,
        sources: allSources.map(s => ({
            slug: s.config.slug,
            name: s.config.name,
            type: s.config.type,
            enabled: activeSlugs.has(s.config.slug),
        })),
        defaults: {
            permissionMode: transportOwner["permissionManager"].getPermissionMode(),
        },
    };
}

// ============================================================
  // Title Generation (shared implementation using runMiniCompletion)
  // ============================================================

  /**
   * Generate a session title from a user message.
   * Uses runMiniCompletion with the same auth as the main agent.
   *
   * @param message - The user's message to generate a title from
   * @param options.language - Preferred language for the title
   * @returns Generated title (2-5 words), or null if generation fails
   */
export async function generateTitle(transportOwner: BaseAgent, message: string, options?: BaseAgentGenerateTitleOptionsPayload): Promise<string | null> {
    try {
        const prompt = buildTitlePrompt(message, options);
        const result = await transportOwner["runMiniCompletion"](prompt);
        return validateTitle(result);
    }
    catch (error) {
        transportOwner["debug"](`[generateTitle] Failed: ${error}`);
        return null;
    }
}

/**
   * Regenerate a session title based on recent conversation context.
   * Uses a spread of messages (first, middle, last) to capture the session's purpose.
   *
   * @param recentUserMessages - Spread of user messages
   * @param lastAssistantResponse - The most recent assistant response
   * @param options.language - Preferred language for the title
   * @returns Generated title (2-5 words), or null if generation fails
   */
export async function regenerateTitle(transportOwner: BaseAgent, recentUserMessages: string[], lastAssistantResponse: string, options?: BaseAgentGenerateTitleOptionsPayload): Promise<string | null> {
    try {
        const prompt = buildRegenerateTitlePrompt(recentUserMessages, lastAssistantResponse, options);
        const result = await transportOwner["runMiniCompletion"](prompt);
        return validateTitle(result);
    }
    catch (error) {
        transportOwner["debug"](`[regenerateTitle] Failed: ${error}`);
        return null;
    }
}
