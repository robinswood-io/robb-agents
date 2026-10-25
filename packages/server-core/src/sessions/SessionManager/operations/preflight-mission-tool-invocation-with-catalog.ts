import type { SessionOperationContext } from '../operation-context.ts';
import { discoverMissionToolCatalog, loadSpecializedMissionSkillPackages } from '../policy.ts';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { isDeepStrictEqual } from 'node:util';
import { requirePermissionMode } from '@craft-agent/shared/agent/mode-types';
import type { PermissionMode } from '@craft-agent/shared/agent';
import { classifyToolEffect } from '@craft-agent/shared/agent';
import { specializedProfileCapabilityEnvelopeIdentity } from '@craft-agent/shared/specialized-profiles';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import type { Workspace } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { MissionCapabilityLock } from '@craft-agent/shared/sessions';
import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import type { LoadedSource } from '@craft-agent/shared/sources';
import { McpClientPool } from '@craft-agent/shared/mcp';
import { redactSecretLikeMaterial } from '@craft-agent/shared/utils';
import { SESSION_TOOL_REGISTRY } from '@craft-agent/session-tools-core';
import type { ManagedSession } from '../managed-session.ts';
import type { MissionSourceToolCatalogCache, MissionSourceToolCatalogDecision, MissionToolPreflightDecision, MissionToolPreflightInput } from '../mission-route.ts';
import { missionMcpInputValidator } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { MissionPendingTurnRecoveryClaim, MissionPendingTurnRecoveryClaimDecision } from '../runtime-types.ts';
import { buildServersFromSources } from '../source-build.ts';
import { resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner } from './track-session-operation.ts';
import { missionPendingTurnRecoveryClaimMismatch as sessionOpMissionPendingTurnRecoveryClaimMismatch } from './session-catalog.ts';

/** Atomically hands one restored Mission recovery from MissionRuntime
 * to the existing bounded recovery engine. Rejected claims never clear or
 * rewrite PendingTurnRecovery; concurrent exact claims share one operation. */
async function sessionOpClaimAndResumePendingMissionTurn(sessionOperationContext: SessionOperationContext, sessionId: string, claim: MissionPendingTurnRecoveryClaim): Promise<MissionPendingTurnRecoveryClaimDecision> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return { allowed: false, reason: 'Mission recovery session is unavailable' };
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformClaimAndResumePendingMissionTurn(sessionOperationContext, managed, claim));
}

async function sessionOpPerformClaimAndResumePendingMissionTurn(sessionOperationContext: SessionOperationContext, managed: ManagedSession, claim: MissionPendingTurnRecoveryClaim): Promise<MissionPendingTurnRecoveryClaimDecision> {
    const sessionId = managed.id;
    const mismatch = sessionOpMissionPendingTurnRecoveryClaimMismatch(sessionOperationContext, managed, claim);
    if (mismatch) {
        return { allowed: false, reason: `Mission pending-turn recovery claim refused: ${mismatch}` };
    }
    let record = sessionOperationContext.state.missionPendingTurnRecoveryClaims.get(sessionId);
    if (record && !isDeepStrictEqual(record.claim, claim)) {
        return {
            allowed: false,
            reason: 'Mission pending-turn recovery is already claimed under a different exact boundary',
        };
    }
    if (!record) {
        record = { token: Symbol(`mission-recovery:${sessionId}`), claim: structuredClone(claim) };
        sessionOperationContext.state.missionPendingTurnRecoveryClaims.set(sessionId, record);
    }
    if (!record.operation) {
        const exactRecord = record;
        const operation = Promise.resolve()
            .then(() => sessionOperationContext.owner["resumePendingTurnAfterRestart"](sessionId, exactRecord.token))
            .finally(() => {
            if (sessionOperationContext.state.missionPendingTurnRecoveryClaims.get(sessionId) !== exactRecord)
                return;
            exactRecord.operation = undefined;
            if (!sessionOperationContext.state.sessions.get(sessionId)?.pendingTurnRecovery) {
                sessionOperationContext.state.missionPendingTurnRecoveryClaims.delete(sessionId);
            }
        });
        exactRecord.operation = operation;
    }
    try {
        await record.operation;
        return { allowed: true };
    }
    catch (error) {
        sessionLog.warn('Mission-owned pending-turn recovery failed before completion', {
            sessionId,
            missionId: claim.missionId,
            missionWorkItemId: claim.missionWorkItemId,
            missionDispatchId: claim.missionDispatchId,
            error: redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4000),
        });
        return {
            allowed: false,
            reason: 'Mission pending-turn recovery could not be resumed safely',
        };
    }
}

