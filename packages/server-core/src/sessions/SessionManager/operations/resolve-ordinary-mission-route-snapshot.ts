import type { SessionOperationContext } from '../operation-context.ts';
import { assertMissionDispatchWorkingDirectory, assertOrdinaryMissionRouteProjection } from '../policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import { getLlmConnection, getDefaultLlmConnection, getDefaultThinkingLevel } from '@craft-agent/shared/config';
import type { LlmConnection } from '@craft-agent/shared/config';
import { specializedProfileExecutionRouteIdentity } from '@craft-agent/shared/specialized-profiles';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import type { LlmCredentialBinding } from '@craft-agent/shared/credentials';
import { resolveSpecializedSkillCapabilityIdentity, resolveSpecializedSourceCapabilityIdentity } from '../../../specialized-profiles/capability-identity.ts';
import { effectiveOrdinaryMissionSourceSlugs, ordinaryMissionConnectionIdentity, ordinaryMissionRouteConfigIdentity, ordinaryMissionSourceBindings, ordinaryMissionSourceIdentityFromBindings } from '../../../missions/mission-route-identity.ts';
import type { ManagedSession } from '../managed-session.ts';
import { freezeRuntimeSnapshot, specializedRuntimeIdentitySha256 } from '../mission-route.ts';
import { managedToSession } from '../session-presentation.ts';

async function sessionOpAssertSpecializedMissionCapabilities(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, toolName?: string, input: Readonly<Record<string, unknown>> = {}): Promise<void> {
    const lock = managed.missionCapabilityLock;
    if (!lock) {
        if (managed.missionRouteLockSha256) {
            throw new Error('Specialized Mission session has no capability lock');
        }
        return;
    }
    const declaredSkills = new Set(lock.capabilities
        .filter(({ kind }) => kind === 'skill')
        .map(({ name }) => name));
    if (toolName?.startsWith('mcp__') && toolName !== 'mcp__session__update_plan') {
        const [, sourceSlug, ...toolParts] = toolName.split('__');
        const sourceDeclared = Boolean(sourceSlug) && lock.capabilities.some(capability => capability.kind === 'source' && capability.name === sourceSlug);
        const toolDeclared = toolParts.length > 0 && lock.capabilities.some(capability => capability.kind === 'tool' && capability.name === toolName);
        if (!sourceDeclared || !toolDeclared) {
            throw new Error(`Specialized Mission connector tool "${toolName}" is not declared with its source`);
        }
        for (const value of Object.values(input)) {
            if (typeof value !== 'string' || !/^https?:\/\//iu.test(value))
                continue;
            let host: string;
            try {
                host = new URL(value).hostname.toLowerCase();
            }
            catch {
                throw new Error('Specialized Mission connector URL is invalid');
            }
            const allowedHosts = managed.executionIsolation?.policy.allowedHosts
                .map(candidate => candidate.toLowerCase()) ?? [];
            if (!allowedHosts.includes(host)) {
                throw new Error(`Specialized Mission connector host "${host}" is not declared`);
            }
        }
    }
    if (toolName === 'Skill') {
        const raw = typeof input["skill"] === 'string' ? input["skill"] : '';
        const slug = raw.split(':').at(-1) ?? '';
        if (!declaredSkills.has(slug)) {
            throw new Error(`Specialized Mission skill "${slug || '(missing)'}" is not declared`);
        }
        throw new Error(`Specialized Mission skill "${slug}" is already host-sealed inline and cannot be reloaded`);
    }
    const candidatePaths = ['file_path', 'path', 'notebook_path', 'glob', 'pattern']
        .map(key => input[key])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const candidatePath of candidatePaths) {
        const skillPath = candidatePath.replaceAll('\\', '/');
        const referencesSkillPackage = /(?:^|\/)\.?agents\/skills(?:\/|$)/iu.test(skillPath)
            || /(?:^|\/)skills(?:\/|$)/iu.test(skillPath);
        if (!referencesSkillPackage)
            continue;
        throw new Error('Specialized Mission skill packages are host-sealed inline; live package access is forbidden');
    }
    for (const capability of lock.capabilities) {
        let actual: string | null | undefined;
        if (capability.kind === 'skill') {
            actual = resolveSpecializedSkillCapabilityIdentity({
                workspaceRoot: managed.workspace.rootPath,
                ...(managed.workingDirectory !== undefined ? { workingDirectory: managed.workingDirectory } : {}),
                slug: capability.name,
            });
        }
        else if (capability.kind === 'source') {
            actual = await resolveSpecializedSourceCapabilityIdentity({
                workspaceRoot: managed.workspace.rootPath,
                slug: capability.name,
            });
        }
        else {
            continue;
        }
        if (!actual || actual !== capability.identitySha256) {
            throw new Error(`Specialized Mission ${capability.kind} capability "${capability.name}" drifted`);
        }
    }
}

