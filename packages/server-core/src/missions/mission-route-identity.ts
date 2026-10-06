import type { ThinkingLevel } from '@craft-agent/shared/agent';
import type { LlmConnection } from '@craft-agent/shared/config';
import { getCredentialManager, type LlmCredentialBinding } from '@craft-agent/shared/credentials';
import type { AgentProfile } from '@craft-agent/shared/missions';
import type { Session } from '@craft-agent/shared/protocol';
import type { MissionOrdinarySourceBinding } from '@craft-agent/shared/sessions';
import {
  specializedProfileExecutionRouteIdentity,
} from '@craft-agent/shared/specialized-profiles';
import type { WorkspaceConfig } from '@craft-agent/shared/workspaces';
import {
  resolveSpecializedSourceCapabilityBinding,
  specializedCapabilityIdentity,
} from '../specialized-profiles/capability-identity.ts';

export type OrdinaryMissionRouteConnection = Pick<
  LlmConnection,
  'slug' | 'providerType'
> & Partial<LlmConnection>;

export interface OrdinaryMissionRouteDefaults {
  defaultLlmConnection?: string | null;
  defaultThinkingLevel: ThinkingLevel;
}

type OrdinaryMissionRouteOrigin = Pick<
  Session,
  | 'llmConnection'
  | 'connectionRoutePinned'
  | 'model'
  | 'modelRoutePinned'
  | 'thinkingLevel'
  | 'thinkingLevelPinned'
>;

/** Canonical effective source order used by both dispatch and provider fences. */
export function effectiveOrdinaryMissionSourceSlugs(
  profile: Pick<AgentProfile, 'sources'>,
  config: Pick<WorkspaceConfig, 'defaults'> | null | undefined,
): string[] {
  return [...new Set(profile.sources.length > 0
    ? profile.sources
    : config?.defaults?.enabledSourceSlugs ?? [])]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Privacy-safe identity of the exact enabled source snapshots and their
 * credential generations. No credential material is read into the digest.
 */
export async function ordinaryMissionSourceIdentity(
  workspaceRoot: string,
  slugs: readonly string[],
): Promise<string> {
  return ordinaryMissionSourceIdentityFromBindings(
    await ordinaryMissionSourceBindings(workspaceRoot, slugs),
  );
}

export async function ordinaryMissionSourceBindings(
  workspaceRoot: string,
  slugs: readonly string[],
): Promise<MissionOrdinarySourceBinding[]> {
  const bindings: MissionOrdinarySourceBinding[] = [];
  for (const slug of [...slugs].sort((left, right) => left.localeCompare(right))) {
    const binding = await resolveSpecializedSourceCapabilityBinding({ workspaceRoot, slug });
    if (!binding) throw new Error(`Mission source "${slug}" is unavailable or disabled`);
    bindings.push({ slug, ...binding });
  }
  return bindings;
}

export function ordinaryMissionSourceIdentityFromBindings(
  bindings: readonly MissionOrdinarySourceBinding[],
): string {
  return specializedCapabilityIdentity(bindings);
}

/** Canonical route policy identity, deliberately excluding live spend. */
export function ordinaryMissionRouteConfigIdentity(input: {
  profile: Pick<
    AgentProfile,
    'id' | 'llmConnection' | 'model' | 'thinkingLevel' | 'sources'
  >;
  config: Pick<
    WorkspaceConfig,
    'costControl' | 'defaults'
  > | null | undefined;
  origin?: OrdinaryMissionRouteOrigin;
  defaults: OrdinaryMissionRouteDefaults;
}): string {
  return specializedCapabilityIdentity({
    costControl: input.config?.costControl ?? null,
    defaults: {
      defaultLlmConnection: input.config?.defaults?.defaultLlmConnection
        ?? input.defaults.defaultLlmConnection ?? null,
      thinkingLevel: input.config?.defaults?.thinkingLevel
        ?? input.defaults.defaultThinkingLevel,
      enabledSourceSlugs: [...(input.config?.defaults?.enabledSourceSlugs ?? [])].sort(),
    },
    profile: {
      id: input.profile.id,
      llmConnection: input.profile.llmConnection ?? null,
      model: input.profile.model ?? null,
      thinkingLevel: input.profile.thinkingLevel ?? null,
      sources: [...input.profile.sources].sort(),
    },
    origin: input.origin ? {
      llmConnection: input.origin.llmConnection ?? null,
      connectionRoutePinned: input.origin.connectionRoutePinned ?? false,
      model: input.origin.model ?? null,
      modelRoutePinned: input.origin.modelRoutePinned ?? false,
      thinkingLevel: input.origin.thinkingLevel ?? null,
      thinkingLevelPinned: input.origin.thinkingLevelPinned ?? false,
    } : null,
  });
}

export type OrdinaryMissionCredentialBindingResolver = (
  connection: OrdinaryMissionRouteConnection,
) => Promise<LlmCredentialBinding | null> | LlmCredentialBinding | null;

/**
 * Canonical identity of the concrete endpoint/protocol/auth/credential route.
 * The default resolver returns only a vault slot and host-minted generation.
 */
export async function ordinaryMissionConnectionIdentity(input: {
  agentProfileId: string;
  connection: OrdinaryMissionRouteConnection;
  connectionSlug: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  runtimeIdentitySha256?: string;
  credentialBindingResolver?: OrdinaryMissionCredentialBindingResolver;
}): Promise<string> {
  const credentialBinding = input.credentialBindingResolver
    ? await input.credentialBindingResolver(input.connection)
    : input.connection.authType
      ? await getCredentialManager().getLlmCredentialBinding(
          input.connection.slug,
          input.connection.authType,
        )
      : null;
  if (input.connection.authType
    && input.connection.authType !== 'none'
    && !credentialBinding) {
    throw new Error(`Mission connection "${input.connection.slug}" has no host-attestable credential generation`);
  }
  return specializedProfileExecutionRouteIdentity({
    id: input.agentProfileId,
    llmConnection: input.connectionSlug,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
  }, {
    ...input.connection,
    credentialBinding,
    runtimeIdentitySha256: input.runtimeIdentitySha256 ?? null,
  });
}
