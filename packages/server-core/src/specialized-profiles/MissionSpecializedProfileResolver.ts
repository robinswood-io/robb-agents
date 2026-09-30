import {
  MissionSpecSchema,
  type AgentProfile,
  type MissionSpec,
  type MissionWorkItem,
} from '@craft-agent/shared/missions';
import {
  SPECIALIZED_MISSION_PROFILE_ID_PREFIX,
  SpecializedMissionProfileSelectionError,
  parseSpecializedMissionProfileReference,
  selectSpecializedMissionProfile,
  specializedProfileExecutionRouteIdentity as sharedExecutionRouteIdentity,
  type SpecializedMissionCapability,
  type SpecializedProfileEvaluation,
  type SpecializedProfileRegistryDocument,
} from '@craft-agent/shared/specialized-profiles';
import type {
  MissionExecutionInput,
  MissionExecutionLifecycle,
  MissionExecutionResult,
  MissionWorkExecutor,
} from '../missions/MissionRuntime.ts';
import { loadWorkspaceSources } from '@craft-agent/shared/sources';
import {
  loadSpecializedProfileRegistryForMission,
  type SpecializedProfileWorkspace,
} from './SpecializedProfileService.ts';
import { classifyMissionTaskFamily } from './mission-observations.ts';
import {
  resolveSpecializedSkillCapabilityIdentity,
  resolveSpecializedSourceCapabilityBinding,
  specializedCapabilityIdentity,
  stableCapabilityJson,
} from './capability-identity.ts';

export type SpecializedProfileRegistryLoader = (
  workspace: SpecializedProfileWorkspace,
) => Promise<SpecializedProfileRegistryDocument | null>;

export interface MissionSpecializedProfileResolverOptions {
  workspace: SpecializedProfileWorkspace;
  loadRegistry?: SpecializedProfileRegistryLoader;
  resolveCapabilities?: SpecializedProfileCapabilityResolver;
  resolveExecutionRouteIdentity?: SpecializedProfileExecutionRouteIdentityResolver;
  classifyTaskFamily?: SpecializedProfileTaskFamilyClassifier;
  now?: () => Date;
}

export interface SpecializedProfileCapabilityResolutionInput {
  workspace: SpecializedProfileWorkspace;
  spec: MissionSpec;
  profile: AgentProfile;
  assignedItems: readonly MissionWorkItem[];
  dispatchedItem?: MissionWorkItem;
}

export type SpecializedProfileCapabilityResolver = (
  input: SpecializedProfileCapabilityResolutionInput,
) => Promise<readonly SpecializedMissionCapability[]> | readonly SpecializedMissionCapability[];

export type SpecializedProfileExecutionRouteIdentityResolver = (
  input: SpecializedProfileCapabilityResolutionInput,
) => Promise<string> | string;

export type SpecializedProfileTaskFamilyClassifier = (input: {
  workspace: SpecializedProfileWorkspace;
  spec: MissionSpec;
  assignedItems: readonly MissionWorkItem[];
}) => Promise<string | null> | string | null;

/**
 * Workspace-scoped resolver used at both Mission admission and dispatch. A
 * qualified profile is requested only through the reserved `specialist-*` id;
 * lifecycle state alone never injects it into an unrelated Mission.
 */
export class MissionSpecializedProfileResolver {
  private readonly loadRegistry: SpecializedProfileRegistryLoader;
  private readonly now: () => Date;
  private readonly resolveCapabilities: SpecializedProfileCapabilityResolver;
  private readonly resolveExecutionRouteIdentity: SpecializedProfileExecutionRouteIdentityResolver;
  private readonly classifyTaskFamily: SpecializedProfileTaskFamilyClassifier;

  constructor(private readonly options: MissionSpecializedProfileResolverOptions) {
    this.loadRegistry = options.loadRegistry ?? loadSpecializedProfileRegistryForMission;
    this.resolveCapabilities = options.resolveCapabilities
      ?? ((input) => resolveConfiguredMissionCapabilities(input));
    this.resolveExecutionRouteIdentity = options.resolveExecutionRouteIdentity
      ?? ((input) => specializedProfileExecutionRouteIdentity(input.profile));
    this.classifyTaskFamily = options.classifyTaskFamily ?? (({ spec, assignedItems }) =>
      classifyMissionTaskFamily({
        title: spec.title,
        objective: spec.objective,
        items: assignedItems,
      }));
    this.now = options.now ?? (() => new Date());
  }

  async bindMissionSpec(spec: MissionSpec): Promise<MissionSpec> {
    return this.resolveMissionSpec(spec, false);
  }

