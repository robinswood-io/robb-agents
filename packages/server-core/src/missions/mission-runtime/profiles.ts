import { getLlmConnections } from "@craft-agent/shared/config";
import { listMissionIds, type MissionSnapshot } from "@craft-agent/shared/missions";
import { getCredentialManager } from "@craft-agent/shared/credentials";
import { resolveSubagentAutonomy } from "../../subagents/autonomy-inheritance.ts";
import { MissionSpecializedProfileResolver, resolveConfiguredMissionCapabilities, specializedProfileExecutionRouteIdentity, type SpecializedProfileCapabilityResolver } from "../../specialized-profiles/MissionSpecializedProfileResolver.ts";
import { SpecializedProfileService, loadSpecializedProfileRegistryForMission } from "../../specialized-profiles/SpecializedProfileService.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { normalizedError } from './shared.ts';
import type { MissionWorkspace, WorkspaceMissionRuntime } from './shared.ts';

export async function getSpecializedProfileFoundry(transportOwner: MissionRuntimeService, workspaceId: string): Promise<SpecializedProfileService> {
    const existing = transportOwner["specializedProfileFoundries"].get(workspaceId);
    if (existing)
        return existing;
    const workspace = transportOwner["resolveWorkspace"](workspaceId);
    if (!workspace)
        throw new Error(`Workspace ${workspaceId} not found`);
    const foundry = new SpecializedProfileService({
        resolveWorkspace: (candidate) => candidate === workspace.id ? workspace : null,
        listMissions: async (candidate) => {
            if (candidate !== workspace.id)
                throw new Error(`Workspace ${candidate} not found`);
            const context = await transportOwner["contextFor"](candidate);
            return listMissionIds(workspace.rootPath)
                .map((missionId) => context.controller.getMission(missionId));
        },
        ...(transportOwner["options"].specializedProfileNow ? { now: transportOwner["options"].specializedProfileNow } : {}),
        ...(transportOwner["options"].specializedProfileAuthorityKeyLoader
            ? { loadAuthorityKey: transportOwner["options"].specializedProfileAuthorityKeyLoader }
            : {}),
        ...(transportOwner["options"].specializedProfileAnchorStore
            ? { anchorStore: transportOwner["options"].specializedProfileAnchorStore }
            : {}),
        ...(transportOwner["options"].specializedProfileHumanApprovalProvider
            ? { humanApprovalProvider: transportOwner["options"].specializedProfileHumanApprovalProvider }
            : {}),
        ...(transportOwner["options"].specializedProfileCorpusLineageProvider
            ? { corpusLineageProvider: transportOwner["options"].specializedProfileCorpusLineageProvider }
            : {}),
        missionEvidenceProvider: transportOwner["options"].specializedProfileMissionEvidenceProvider ?? {
            loadVerified: async ({ workspaceId: candidate, missionId }) => {
                if (candidate !== workspace.id)
                    throw new Error(`Workspace ${candidate} not found`);
                const context = await transportOwner["contextFor"](candidate);
                const snapshot = context.controller.getMission(missionId);
                if (!context.proofPassports) {
                    throw new Error(`Mission "${missionId}" has no host outcome attestation issuer`);
                }
                if (snapshot.status === 'completed') {
                    const verified = context.proofPassports.verifySnapshot(missionId);
                    if (!verified.valid)
                        throw new Error(verified.reason);
                    return {
                        snapshot: verified.snapshot,
                        evidence: {
                            uri: `proof-passport://${candidate}/${missionId}/${verified.passport.passportId}`,
                            sha256: verified.passport.missionJournalSha256,
                        },
                    };
                }
                const verified = context.proofPassports.verifyTerminalSnapshot(missionId);
                if (!verified.valid)
                    throw new Error(verified.reason);
                return {
                    snapshot: verified.snapshot,
                    evidence: {
                        uri: `mission-attestation://${candidate}/${missionId}/${verified.attestation.attestationId}`,
                        sha256: verified.attestation.missionJournalSha256,
                    },
                };
            },
        },
    });
    transportOwner["specializedProfileFoundries"].set(workspaceId, foundry);
    return foundry;
}

