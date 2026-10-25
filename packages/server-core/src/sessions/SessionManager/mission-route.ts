import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createHash } from "node:crypto";
import { type PermissionMode } from "@craft-agent/shared/agent";
import { type BackendHostRuntimeContext } from "@craft-agent/shared/agent/backend";
import { type MissionOrdinaryRouteLock } from "@craft-agent/shared/sessions";
import { McpClientPool } from "@craft-agent/shared/mcp";
import { specializedCapabilityIdentity } from "../../specialized-profiles/capability-identity.ts";
import { ordinaryMissionSourceIdentityFromBindings } from "../../missions/mission-route-identity.ts";
import type { ManagedSession } from './managed-session.ts';
import { _platform } from './runtime-platform.ts';

export function buildBackendHostRuntimeContext(): BackendHostRuntimeContext {
  if (!_platform) throw new Error('setSessionPlatform() must be called before session creation')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}

export function specializedRuntimeIdentitySha256(): string | null {
  const buildCommit = _platform?.buildCommit?.trim()
  if (!_platform || !buildCommit || _platform.buildDirty === true) return null
  return createHash('sha256').update(JSON.stringify({
    appVersion: _platform.appVersion,
    buildCommit,
    buildChannel: _platform.buildChannel ?? null,
    isPackaged: _platform.isPackaged,
  })).digest('hex')
}

export function freezeRuntimeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freezeRuntimeSnapshot(nested)
    }
    Object.freeze(value)
  }
  return value
}

export function hasImmutableMissionRoute(
  session: Pick<ManagedSession, 'missionRouteLockSha256' | 'missionOrdinaryRouteLock'>,
): boolean {
  return Boolean(session.missionRouteLockSha256 || session.missionOrdinaryRouteLock)
}

export function hasMissionDispatchTriplet(
  session: Pick<ManagedSession, 'missionId' | 'missionWorkItemId' | 'missionDispatchId'>,
): boolean {
  return Boolean(session.missionId && session.missionWorkItemId && session.missionDispatchId)
}

export function canonicalMissionSourceSlugs(slugs: readonly string[] | undefined): string[] {
  return [...new Set(slugs ?? [])].sort((left, right) => left.localeCompare(right))
}

function expectedOrdinaryMissionRouteDecisionIdentity(lock: MissionOrdinaryRouteLock): string {
  return specializedCapabilityIdentity({
    schemaVersion: 1,
    connectionSlug: lock.connectionSlug,
    routingDecision: {
      version: lock.version,
      profile: lock.profile,
      origin: lock.origin,
      ...(lock.requestedModel ? { requestedModel: lock.requestedModel } : {}),
      model: lock.model,
      thinkingLevel: lock.thinkingLevel,
    },
    measuredMissionUsd: lock.measuredMissionUsd,
    projectedRemainingUsd: lock.projectedRemainingUsd ?? null,
  })
}

export function assertValidOrdinaryMissionRouteLock(lock: MissionOrdinaryRouteLock): void {
  const hashes = [
    lock.routeDecisionSha256,
    lock.routeConfigIdentitySha256,
    lock.connectionIdentitySha256,
    lock.sourceIdentitySha256,
  ]
  if (lock.schemaVersion !== 1
    || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))
    || (lock.runtimeIdentitySha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(lock.runtimeIdentitySha256))
    || !lock.agentProfileId
    || !lock.connectionSlug
    || !lock.model
    || !lock.cwd
    || canonicalMissionSourceSlugs(lock.effectiveSourceSlugs).some(
      (slug, index) => slug !== lock.effectiveSourceSlugs[index],
    )
    || canonicalMissionSourceSlugs(lock.effectiveSourceSlugs).length
      !== lock.effectiveSourceSlugs.length
    || !Array.isArray(lock.effectiveSourceBindings)
    || lock.effectiveSourceBindings.some((binding, index) =>
      binding.slug !== lock.effectiveSourceSlugs[index]
      || !/^[a-f0-9]{64}$/.test(binding.identitySha256)
      || (binding.authorityBindingId !== undefined && !binding.authorityBindingId))
    || lock.effectiveSourceBindings.length !== lock.effectiveSourceSlugs.length
    || ordinaryMissionSourceIdentityFromBindings(lock.effectiveSourceBindings)
      !== lock.sourceIdentitySha256
    || !Number.isFinite(lock.measuredMissionUsd)
    || lock.measuredMissionUsd < 0
    || (lock.projectedRemainingUsd !== undefined
      && (!Number.isFinite(lock.projectedRemainingUsd) || lock.projectedRemainingUsd < 0))
    || expectedOrdinaryMissionRouteDecisionIdentity(lock) !== lock.routeDecisionSha256) {
    throw new Error('Ordinary Mission route lock is malformed or internally inconsistent')
  }
}

export interface MissionToolPreflightInput {
  toolName: string
  toolInput: Record<string, unknown>
  permissionMode: PermissionMode
  enabledSourceSlugs?: string[]
}

export type MissionToolPreflightDecision = { allowed: true } | { allowed: false; reason: string }

type MissionDeclaredToolCapabilities = NonNullable<
  ReturnType<McpClientPool['getProxyToolCapabilities']>
>

export interface MissionLiveToolDefinition {
  capabilities: MissionDeclaredToolCapabilities
  /** Unmodified schema returned by the exact live MCP tools/list response. */
  inputSchema: Record<string, unknown>
}

export type MissionSourceToolCatalogDecision =
  | { allowed: true; tools: Map<string, MissionLiveToolDefinition> }
  | { allowed: false; reason: string }

export type MissionSourceToolCatalogCache = Map<string, Promise<MissionSourceToolCatalogDecision>>

export const missionMcpInputValidator = new AjvJsonSchemaValidator()
