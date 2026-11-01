import { type AgentProfile, type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import { type SpecializedMissionCapability, type SpecializedProfileRegistryDocument } from "@craft-agent/shared/specialized-profiles";
import { type SpecializedProfileWorkspace } from "../SpecializedProfileService.ts";

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
