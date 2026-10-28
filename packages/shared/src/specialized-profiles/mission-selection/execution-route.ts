import { isUnknownArray } from '../../utils/json.ts';
import { createHash } from "node:crypto";
import type { AgentProfile } from "../../missions/index.ts";
import { SpecializedMissionProfileSelectionError } from './contracts.ts';

/** Canonical identity of the route that will actually execute a specialist. */
export function specializedProfileExecutionRouteIdentity(
  profile: Pick<AgentProfile, 'id' | 'llmConnection' | 'model' | 'thinkingLevel'>,
  effectiveConnection?: unknown,
): string {
  if (!profile.llmConnection || !profile.model || !profile.thinkingLevel) {
    throw new SpecializedMissionProfileSelectionError(
      `Specialized Mission profile "${profile.id}" has no fully pinned execution route`,
    );
  }
  return createHash('sha256').update(routeStableJson({
    llmConnection: profile.llmConnection,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    effectiveConnection: canonicalExecutionConnection(
      effectiveConnection ?? { slug: profile.llmConnection },
    ),
  })).digest('hex');
}

function canonicalExecutionConnection(value: unknown): unknown {
  if (!value || typeof value !== 'object' || isUnknownArray(value)) return value;
  const connection = value as Record<string, unknown>;
  const models = isUnknownArray(connection["models"])
    ? [...connection["models"]]
      .map((model: unknown) => canonicalRouteValue(model))
      .sort((left, right) => routeStableJson(left).localeCompare(routeStableJson(right)))
    : [];
  return canonicalRouteValue({
    slug: connection["slug"] ?? null,
    providerType: connection["providerType"] ?? null,
    type: connection["type"] ?? null,
    baseUrl: connection["baseUrl"] ?? null,
    authType: connection["authType"] ?? null,
    models,
    defaultModel: connection["defaultModel"] ?? null,
    modelSelectionMode: connection["modelSelectionMode"] ?? null,
    piAuthProvider: connection["piAuthProvider"] ?? null,
    googleCloudProject: connection["googleCloudProject"] ?? null,
    customEndpoint: connection["customEndpoint"] ?? null,
    oauthAccountUuid: connection["oauthAccountUuid"] ?? null,
    oauthAccountEmail: connection["oauthAccountEmail"] ?? null,
    oauthOrganizationUuid: connection["oauthOrganizationUuid"] ?? null,
    credentialBinding: connection["credentialBinding"] ?? null,
    runtimeIdentitySha256: connection["runtimeIdentitySha256"] ?? null,
  });
}

function canonicalRouteValue(value: unknown): unknown {
  if (isUnknownArray(value)) return value.map(canonicalRouteValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalRouteValue(entry)]));
}

function routeStableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (isUnknownArray(value)) return `[${value.map(routeStableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${routeStableJson(record[key])}`).join(',')}}`;
}