function sessionOpAssertMissionOwnedRecoveryProviderFence(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const record = sessionOperationContext.state.missionPendingTurnRecoveryClaims.get(managed.id);
    if (!record) {
        if (!sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.has(managed.id))
            return;
        throw new Error('Mission recovery has no MissionRuntime ownership claim');
    }
    const mismatch = sessionOpMissionPendingTurnRecoveryClaimMismatch(sessionOperationContext, managed, record.claim);
    if (mismatch) {
        throw new Error(`Mission recovery boundary drifted before provider dispatch: ${mismatch}`);
    }
}

/** Materialize the exact current source selection before a Mission reviewer
 * is created. The caller persists this snapshot explicitly so workspace
 * defaults cannot change between tool preflight and provider dispatch. */
function sessionOpResolveMissionEnabledSourceSlugs(sessionOperationContext: SessionOperationContext, workspaceId: string, requestedSourceSlugs?: string[]): string[] {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace)
        throw new Error(`Unknown workspace "${workspaceId}"`);
    const resolved = resolveEffectiveSessionSourceSelection(requestedSourceSlugs, loadWorkspaceConfig(workspace.rootPath)?.defaults?.enabledSourceSlugs).enabledSourceSlugs;
    return [...new Set(resolved)].sort((left, right) => left.localeCompare(right));
}

async function sessionOpLoadMissionSourceToolCatalog(sessionOperationContext: SessionOperationContext, workspace: Workspace, source: LoadedSource): Promise<MissionSourceToolCatalogDecision> {
    const sourceSlug = source.config.slug;
    let built: Awaited<ReturnType<typeof buildServersFromSources>>;
    try {
        // Proxy names include the canonical source slug, so only the target
        // source is needed to reproduce its exact runtime identity. Avoid
        // launching unrelated enabled sources during one observation check.
        built = await buildServersFromSources([source], undefined, undefined, undefined, undefined, undefined, { sourceStateMutation: 'forbid' });
    }
    catch (error) {
        sessionLog.warn('Mission source catalog build failed', {
            sourceSlug,
            error: redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4000),
        });
        return {
            allowed: false,
            reason: `Mission source "${sourceSlug}" tool catalog could not be built safely (MISSION_SOURCE_CATALOG_BUILD_FAILED)`,
        };
    }
    const targetBuildError = built.errors.find(error => error.sourceSlug === sourceSlug);
    if (targetBuildError) {
        sessionLog.warn('Mission source catalog build returned an unavailable source', {
            sourceSlug,
            error: redactSecretLikeMaterial(targetBuildError.error).slice(0, 4000),
        });
        return {
            allowed: false,
            reason: `Mission source "${sourceSlug}" tool catalog is unavailable (MISSION_SOURCE_CATALOG_UNAVAILABLE)`,
        };
    }
    return discoverMissionToolCatalog(workspace, sourceSlug, built.mcpServers, built.apiServers);
}

async function sessionOpLoadMissionDocsToolCatalog(sessionOperationContext: SessionOperationContext, workspace: Workspace): Promise<MissionSourceToolCatalogDecision> {
    if (process.env.ROBB_ENABLE_CRAFT_DOCS_MCP !== '1' || process.env.CRAFT_DISABLE_DOCS === '1') {
        return {
            allowed: false,
            reason: 'Mission source "craft-agents-docs" is disabled by local privacy policy (ROBB_ENABLE_CRAFT_DOCS_MCP!=1)',
        };
    }
    return discoverMissionToolCatalog(workspace, 'craft-agents-docs', {
        'craft-agents-docs': {
            type: 'http',
            url: 'https://agents.craft.do/docs/mcp',
        },
    });
}

/** Side-effect-free admission check for one host-registered Mission observation.
 * SourceManager deterministically preloads ordinary source guides before the
 * runtime gate, so discovery need not replay that prerequisite here. The live
 * catalog, exact schema, declared capabilities and pure effect classifier are
 * checked now. Objective-bound SSH/runtime claims remain in the centralized
 * tool gate; simulating them would mutate or fork one-shot authority state. */
async function sessionOpPreflightMissionToolInvocation(sessionOperationContext: SessionOperationContext, workspaceId: string, input: MissionToolPreflightInput): Promise<MissionToolPreflightDecision> {
    return sessionOpPreflightMissionToolInvocationWithCatalog(sessionOperationContext, workspaceId, input, new Map());
}

/** One live tools/list per source for the duration of this reviewer preflight. */
async function sessionOpPreflightMissionToolInvocations(sessionOperationContext: SessionOperationContext, workspaceId: string, inputs: MissionToolPreflightInput[]): Promise<MissionToolPreflightDecision[]> {
    const catalogCache: MissionSourceToolCatalogCache = new Map();
    return Promise.all(inputs.map(input => (sessionOpPreflightMissionToolInvocationWithCatalog(sessionOperationContext, workspaceId, input, catalogCache))));
}

