import { type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import { authorizeWorkspacePath } from "@craft-agent/shared/tasks";
import { resolveSubagentAutonomy } from "../../subagents/autonomy-inheritance.ts";
import { canonicalMissionWorkingDirectory, canonicalMissionWorkspacePath } from "../mission-workspace-path.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import type { MissionWorkspace } from './shared.ts';

export function assertAdmissible(transportOwner: MissionRuntimeService, workspace: MissionWorkspace, spec: MissionSpec): void {
    const missionCwd = canonicalMissionWorkingDirectory(workspace.rootPath, spec.cwd);
    const policies = [spec.execution, ...spec.workItems.map((item) => item.execution)].filter(Boolean);
    const autonomyContext = transportOwner["options"].resolveSubagentAutonomyContext?.(workspace, spec.originSessionId) ?? {};
    const profileAutonomy = new Map(spec.agentProfiles.map((profile) => [
        profile.id,
        resolveSubagentAutonomy({
            ...autonomyContext,
            requestedPermissionMode: profile.permissionMode,
        }),
    ]));
    if (spec.workItems.some((item) => item.effect === 'external-mutation')) {
        if (!transportOwner["options"].connectorExecutorFactory) {
            throw new Error('Mission external mutations require a broker-backed connector worker');
        }
    }
    if (spec.execution && (spec.execution.network_access !== 'disabled' || spec.execution.allowed_hosts.length > 0)) {
        const runtimeProfileIds = new Set([
            spec.defaultWorkerProfileId,
            spec.reviewerProfileId,
            spec.supervisorProfileId,
            ...spec.workItems.flatMap((item) => item.agentProfileId ? [item.agentProfileId] : []),
        ]);
        if ([...runtimeProfileIds].some((profileId) => !profileAutonomy.get(profileId)?.grantsFullToolAndNetworkAccess)) {
            throw new Error('Mission-wide network access requires fully inherited Execute autonomy for every runtime profile');
        }
    }
    for (const item of spec.workItems) {
        if (!item.execution || (item.execution.network_access === 'disabled' && item.execution.allowed_hosts.length === 0))
            continue;
        const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
        if (!profileAutonomy.get(profileId)?.grantsFullToolAndNetworkAccess) {
            throw new Error(`Mission network access for work item "${item.id}" requires fully inherited Execute autonomy`);
        }
    }
    if (policies.some((policy) => policy!.max_cpu_percent !== undefined || policy!.max_memory_mb !== undefined)) {
        throw new Error('Mission CPU or memory limits require an enforceable worker sandbox');
    }
    for (const policy of policies) {
        const rootPath = canonicalMissionWorkspacePath(workspace.rootPath, policy!.root_path ?? missionCwd, 'execution root');
        for (const candidate of [...policy!.allowed_read_paths, ...policy!.allowed_write_paths]) {
            const pathDecision = authorizeWorkspacePath(rootPath, candidate, ['.']);
            if (!pathDecision.allowed) {
                throw new Error(`Mission execution path is not authorized: ${pathDecision.reason}`);
            }
        }
    }
    for (const item of spec.workItems.filter((candidate) => candidate.effect === 'workspace-write')) {
        const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
        const profile = spec.agentProfiles.find((candidate) => candidate.id === profileId);
        const effectivePermissionMode = profileAutonomy.get(profileId)?.permissionMode ?? 'safe';
        if (!profile || effectivePermissionMode === 'safe') {
            throw new Error(`Workspace-write work item "${item.id}" requires an ask or allow-all worker profile`);
        }
        const execution = item.execution ?? spec.execution;
        if (!execution || execution.allowed_write_paths.length === 0) {
            throw new Error(`Workspace-write work item "${item.id}" requires explicit allowed_write_paths`);
        }
    }
}

export function workItemPathsAreAuthorized(transportOwner: MissionRuntimeService, workspace: MissionWorkspace, spec: MissionSpec, item: MissionWorkItem): boolean {
    const execution = item.execution ?? spec.execution;
    const autonomyContext = transportOwner["options"].resolveSubagentAutonomyContext?.(workspace, spec.originSessionId) ?? {};
    const resolveProfileAutonomy = (profileId: string) => {
        const profile = spec.agentProfiles.find((candidate) => candidate.id === profileId);
        return profile
            ? resolveSubagentAutonomy({
                ...autonomyContext,
                requestedPermissionMode: profile.permissionMode,
            })
            : null;
    };
    const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
    const profileAutonomy = resolveProfileAutonomy(profileId);
    if (!profileAutonomy)
        return false;
    if (item.effect === 'workspace-write' && profileAutonomy.permissionMode === 'safe')
        return false;
    if (execution && (execution.network_access !== 'disabled' || execution.allowed_hosts.length > 0) && !profileAutonomy.grantsFullToolAndNetworkAccess)
        return false;
    if (execution?.max_cpu_percent !== undefined || execution?.max_memory_mb !== undefined)
        return false;
    if (spec.execution && (spec.execution.network_access !== 'disabled' || spec.execution.allowed_hosts.length > 0)) {
        const runtimeProfileIds = new Set([
            spec.defaultWorkerProfileId,
            spec.reviewerProfileId,
            spec.supervisorProfileId,
            ...spec.workItems.flatMap((candidate) => candidate.agentProfileId ? [candidate.agentProfileId] : []),
        ]);
        if ([...runtimeProfileIds].some((runtimeProfileId) => !resolveProfileAutonomy(runtimeProfileId)?.grantsFullToolAndNetworkAccess))
            return false;
    }
    let rootPath: string;
    try {
        const missionCwd = canonicalMissionWorkingDirectory(workspace.rootPath, spec.cwd);
        rootPath = canonicalMissionWorkspacePath(workspace.rootPath, execution?.root_path ?? missionCwd, 'execution root');
    }
    catch {
        return false;
    }
    if (!execution)
        return item.effect !== 'workspace-write';
    const candidates = [...execution.allowed_read_paths, ...execution.allowed_write_paths];
    if (candidates.some((candidate) => !authorizeWorkspacePath(rootPath, candidate, ['.']).allowed)) {
        return false;
    }
    return item.effect !== 'workspace-write' || execution.allowed_write_paths.length > 0;
}
