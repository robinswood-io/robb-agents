import { MissionSpecSchema, type AgentProfile, type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import { SPECIALIZED_MISSION_PROFILE_ID_PREFIX, SpecializedMissionProfileSelectionError, parseSpecializedMissionProfileReference, selectSpecializedMissionProfile, type SpecializedMissionCapability, type SpecializedProfileEvaluation } from "@craft-agent/shared/specialized-profiles";
import type { MissionExecutionInput } from "../../missions/MissionRuntime.ts";
import { loadSpecializedProfileRegistryForMission } from "../SpecializedProfileService.ts";
import { classifyMissionTaskFamily } from "../mission-observations.ts";
import type { MissionSpecializedProfileResolverOptions, SpecializedProfileCapabilityResolver, SpecializedProfileExecutionRouteIdentityResolver, SpecializedProfileRegistryLoader, SpecializedProfileTaskFamilyClassifier } from './contracts.ts';
import { deduplicateCapabilities, profileForItem, resolveConfiguredMissionCapabilities, specializedProfileExecutionRouteIdentity } from './mission-capabilities.ts';

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