async function sessionOpPreflightMissionToolInvocationWithCatalog(sessionOperationContext: SessionOperationContext, workspaceId: string, input: MissionToolPreflightInput, catalogCache: MissionSourceToolCatalogCache): Promise<MissionToolPreflightDecision> {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace)
        return { allowed: false, reason: `Unknown workspace "${workspaceId}"` };
    if (!input.toolName || !input.toolInput || Array.isArray(input.toolInput)) {
        return { allowed: false, reason: 'Mission tool invocation is malformed' };
    }
    let permissionMode: PermissionMode;
    try {
        permissionMode = requirePermissionMode(input.permissionMode);
    }
    catch (error) {
        return {
            allowed: false,
            reason: error instanceof Error ? error.message : 'Mission permission mode is invalid',
        };
    }
    const enabledSourceSlugs = input.enabledSourceSlugs
        ?? loadWorkspaceConfig(workspace.rootPath)?.defaults?.enabledSourceSlugs
        ?? [];
    let declaredToolCapabilities: ReturnType<McpClientPool['getProxyToolCapabilities']>;
    let liveInputSchema: Record<string, unknown> | undefined;
    if (input.toolName.startsWith('mcp__')) {
        const parts = input.toolName.split('__');
        const sourceSlug = parts.length >= 3 ? parts[1] : undefined;
        if (!sourceSlug)
            return { allowed: false, reason: 'Mission MCP tool identity is malformed' };
        if (sourceSlug === 'session') {
            const localToolName = parts.slice(2).join('__');
            const definition = SESSION_TOOL_REGISTRY.get(localToolName);
            if (!definition) {
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" is absent from the live session tool registry`,
                };
            }
            const schema = definition.inputSchema.safeParse(input.toolInput);
            if (!schema.success) {
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" input does not satisfy its live schema`,
                };
            }
            if (definition.safeMode !== 'allow' || definition.readOnly !== true) {
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" is not declared as a Safe read-only session tool`,
                };
            }
            declaredToolCapabilities = {
                readOnly: true,
                idempotent: definition.idempotent,
                trusted: true,
            };
        }
        else if (sourceSlug === 'craft-agents-docs') {
            // The docs server is wired directly by both backends rather than by
            // the per-workspace source pool. Discover its live schema and hints
            // from the same canonical endpoint; an unavailable endpoint fails
            // closed before a Mission reviewer reaches the provider.
            let catalogPromise = catalogCache.get(sourceSlug);
            if (!catalogPromise) {
                catalogPromise = sessionOpLoadMissionDocsToolCatalog(sessionOperationContext, workspace);
                catalogCache.set(sourceSlug, catalogPromise);
            }
            const catalog = await catalogPromise;
            if (!catalog.allowed)
                return catalog;
            const liveDefinition = catalog.tools.get(input.toolName);
            if (!liveDefinition) {
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" is absent from the live docs tool catalog`,
                };
            }
            liveInputSchema = liveDefinition.inputSchema;
            declaredToolCapabilities = liveDefinition.capabilities;
        }
        else {
            if (!enabledSourceSlugs.includes(sourceSlug)) {
                return {
                    allowed: false,
                    reason: `Source "${sourceSlug}" is not enabled for the Mission review profile`,
                };
            }
            const source = getSourcesBySlugs(workspace.rootPath, [sourceSlug])
                .find(candidate => candidate.config.slug === sourceSlug);
            if (!source || !isSourceUsable(source)) {
                return {
                    allowed: false,
                    reason: `Source "${sourceSlug}" is unavailable, disabled, or unauthenticated`,
                };
            }
            // Build/list once per source for this batch only. The resolved promise
            // is discarded when preflightMissionToolInvocations returns, so no
            // catalog survives into another review or configuration revision.
            let catalogPromise = catalogCache.get(sourceSlug);
            if (!catalogPromise) {
                catalogPromise = sessionOpLoadMissionSourceToolCatalog(sessionOperationContext, workspace, source);
                catalogCache.set(sourceSlug, catalogPromise);
            }
            const catalog = await catalogPromise;
            if (!catalog.allowed)
                return catalog;
            const liveDefinition = catalog.tools.get(input.toolName);
            if (!liveDefinition) {
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" is absent from the live source catalog`,
                };
            }
            liveInputSchema = liveDefinition.inputSchema;
            declaredToolCapabilities = liveDefinition.capabilities;
        }
        if (liveInputSchema) {
            try {
                const validateInput = missionMcpInputValidator.getValidator<Record<string, unknown>>(liveInputSchema as JsonSchemaType);
                if (!validateInput(input.toolInput).valid) {
                    return {
                        allowed: false,
                        reason: `Mission tool "${input.toolName}" input does not satisfy its exact live MCP schema (MISSION_TOOL_INPUT_SCHEMA_INVALID)`,
                    };
                }
            }
            catch (error) {
                sessionLog.warn('Mission live MCP schema validation failed', {
                    toolName: input.toolName,
                    error: redactSecretLikeMaterial(error instanceof Error ? error.message : String(error)).slice(0, 4000),
                });
                return {
                    allowed: false,
                    reason: `Mission tool "${input.toolName}" live MCP schema could not be validated safely (MISSION_TOOL_SCHEMA_VALIDATION_FAILED)`,
                };
            }
        }
    }
    if (permissionMode !== 'safe')
        return { allowed: true };
    if (declaredToolCapabilities?.destructive === true) {
        return {
            allowed: false,
            reason: `Mission tool "${input.toolName}" is declared destructive by its live catalog`,
        };
    }
    const effect = classifyToolEffect(input.toolName, input.toolInput, {
        workspaceRootPath: workspace.rootPath,
        activeSourceSlugs: enabledSourceSlugs,
    }, declaredToolCapabilities);
    return effect.kind === 'read'
        ? { allowed: true }
        : {
            allowed: false,
            reason: `Effective Safe mode cannot prove ${input.toolName} read-only from its exact arguments`,
        };
}

