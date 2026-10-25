import { type AgentProfile, type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import { SpecializedMissionProfileSelectionError, specializedProfileExecutionRouteIdentity as sharedExecutionRouteIdentity, type SpecializedMissionCapability } from "@craft-agent/shared/specialized-profiles";
import { loadWorkspaceSources } from "@craft-agent/shared/sources";
import { resolveSpecializedSkillCapabilityIdentity, resolveSpecializedSourceCapabilityBinding, specializedCapabilityIdentity, stableCapabilityJson } from "../capability-identity.ts";
import type { SpecializedProfileCapabilityResolutionInput } from './contracts.ts';

/**
 * Resolve declarations against concrete host state. Security-sensitive effects
 * default to unavailable unless the embedding runtime explicitly authorizes
 * them through the flags below.
 */
export async function resolveConfiguredMissionCapabilities(
  input: SpecializedProfileCapabilityResolutionInput,
  authorization: {
    workspaceWrite?: boolean;
    network?: boolean;
    externalMutation?: boolean;
    tools?: readonly string[];
  } = {},
): Promise<SpecializedMissionCapability[]> {
  // Resolve each slug through the same project > workspace > global precedence
  // as BaseAgent. loadSkillBySlug is uncached, so an immediate override/edit is
  // sealed before every admission and dispatch.
  const loadedSources = new Map(loadWorkspaceSources(input.workspace.rootPath)
    .filter(({ config }) => config.enabled)
    .map((source) => [source.config.slug, source]));
  const tools = new Set(authorization.tools ?? []);
  const executionBoundaries = input.assignedItems.map((item) => {
    const execution = item.execution ?? input.spec.execution;
    return {
      itemId: item.id,
      rootPath: execution?.root_path ?? null,
      allowedReadPaths: [...(execution?.allowed_read_paths ?? [])].sort(),
      allowedWritePaths: [...(execution?.allowed_write_paths ?? [])].sort(),
      networkAccess: execution?.network_access ?? 'disabled',
      allowedHosts: [...(execution?.allowed_hosts ?? [])].sort(),
    };
  }).sort((left, right) => left.itemId.localeCompare(right.itemId));
  const capabilities: SpecializedMissionCapability[] = [{
    kind: 'workspace-read',
    name: 'workspace',
    identitySha256: capabilityIdentity({
      workspaceId: input.workspace.id,
      workspaceRoot: input.workspace.rootPath,
      executionBoundaries: uniqueCanonical(executionBoundaries.map(({
        itemId: _itemId,
        allowedWritePaths: _writes,
        ...boundary
      }) => boundary)),
    }),
  }];
  for (const name of input.profile.skills) {
    const identitySha256 = resolveSpecializedSkillCapabilityIdentity({
      workspaceRoot: input.workspace.rootPath,
      workingDirectory: input.spec.cwd,
      slug: name,
    });
    if (identitySha256) {
      capabilities.push({
        kind: 'skill',
        name,
        identitySha256,
      });
    }
  }
  for (const name of input.profile.sources) {
    const source = loadedSources.get(name);
    if (source) {
      if (source.config.type === 'mcp' && source.config.mcp?.transport === 'stdio') {
        throw new SpecializedMissionProfileSelectionError(
          `Specialized source "${name}" uses an unattested local stdio executable`,
        );
      }
      const binding = await resolveSpecializedSourceCapabilityBinding({
        workspaceRoot: input.workspace.rootPath,
        slug: name,
      });
      if (!binding) continue;
      capabilities.push({
        kind: 'source',
        name,
        ...binding,
      });
    }
  }
  for (const name of input.profile.tools) {
    if (tools.has(name)) capabilities.push({
      kind: 'tool',
      name,
      identitySha256: capabilityIdentity({ tool: name }),
    });
  }
  for (const item of input.assignedItems) {
    if (authorization.workspaceWrite && item.effect === 'workspace-write') {
      capabilities.push({
        kind: 'workspace-write',
        name: 'workspace',
        identitySha256: capabilityIdentity({
          workspaceId: input.workspace.id,
          workspaceRoot: input.workspace.rootPath,
          execution: (({ itemId: _itemId, ...boundary }) => boundary)(
            executionBoundaries.find(({ itemId }) => itemId === item.id)!,
          ),
        }),
      });
    }
    if (authorization.externalMutation && item.effect === 'external-mutation' && item.connectorInvocation) {
      capabilities.push({
        kind: 'external-mutation',
        name: item.connectorInvocation.pack,
        identitySha256: capabilityIdentity(item.connectorInvocation),
      });
    }
    const execution = item.execution ?? input.spec.execution;
    if (authorization.network && execution
      && (execution.network_access !== 'disabled' || execution.allowed_hosts.length > 0)) {
      capabilities.push({
        kind: 'network',
        name: 'allow-listed-network',
        identitySha256: capabilityIdentity({
          networkAccess: execution.network_access,
          allowedHosts: [...execution.allowed_hosts].sort(),
        }),
      });
    }
  }
  return deduplicateCapabilities(capabilities);
}

export function profileForItem(spec: MissionSpec, item: MissionWorkItem): string | undefined {
  if (item.agentProfileId) return item.agentProfileId;
  if (item.kind === 'objective-review') return spec.reviewerProfileId;
  if (item.kind === 'final-review') return spec.supervisorProfileId;
  if (['task', 'subtask', 'integration', 'correction'].includes(item.kind)) {
    return spec.defaultWorkerProfileId;
  }
  return undefined;
}

export function deduplicateCapabilities(
  capabilities: readonly SpecializedMissionCapability[],
): SpecializedMissionCapability[] {
  const unique = new Map<string, SpecializedMissionCapability>();
  for (const capability of capabilities) {
    const key = `${capability.kind}\u0000${capability.name}`;
    const existing = unique.get(key);
    if (!existing || existing.identitySha256 === capability.identitySha256) {
      unique.set(key, capability);
    } else {
      unique.set(key, {
        kind: capability.kind,
        name: capability.name,
        identitySha256: capabilityIdentity(
          [existing.identitySha256 ?? '', capability.identitySha256 ?? ''].sort(),
        ),
      });
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

function capabilityIdentity(value: unknown): string {
  return specializedCapabilityIdentity(value);
}

function uniqueCanonical<T>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(stableCapabilityJson(value), value);
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

export function specializedProfileExecutionRouteIdentity(
  profile: AgentProfile,
  effectiveConnection?: unknown,
): string {
  return sharedExecutionRouteIdentity(profile, effectiveConnection);
}