/** Resolve, authenticate, and freeze the exact route consumed by one governed turn. */
async function sessionOpResolveSpecializedMissionRouteSnapshot(_sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<{
    context: ReturnType<typeof resolveBackendContext>;
    connection: LlmConnection;
    credentialBinding: LlmCredentialBinding;
} | undefined> {
    if (!managed.missionRouteLockSha256)
        return undefined;
    assertMissionDispatchWorkingDirectory(managed);
    const mutableTransportOverride = [
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ].find((name) => process.env[name]?.trim());
    if (mutableTransportOverride) {
        throw new Error(`Specialized Mission session cannot use unattested ${mutableTransportOverride} transport overrides`);
    }
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    const resolved = resolveBackendContext({
        ...(managed.llmConnection !== undefined ? { sessionConnectionSlug: managed.llmConnection } : {}),
        ...(workspaceConfig?.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection } : {}),
        ...(managed.model !== undefined ? { managedModel: managed.model } : {}),
    });
    const liveConnection = resolved.connection;
    if (!liveConnection
        || resolved.resolvedModel !== managed.model
        || !managed.llmConnection
        || !managed.model
        || !managed.thinkingLevel) {
        throw new Error('Specialized Mission session evaluated route is unavailable or drifted');
    }
    if (liveConnection.piAuthProvider === 'google-antigravity'
        || liveConnection.piAuthProvider === 'mistral-vibe'
        || (liveConnection.piAuthProvider === 'google-gemini-code-assist'
            && !liveConnection.googleCloudProject?.trim())) {
        throw new Error('Specialized Mission session provider authority is not host-attestable');
    }
    const credentialBinding = await getCredentialManager().getLlmCredentialBinding(liveConnection.slug, liveConnection.authType);
    if (!credentialBinding) {
        throw new Error('Specialized Mission session route has no host-attestable credential generation');
    }
    const runtimeIdentitySha256 = specializedRuntimeIdentitySha256();
    if (!runtimeIdentitySha256) {
        throw new Error('Specialized Mission session runtime has no host-attested build identity');
    }
    // Never pass the mutable config store object to the backend. The exact
    // projection checked below is the same snapshot used for runtime creation.
    const connection = freezeRuntimeSnapshot(structuredClone(liveConnection));
    if (specializedProfileExecutionRouteIdentity({
        id: managed.id,
        llmConnection: managed.llmConnection,
        model: managed.model,
        thinkingLevel: managed.thinkingLevel,
    }, { ...connection, credentialBinding, runtimeIdentitySha256 }) !== managed.missionRouteLockSha256) {
        throw new Error('Specialized Mission session evaluated route is unavailable or drifted');
    }
    return {
        context: { ...resolved, connection },
        connection,
        credentialBinding,
    };
}

/** Final source/config/credential-generation fence called by McpClientPool
 * immediately before the API or MCP source client transport. */
async function sessionOpAssertOrdinaryMissionSourceBindingAtTransport(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, sourceSlug: string): Promise<void> {
    const lock = managed.missionOrdinaryRouteLock;
    if (!lock)
        return;
    assertOrdinaryMissionRouteProjection(managed);
    const expected = lock.effectiveSourceBindings.find(binding => binding.slug === sourceSlug);
    if (!expected) {
        throw new Error(`Ordinary Mission source "${sourceSlug}" is not declared by its route lock`);
    }
    const [actual] = await ordinaryMissionSourceBindings(managed.workspace.rootPath, [sourceSlug]);
    if (!actual || !isDeepStrictEqual(actual, expected)) {
        throw new Error(`Ordinary Mission source "${sourceSlug}" credential binding drifted`);
    }
}

/**
 * Revalidate the durable Mission reservation plus every live identity that
 * can alter an ordinary routed provider call. The returned frozen connection
 * is the same snapshot handed to the backend.
 */