export function createSpecializedProfileResolver(transportOwner: MissionRuntimeService, workspace: MissionWorkspace): MissionSpecializedProfileResolver {
    const resolveCapabilities: SpecializedProfileCapabilityResolver = transportOwner["options"].specializedProfileCapabilityResolver
        ?? ((input) => {
            const autonomy = resolveSubagentAutonomy({
                ...(transportOwner["options"].resolveSubagentAutonomyContext?.(workspace, input.spec.originSessionId) ?? {}),
                requestedPermissionMode: input.profile.permissionMode,
            });
            return resolveConfiguredMissionCapabilities(input, {
                workspaceWrite: autonomy.permissionMode !== 'safe',
                network: autonomy.grantsFullToolAndNetworkAccess,
                externalMutation: Boolean(transportOwner["options"].connectorExecutorFactory),
            });
        });
    return new MissionSpecializedProfileResolver({
        workspace,
        resolveCapabilities,
        resolveExecutionRouteIdentity: transportOwner["options"].specializedProfileRouteIdentityResolver
            ?? (async (input) => {
                const connection = getLlmConnections().find(({ slug }) => slug === input.profile.llmConnection);
                if (!connection) {
                    throw new Error(`Specialized Mission profile "${input.profile.id}" references unavailable connection "${input.profile.llmConnection}"`);
                }
                if (connection.piAuthProvider === 'google-antigravity'
                    || connection.piAuthProvider === 'mistral-vibe') {
                    throw new Error(`Specialized Mission connection "${connection.slug}" uses an external provider whose principal and executable are not host-attestable`);
                }
                if (connection.piAuthProvider === 'google-gemini-code-assist'
                    && !connection.googleCloudProject?.trim()) {
                    throw new Error(`Specialized Mission connection "${connection.slug}" has no explicit Google Cloud project`);
                }
                const mutableTransportOverride = [
                    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
                ].find((name) => process.env[name]?.trim());
                if (mutableTransportOverride) {
                    throw new Error(`Specialized Mission connection "${connection.slug}" cannot use unattested ${mutableTransportOverride} transport overrides`);
                }
                const credentialBinding = await getCredentialManager().getLlmCredentialBinding(connection.slug, connection.authType);
                if (!credentialBinding) {
                    throw new Error(`Specialized Mission connection "${connection.slug}" has no host-attestable credential generation`);
                }
                if (!transportOwner["options"].specializedProfileRuntimeIdentitySha256
                    || !/^[a-f0-9]{64}$/.test(transportOwner["options"].specializedProfileRuntimeIdentitySha256)) {
                    throw new Error('Specialized Mission runtime has no host-attested build identity');
                }
                return specializedProfileExecutionRouteIdentity(input.profile, {
                    slug: connection.slug,
                    providerType: connection.providerType,
                    type: connection.type ?? null,
                    baseUrl: connection.baseUrl ?? null,
                    authType: connection.authType,
                    models: connection.models ?? [],
                    defaultModel: connection.defaultModel ?? null,
                    modelSelectionMode: connection.modelSelectionMode ?? null,
                    piAuthProvider: connection.piAuthProvider ?? null,
                    googleCloudProject: connection.googleCloudProject ?? null,
                    customEndpoint: connection.customEndpoint ?? null,
                    oauthAccountUuid: connection.oauthAccountUuid ?? null,
                    oauthAccountEmail: connection.oauthAccountEmail ?? null,
                    oauthOrganizationUuid: connection.oauthOrganizationUuid ?? null,
                    credentialBinding,
                    runtimeIdentitySha256: transportOwner["options"].specializedProfileRuntimeIdentitySha256,
                });
            }),
        loadRegistry: transportOwner["options"].specializedProfileRegistryLoader
            ?? ((candidate) => loadSpecializedProfileRegistryForMission(candidate, {
                ...(transportOwner["options"].specializedProfileNow ? { now: transportOwner["options"].specializedProfileNow } : {}),
                ...(transportOwner["options"].specializedProfileAnchorStore
                    ? { anchorStore: transportOwner["options"].specializedProfileAnchorStore }
                    : {}),
                ...(transportOwner["options"].specializedProfileAuthorityKeyLoader
                    ? { loadAuthorityKey: transportOwner["options"].specializedProfileAuthorityKeyLoader }
                    : {}),
            })),
        ...(transportOwner["options"].specializedProfileNow ? { now: transportOwner["options"].specializedProfileNow } : {}),
    });
}

export async function getProofPassport(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string) {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    context.controller.getMission(missionId);
    return context.proofPassports?.read(missionId) ?? null;
}

export async function getProofPassportTrustAnchor(transportOwner: MissionRuntimeService, workspaceId: string) {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    if (!context.proofPassports) {
        throw new Error('Proof Passport issuance is disabled for this runtime');
    }
    return context.proofPassports.getTrustAnchor();
}

export async function verifyProofPassport(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string) {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    context.controller.getMission(missionId);
    return context.proofPassports?.verify(missionId) ?? {
        valid: false as const,
        reason: 'Proof Passport issuance is disabled for this runtime',
    };
}

export function ensureCompletionPassport(transportOwner: MissionRuntimeService, context: WorkspaceMissionRuntime, snapshot: MissionSnapshot): boolean {
    if (!['completed', 'failed'].includes(snapshot.status) || !context.proofPassports)
        return true;
    try {
        context.proofPassports.issueTerminalAttestation(snapshot);
        if (snapshot.status === 'completed')
            context.proofPassports.issue(snapshot);
    }
    catch (error) {
        transportOwner["reportError"]({
            workspaceId: context.workspace.id,
            missionId: snapshot.spec.id,
            error: normalizedError(error),
        });
        return false;
    }
    if (snapshot.status !== 'completed')
        return true;
    try {
        { }
    }
    catch (error) {
        // Local routing feedback must never invalidate an already-issued proof
        // passport or suppress the final user report.
        transportOwner["reportError"]({
            workspaceId: context.workspace.id,
            missionId: snapshot.spec.id,
            error: normalizedError(error),
        });
    }
    return true;
}