  /** Host-internal admission path for governed stage evaluation Missions. */
  async bindEvaluationMissionSpec(
    spec: MissionSpec,
    profileId: string,
    stage: SpecializedProfileEvaluation['stage'],
    cohortId: string,
  ): Promise<MissionSpec> {
    if (!profileId.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX)) {
      throw new SpecializedMissionProfileSelectionError(
        `Evaluation profile "${profileId}" does not use the reserved specialized profile id`,
      );
    }
    if (!spec.agentProfiles.some(({ id }) => id === profileId)) {
      throw new SpecializedMissionProfileSelectionError(
        `Evaluation Mission does not declare specialized profile "${profileId}"`,
      );
    }
    if (!cohortId.trim()) {
      throw new SpecializedMissionProfileSelectionError('Evaluation campaign id is required');
    }
    return this.resolveMissionSpec(spec, false, { profileId, stage, cohortId: cohortId.trim() });
  }

  /** Revalidate a host-persisted binding during preflight, replan and recovery. */
  async revalidateMissionSpec(spec: MissionSpec): Promise<MissionSpec> {
    return this.resolveMissionSpec(spec, true);
  }

  private async resolveMissionSpec(
    spec: MissionSpec,
    allowExistingBindings: boolean,
    evaluation?: {
      profileId: string;
      stage: SpecializedProfileEvaluation['stage'];
      cohortId: string;
    },
  ): Promise<MissionSpec> {
    const requested = spec.agentProfiles.filter((profile) =>
      profile.id.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX)
      || parseSpecializedMissionProfileReference(profile.systemPrompt) !== null);
    if (requested.length === 0) return spec;
    for (const profile of requested) {
      const existing = parseSpecializedMissionProfileReference(profile.systemPrompt);
      const reservedId = profile.id.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX);
      if (existing && !reservedId) {
        throw new SpecializedMissionProfileSelectionError(
          `Mission profile "${profile.id}" cannot carry reserved specialized profile binding metadata`,
        );
      }
      if (existing && !allowExistingBindings) {
        throw new SpecializedMissionProfileSelectionError(
          `Mission input cannot supply reserved specialized profile binding metadata for "${profile.id}"`,
        );
      }
      if (!existing && allowExistingBindings) {
        throw new SpecializedMissionProfileSelectionError(
          `Persisted specialized Mission profile "${profile.id}" has no host binding metadata`,
        );
      }
    }

    const registry = await this.loadRegistry(this.options.workspace);
    const profiles = await Promise.all(spec.agentProfiles.map(async (profile) => {
      if (!profile.id.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX)) return profile;
      const expected = parseSpecializedMissionProfileReference(profile.systemPrompt) ?? undefined;
      const selection = selectSpecializedMissionProfile({
        requestedProfile: profile,
        registry,
        context: await this.selectionContext(spec, profile),
        at: this.now(),
        ...(expected ? { expected } : {}),
        ...(evaluation?.profileId === profile.id ? {
          evaluationStage: evaluation.stage,
          evaluationCohortId: evaluation.cohortId,
        } : {}),
      });
      if (!selection) {
        throw new SpecializedMissionProfileSelectionError(
          `Specialized Mission profile "${profile.id}" was not selected`,
        );
      }
      return selection.profile;
    }));
    return MissionSpecSchema.parse({ ...spec, agentProfiles: profiles });
  }

  async resolveExecutionInput(input: MissionExecutionInput): Promise<MissionExecutionInput> {
    const expected = parseSpecializedMissionProfileReference(input.profile.systemPrompt);
    if (!expected && !input.profile.id.startsWith(SPECIALIZED_MISSION_PROFILE_ID_PREFIX)) return input;
    const registry = await this.loadRegistry(this.options.workspace);
    const selection = selectSpecializedMissionProfile({
      requestedProfile: input.profile,
      registry,
      context: await this.selectionContext(input.mission, input.profile, input.item),
      at: this.now(),
      ...(expected ? { expected } : {}),
    });
    if (!selection) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${input.profile.id}" was not selected`,
      );
    }
    return {
      ...input,
      profile: selection.profile,
      specializedProfile: selection.binding,
    };
  }

  private async selectionContext(
    spec: MissionSpec,
    profile: AgentProfile,
    dispatchedItem?: MissionWorkItem,
  ): Promise<{
    fields: Readonly<Record<string, unknown>>;
    capabilities: readonly SpecializedMissionCapability[];
    executionRouteSha256: string;
  }> {
    const assignedItems = spec.workItems.filter((item) => profileForItem(spec, item) === profile.id);
    const effectiveAssignedItems = dispatchedItem
      && profileForItem(spec, dispatchedItem) === profile.id
      && !assignedItems.some(({ id }) => id === dispatchedItem.id)
      ? [...assignedItems, dispatchedItem]
      : assignedItems;
    const taskFamily = await this.classifyTaskFamily({
      workspace: this.options.workspace,
      spec,
      assignedItems: effectiveAssignedItems,
    });
    if (!profile.llmConnection || !profile.model || !profile.thinkingLevel) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${profile.id}" must pin connection, model, and thinking level explicitly`,
      );
    }
    const routeInput = {
      workspace: this.options.workspace,
      spec,
      profile,
      assignedItems: effectiveAssignedItems,
      ...(dispatchedItem ? { dispatchedItem } : {}),
    };
    return {
      fields: selectionFields(spec, taskFamily, dispatchedItem),
      capabilities: deduplicateCapabilities(await this.resolveCapabilities(routeInput)),
      executionRouteSha256: await this.resolveExecutionRouteIdentity(routeInput),
    };
  }
}