async function sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<{
    context: ReturnType<typeof resolveBackendContext>;
    connection: LlmConnection;
    credentialBinding: LlmCredentialBinding | null;
} | undefined> {
    const lock = managed.missionOrdinaryRouteLock;
    if (!lock)
        return undefined;
    assertOrdinaryMissionRouteProjection(managed);
    const snapshot = assertMissionDispatchWorkingDirectory(managed);
    if (!snapshot) {
        throw new Error('Ordinary Mission durable dispatch binding is unavailable or drifted');
    }
    const runtime = snapshot.workItems[managed.missionWorkItemId!]!;
    if (!runtime.executionBinding?.missionRoute
        || !isDeepStrictEqual(runtime.executionBinding.missionRoute, lock)) {
        throw new Error('Ordinary Mission durable dispatch binding is unavailable or drifted');
    }
    const definition = runtime.definition;
    const profileId = runtime.agentProfileId
        ?? definition.agentProfileId
        ?? (definition.kind === 'objective-review'
            ? snapshot.spec.reviewerProfileId
            : definition.kind === 'final-review'
                ? snapshot.spec.supervisorProfileId
                : snapshot.spec.defaultWorkerProfileId);
    const profile = snapshot.spec.agentProfiles.find(candidate => candidate.id === profileId);
    if (!profile || profile.id !== lock.agentProfileId) {
        throw new Error('Ordinary Mission agent profile is unavailable or drifted');
    }
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    if (!workspaceConfig) {
        throw new Error('Ordinary Mission workspace configuration is unavailable');
    }
    const originManaged = snapshot.spec.originSessionId
        ? sessionOperationContext.state.sessions.get(snapshot.spec.originSessionId)
        : undefined;
    const origin = originManaged ? managedToSession(originManaged) : undefined;
    if (ordinaryMissionRouteConfigIdentity({
        profile,
        config: workspaceConfig,
        ...(origin !== undefined ? { origin: origin } : {}),
        defaults: {
            defaultLlmConnection: getDefaultLlmConnection(),
            defaultThinkingLevel: getDefaultThinkingLevel(),
        },
    }) !== lock.routeConfigIdentitySha256) {
        throw new Error('Ordinary Mission route configuration drifted before provider handoff');
    }
    const effectiveSourceSlugs = effectiveOrdinaryMissionSourceSlugs(profile, workspaceConfig);
    const effectiveSourceBindings = await ordinaryMissionSourceBindings(managed.workspace.rootPath, effectiveSourceSlugs);
    if (!isDeepStrictEqual(effectiveSourceSlugs, lock.effectiveSourceSlugs)
        || !isDeepStrictEqual(effectiveSourceBindings, lock.effectiveSourceBindings)
        || ordinaryMissionSourceIdentityFromBindings(effectiveSourceBindings)
            !== lock.sourceIdentitySha256) {
        throw new Error('Ordinary Mission source configuration or credential binding drifted');
    }
    const runtimeIdentitySha256 = specializedRuntimeIdentitySha256() ?? undefined;
    if (lock.runtimeIdentitySha256
        && lock.runtimeIdentitySha256 !== runtimeIdentitySha256) {
        throw new Error('Ordinary Mission host runtime identity drifted before provider handoff');
    }
    const liveConnection = getLlmConnection(lock.connectionSlug);
    if (!liveConnection) {
        throw new Error('Ordinary Mission connection is unavailable before provider handoff');
    }
    const resolved = resolveBackendContext({
        sessionConnectionSlug: lock.connectionSlug,
        ...(workspaceConfig.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: workspaceConfig.defaults?.defaultLlmConnection } : {}),
        managedModel: lock.model,
    });
    if (!resolved.connection
        || resolved.connection.slug !== lock.connectionSlug
        || resolved.resolvedModel !== lock.model) {
        throw new Error('Ordinary Mission connection or model is unavailable before provider handoff');
    }
    let credentialBinding: LlmCredentialBinding | null = null;
    const connectionIdentitySha256 = await ordinaryMissionConnectionIdentity({
        agentProfileId: lock.agentProfileId,
        connection: liveConnection,
        connectionSlug: lock.connectionSlug,
        model: lock.model,
        thinkingLevel: lock.thinkingLevel,
        ...(lock.runtimeIdentitySha256 !== undefined ? { runtimeIdentitySha256: lock.runtimeIdentitySha256 } : {}),
        credentialBindingResolver: async (connection) => {
            credentialBinding = connection.authType
                ? await getCredentialManager().getLlmCredentialBinding(connection.slug, connection.authType)
                : null;
            return credentialBinding;
        },
    });
    if (connectionIdentitySha256 !== lock.connectionIdentitySha256) {
        throw new Error('Ordinary Mission connection, authentication, or credential binding drifted');
    }
    const connection = freezeRuntimeSnapshot(structuredClone(liveConnection));
    return {
        context: { ...resolved, connection },
        connection,
        credentialBinding,
    };
}

/** Last provider boundary shared by routed, specialized, and routing-off Missions. */
async function sessionOpAssertMissionProviderExecution(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    if (managed.missionRouteLockSha256) {
        await sessionOpResolveSpecializedMissionRouteSnapshot(sessionOperationContext, managed);
        return;
    }
    if (managed.missionOrdinaryRouteLock) {
        await sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext, managed);
        return;
    }
    assertMissionDispatchWorkingDirectory(managed);
}

export { sessionOpAssertSpecializedMissionCapabilities as assertSpecializedMissionCapabilities };
export { sessionOpResolveSpecializedMissionRouteSnapshot as resolveSpecializedMissionRouteSnapshot };
export { sessionOpAssertOrdinaryMissionSourceBindingAtTransport as assertOrdinaryMissionSourceBindingAtTransport };
export { sessionOpResolveOrdinaryMissionRouteSnapshot as resolveOrdinaryMissionRouteSnapshot };
export { sessionOpAssertMissionProviderExecution as assertMissionProviderExecution };