/**
 * Internal-only second phase for specialized Mission session creation. The
 * renderer cannot supply this lock: it is derived from the host-selected
 * Mission binding after the durable session id exists.
 */
async function sessionOpBindSpecializedMissionCapabilityLock(sessionOperationContext: SessionOperationContext, sessionId: string, lock: MissionCapabilityLock): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        throw new Error('Specialized Mission capability lock requires an authenticated Mission session');
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformBindSpecializedMissionCapabilityLock(sessionOperationContext, managed, lock));
}

async function sessionOpPerformBindSpecializedMissionCapabilityLock(sessionOperationContext: SessionOperationContext, managed: ManagedSession, lock: MissionCapabilityLock): Promise<void> {
    const sessionId = managed.id;
    if (!managed.missionId
        || !managed.missionWorkItemId
        || !managed.missionDispatchId
        || !managed.missionRouteLockSha256) {
        throw new Error('Specialized Mission capability lock requires an authenticated Mission session');
    }
    const capabilities = [...lock.capabilities].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
    if (lock.schemaVersion !== 1
        || !/^[a-f0-9]{64}$/.test(lock.capabilityEnvelopeSha256)
        || capabilities.some(capability => !capability.name
            || (capability.identitySha256 !== undefined
                && !/^[a-f0-9]{64}$/.test(capability.identitySha256)))
        || specializedProfileCapabilityEnvelopeIdentity(capabilities)
            !== lock.capabilityEnvelopeSha256) {
        throw new Error('Specialized Mission capability lock does not match its evaluated envelope');
    }
    const canonical: MissionCapabilityLock = {
        schemaVersion: 1,
        capabilityEnvelopeSha256: lock.capabilityEnvelopeSha256,
        capabilities,
    };
    if (managed.missionCapabilityLock) {
        if (!isDeepStrictEqual(managed.missionCapabilityLock, canonical)) {
            throw new Error('Specialized Mission capability lock is immutable');
        }
        return;
    }
    // A crash between session creation and this host binding is recoverable;
    // once any model/tool work exists, retroactive certification is forbidden.
    if ((managed.messageCount ?? 0) > 0 || managed.messages.length > 0 || managed.isProcessing) {
        throw new Error('Cannot retroactively bind capabilities to an active Mission session');
    }
    managed.missionSealedSkillPackages = loadSpecializedMissionSkillPackages(managed, canonical);
    managed.missionCapabilityLock = canonical;
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSessionDurably(sessionId);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
}

export { sessionOpClaimAndResumePendingMissionTurn as claimAndResumePendingMissionTurn };
export { sessionOpPerformClaimAndResumePendingMissionTurn as performClaimAndResumePendingMissionTurn };
export { sessionOpAssertMissionOwnedRecoveryProviderFence as assertMissionOwnedRecoveryProviderFence };
export { sessionOpResolveMissionEnabledSourceSlugs as resolveMissionEnabledSourceSlugs };
export { sessionOpLoadMissionSourceToolCatalog as loadMissionSourceToolCatalog };
export { sessionOpLoadMissionDocsToolCatalog as loadMissionDocsToolCatalog };
export { sessionOpPreflightMissionToolInvocation as preflightMissionToolInvocation };
export { sessionOpPreflightMissionToolInvocations as preflightMissionToolInvocations };
export { sessionOpPreflightMissionToolInvocationWithCatalog as preflightMissionToolInvocationWithCatalog };
export { sessionOpBindSpecializedMissionCapabilityLock as bindSpecializedMissionCapabilityLock };
export { sessionOpPerformBindSpecializedMissionCapabilityLock as performBindSpecializedMissionCapabilityLock };