/** Revalidates a specialized binding immediately before every executor boundary. */
export class SpecializedProfileMissionExecutor implements MissionWorkExecutor {
  constructor(
    private readonly executor: MissionWorkExecutor,
    private readonly resolver: MissionSpecializedProfileResolver,
  ) {}

  async prepare(input: MissionExecutionInput) {
    const resolved = await this.resolver.resolveExecutionInput(input);
    const binding = await this.executor.prepare(resolved);
    return resolved.specializedProfile
      ? {
        ...binding,
        specializedProfile: specializedBindingFingerprint(resolved.specializedProfile),
      }
      : binding;
  }

  async execute(
    input: MissionExecutionInput,
    binding: Awaited<ReturnType<MissionWorkExecutor['prepare']>>,
    lifecycle?: MissionExecutionLifecycle,
  ): Promise<MissionExecutionResult> {
    const resolved = await this.resolver.resolveExecutionInput(input);
    const expected = resolved.specializedProfile
      ? specializedBindingFingerprint(resolved.specializedProfile)
      : undefined;
    if (!sameSpecializedBindingFingerprint(binding.specializedProfile, expected)) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${input.profile.id}" changed between prepare and execute`,
      );
    }
    const { specializedProfile: _fingerprint, ...underlyingBinding } = binding;
    const result = await this.executor.execute(resolved, underlyingBinding, lifecycle);
    // A revocation, downgrade, route change, or capability drift while the
    // underlying turn was in flight must prevent its result from being
    // accepted into the Mission journal.
    const after = await this.resolver.resolveExecutionInput(input);
    const afterFingerprint = after.specializedProfile
      ? specializedBindingFingerprint(after.specializedProfile)
      : undefined;
    if (!sameSpecializedBindingFingerprint(binding.specializedProfile, afterFingerprint)) {
      throw new SpecializedMissionProfileSelectionError(
        `Specialized Mission profile "${input.profile.id}" changed while execute was running`,
      );
    }
    return result;
  }
}

function specializedBindingFingerprint(
  binding: NonNullable<MissionExecutionInput['specializedProfile']>,
): NonNullable<Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile']> {
  return {
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    versionSha256: binding.versionSha256,
    capabilityEnvelopeSha256: binding.capabilityEnvelopeSha256,
    executionRouteSha256: binding.executionRouteSha256,
  };
}

function sameSpecializedBindingFingerprint(
  actual: Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile'],
  expected: Awaited<ReturnType<MissionWorkExecutor['prepare']>>['specializedProfile'],
): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.profileId === expected.profileId
    && actual.profileVersion === expected.profileVersion
    && actual.versionSha256 === expected.versionSha256
    && actual.capabilityEnvelopeSha256 === expected.capabilityEnvelopeSha256
    && actual.executionRouteSha256 === expected.executionRouteSha256;
}

function selectionFields(
  spec: MissionSpec,
  taskFamily: string | null,
  dispatchedItem?: MissionWorkItem,
): Readonly<Record<string, unknown>> {
  return {
    'task.family': taskFamily,
    'mission.id': spec.id,
    'mission.title': spec.title,
    'work-item.id': dispatchedItem?.id,
    'work-item.kind': dispatchedItem?.kind,
    'work-item.effect': dispatchedItem?.effect,
  };
}

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

function profileForItem(spec: MissionSpec, item: MissionWorkItem): string | undefined {
  if (item.agentProfileId) return item.agentProfileId;
  if (item.kind === 'objective-review') return spec.reviewerProfileId;
  if (item.kind === 'final-review') return spec.supervisorProfileId;
  if (['task', 'subtask', 'integration', 'correction'].includes(item.kind)) {
    return spec.defaultWorkerProfileId;
  }
  return undefined;
}

function deduplicateCapabilities(
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
