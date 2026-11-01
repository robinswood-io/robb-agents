import { type MissionCapabilityLock, type MissionOrdinarySourceBinding } from "@craft-agent/shared/sessions";
import { loadWorkspaceSources, type LoadedSource, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, hasRenewEndpoint, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter } from "@craft-agent/shared/sources";
import { perf } from "@craft-agent/shared/utils";
import { specializedSourceCapabilityBindingFromSnapshot } from "../../specialized-profiles/capability-identity.ts";
import type { SummarizeCallback } from "@craft-agent/shared/sources";
import { sessionLog } from './runtime-platform.ts';

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
export interface BuildServersFromSourcesOptions {
  /** Discovery may inspect credentials and build transient clients, but it must
   * never refresh credentials or persist source/authentication state. */
  sourceStateMutation?: 'allow' | 'forbid'
  /** Exact source/config/credential generations sealed by an ordinary Mission
   * route. Presence (including an empty list) makes undeclared sources fail
   * closed and disables credential refresh for the sealed runtime. */
  ordinarySourceBindings?: readonly MissionOrdinarySourceBinding[]
}

export async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback,
  assertCapabilities?: () => Promise<void>,
  capabilityLock?: MissionCapabilityLock,
  options?: BuildServersFromSourcesOptions,
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()
  const ordinarySourceBindings = options?.ordinarySourceBindings
  const ordinarySourceBindingBySlug = ordinarySourceBindings === undefined
    ? undefined
    : new Map(ordinarySourceBindings.map(binding => [binding.slug, binding]))
  if (ordinarySourceBindings
    && ordinarySourceBindingBySlug!.size !== ordinarySourceBindings.length) {
    throw new Error('Ordinary Mission source binding set contains duplicate source slugs')
  }
  await assertCapabilities?.()
  const assertSourceBinding = async (
    source: LoadedSource,
    bound?: Awaited<ReturnType<typeof credManager.loadWithIdentity>>,
  ): Promise<void> => {
    const expected = capabilityLock?.capabilities.find(capability =>
      capability.kind === 'source' && capability.name === source.config.slug)
    if (capabilityLock && !expected) {
      throw new Error(`Specialized Mission source capability "${source.config.slug}" is not declared`)
    }
    await assertCapabilities?.()
    if (!expected) return
    const exactBound = bound === undefined ? await credManager.loadWithIdentity(source) : bound
    const actual = specializedSourceCapabilityBindingFromSnapshot(source, exactBound)
    if (actual.identitySha256 !== expected.identitySha256
      || actual.authorityBindingId !== expected.authorityBindingId) {
      throw new Error(`Specialized Mission source capability "${source.config.slug}" drifted`)
    }
  }
  const loadOrdinarySourceSnapshot = async (source: LoadedSource): Promise<{
    source: LoadedSource
    snapshot: Awaited<ReturnType<typeof credManager.loadRuntimeCredentialSnapshot>>
  } | undefined> => {
    if (!ordinarySourceBindingBySlug) return undefined
    const expected = ordinarySourceBindingBySlug.get(source.config.slug)
    if (!expected) {
      throw new Error(`Ordinary Mission source "${source.config.slug}" is not declared by its route lock`)
    }
    // Reload config + guide from disk and read the credential exactly once.
    // The same immutable snapshot is then both attested and injected into the
    // API call, so a rotated binding cannot be silently substituted.
    const liveSource = loadWorkspaceSources(source.workspaceRootPath)
      .find(candidate => candidate.config.enabled && candidate.config.slug === source.config.slug)
    if (!liveSource) {
      throw new Error(`Ordinary Mission source "${source.config.slug}" is unavailable or disabled`)
    }
    const snapshot = await credManager.loadRuntimeCredentialSnapshot(liveSource)
    const bound = snapshot.stored && snapshot.credentialId
      ? { credential: snapshot.stored, credentialId: snapshot.credentialId }
      : null
    const actual = specializedSourceCapabilityBindingFromSnapshot(liveSource, bound)
    if (actual.identitySha256 !== expected.identitySha256
      || actual.authorityBindingId !== expected.authorityBindingId) {
      throw new Error(`Ordinary Mission source "${source.config.slug}" credential binding drifted`)
    }
    return { source: liveSource, snapshot }
  }

  // Load identity + secret once per source. Under a capability lock the same
  // immutable value is used for validation and initial server construction.
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => {
      const ordinarySnapshot = await loadOrdinarySourceSnapshot(source)
      if (!capabilityLock && !ordinarySnapshot) return {
        source,
        token: await credManager.getToken(source),
        credential: await credManager.getApiCredential(source),
      }
      const exactSource = ordinarySnapshot?.source ?? source
      const snapshot = ordinarySnapshot?.snapshot
        ?? await credManager.loadRuntimeCredentialSnapshot(exactSource)
      const bound = snapshot.stored && snapshot.credentialId
        ? { credential: snapshot.stored, credentialId: snapshot.credentialId }
        : null
      if (capabilityLock) await assertSourceBinding(exactSource, bound)
      return { source: exactSource, token: snapshot.token, credential: snapshot.apiCredential }
    })
  )
  const initialCredentials = new Map(sourcesWithCreds.map(entry => [entry.source.config.slug, entry]))
  const sourceStateMutationForbidden = options?.sourceStateMutation === 'forbid'
  span.mark('credentials.loaded')

  // Build token getter for refreshable sources (OAuth + renew-endpoint)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // Provider-specific OAuth (Google, Slack, Microsoft) or generic OAuth (authType: 'oauth')
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      if (ordinarySourceBindingBySlug) return async () => {
        const exact = await loadOrdinarySourceSnapshot(source)
        if (!exact?.snapshot.token) {
          throw new Error(`Ordinary Mission source "${source.config.slug}" has no valid bound token`)
        }
        return exact.snapshot.token
      }
      if (sourceStateMutationForbidden) return async () => {
        await assertCapabilities?.()
        const token = initialCredentials.get(source.config.slug)?.token
        if (!token) throw new Error(`Source "${source.config.slug}" has no token for read-only discovery`)
        return token
      }
      if (capabilityLock) return async () => {
        const snapshot = await credManager.loadRuntimeCredentialSnapshot(source)
        const bound = snapshot.stored && snapshot.credentialId
          ? { credential: snapshot.stored, credentialId: snapshot.credentialId }
          : null
        await assertSourceBinding(source, bound)
        if (!snapshot.token) throw new Error(`Specialized Mission source "${source.config.slug}" has no valid bound token`)
        return snapshot.token
      }
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      const getToken = createTokenGetter(manager, source)
      return async () => {
        await assertSourceBinding(source)
        return getToken()
      }
    }
    // API renew endpoint — non-OAuth token refresh
    if (hasRenewEndpoint(source)) {
      if (ordinarySourceBindingBySlug) return async () => {
        const exact = await loadOrdinarySourceSnapshot(source)
        if (!exact?.snapshot.token) {
          throw new Error(`Ordinary Mission source "${source.config.slug}" has no valid bound token`)
        }
        return exact.snapshot.token
      }
      if (sourceStateMutationForbidden) return async () => {
        await assertCapabilities?.()
        const token = initialCredentials.get(source.config.slug)?.token
        if (!token) throw new Error(`Source "${source.config.slug}" has no token for read-only discovery`)
        return token
      }
      if (capabilityLock) return async () => {
        const snapshot = await credManager.loadRuntimeCredentialSnapshot(source)
        const bound = snapshot.stored && snapshot.credentialId
          ? { credential: snapshot.stored, credentialId: snapshot.credentialId }
          : null
        await assertSourceBinding(source, bound)
        if (!snapshot.token) throw new Error(`Specialized Mission source "${source.config.slug}" has no valid bound token`)
        return snapshot.token
      }
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      const getToken = createTokenGetter(manager, source)
      return async () => {
        await assertSourceBinding(source)
        return getToken()
      }
    }
    return undefined
  }

  // Per-request credential getter for non-OAuth / non-renew API sources
  // (bearer / header / query / basic auth).
  //
  // Without this, the in-process API tool captures the credential as a static
  // string at build time and keeps using it forever — meaning a fresh JWT
  // entered via source_credential_prompt is ignored until session restart.
  //
  // With this getter, every API call reads the latest credential from the
  // vault, so credential updates take effect on the next call. OAuth and
  // renew-endpoint sources have their own refresh logic via TokenRefreshManager
  // and are skipped here.
  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    if (ordinarySourceBindingBySlug) return async () => {
      const exact = await loadOrdinarySourceSnapshot(source)
      if (!exact) throw new Error(`Ordinary Mission source "${source.config.slug}" is not sealed`)
      if (exact.snapshot.apiCredential === null) {
        throw new Error(`Ordinary Mission source "${source.config.slug}" has no valid bound credential`)
      }
      return exact.snapshot.apiCredential
    }
    if (sourceStateMutationForbidden) return async () => {
      await assertCapabilities?.()
      return initialCredentials.get(source.config.slug)?.credential ?? null
    }
    return async () => {
      if (capabilityLock) {
        const snapshot = await credManager.loadRuntimeCredentialSnapshot(source)
        const bound = snapshot.stored && snapshot.credentialId
          ? { credential: snapshot.stored, credentialId: snapshot.credentialId }
          : null
        await assertSourceBinding(source, bound)
        return snapshot.apiCredential
      }
      await assertCapabilities?.()
      const bound = await credManager.getApiCredentialWithIdentity(source)
      return bound?.credential ?? null
    }
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
    getCredentialForSource,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state.
  // Re-classify AUTH_REQUIRED → TOKEN_EXPIRED when the credential is merely
  // expired-but-refreshable; in that case the refresh cycle handles recovery
  // and we must NOT prematurely mark the source as needing re-auth (#710).
  if (!sourceStateMutationForbidden) {
    for (const error of result.errors) {
      if (error.error !== SERVER_BUILD_ERRORS.AUTH_REQUIRED) continue
      const source = sources.find(s => s.config.slug === error.sourceSlug)
      if (!source) continue

      if (capabilityLock) continue
      const cred = await credManager.load(source)
      const isExpiredRefreshable =
        cred &&
        (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
        (cred.refreshToken || hasRenewEndpoint(source))

      if (isExpiredRefreshable) {
        error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
        sessionLog.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
        continue
      }

      credManager.markSourceNeedsReauth(source, 'Token missing or expired')
      sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
    }
  }

  span.end()
  return result
}

/**
 * Result of expired-credential refresh.
 */
interface RefreshExpiredCredentialsResult {
  /** Number of sources whose tokens were successfully refreshed */
  refreshedCount: number
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth / renew-endpoint tokens for the given sources.
 *
 * Side effects (carried by `TokenRefreshManager.ensureFreshToken`):
 * - Success: source.config.isAuthenticated = true (in-memory + on disk).
 * - Failure: source.config.isAuthenticated = false + connectionStatus = 'needs_auth'
 *   (in-memory + on disk), so isSourceUsable() returns false and the source is
 *   excluded from intendedSlugs by callers.
 *
 * The caller is responsible for building servers AFTER this returns — that way
 * a single fresh build sees the correct credentials and the correct usable set.
 * Issue #710.
 */
export async function refreshExpiredCredentials(
  sources: LoadedSource[],
  tokenRefreshManager: TokenRefreshManager
): Promise<RefreshExpiredCredentialsResult> {
  sessionLog.debug('[OAuth] Checking if any tokens need refresh')

  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)
  if (needRefresh.length === 0) {
    return { refreshedCount: 0, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Refreshing ${needRefresh.length} source(s): ${needRefresh.map(s => s.config.slug).join(', ')}`)

  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  return { refreshedCount: refreshed.length, failedSources }
}
