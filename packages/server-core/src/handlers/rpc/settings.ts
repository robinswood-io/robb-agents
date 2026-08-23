import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getPreferencesPath, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts, getWorkspaceByNameOrId, getDefaultThinkingLevel, setDefaultThinkingLevel } from '@craft-agent/shared/config'
import { isValidThinkingLevel, normalizeThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { getWorkspaceOrThrow } from '@craft-agent/server-core/handlers'
import {
  assertRequestWorkspace,
  assertRequestWorkspaceAccess,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport'
import { filterDraftsForWorkspace } from './draft-workspace-filter'
import type { HandlerDeps } from '../handler-deps'
import { requestClientOpenFileDialog } from '@craft-agent/server-core/transport'
import { isValidWorkingDirectory } from '../../utils/path-validation'
import { getLlmConnections } from '@craft-agent/shared/config/storage'
import {
  ALL_ROUTING_SENSITIVITIES,
  simulateRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicy,
  type RoutingPolicyContext,
} from '@craft-agent/shared/config/routing-policy'
import {
  createDefaultWorkspaceGovernance,
  parseWorkspaceGovernanceProfile,
  WorkspaceGovernanceStore,
  WorkspaceGovernanceProfileSchema,
  assertSpaceAction,
  type SpaceAction,
  type WorkspaceGovernanceMutable,
  type WorkspaceGovernanceProfile,
} from '@craft-agent/shared/governance'
import {
  createDefaultRemoteSupervisionProfile,
  type RemoteAction,
  type RemoteSupervisorIdentity,
  type RemoteSyncField,
} from '@craft-agent/shared/remote-supervision'
import type {
  RemoteSupervisionGrantRequest,
  RemoteSupervisionRevokeRequest,
  WorkspaceGovernanceUpdateRequest,
} from '@craft-agent/shared/protocol'
import { RemoteSupervisionService } from '../../services/remote-supervision-service'

const REMOTE_SYNC_FIELDS = [
  'task.status',
  'task.progress',
  'task.blockers',
  'task.approvals',
  'task.cost',
  'task.timestamps',
] as const satisfies readonly RemoteSyncField[]

const REMOTE_ACTIONS = [
  'task.pause',
  'task.cancel',
  'approval.resolve',
] as const satisfies readonly RemoteAction[]

function governanceMutableFromProfile(profile: WorkspaceGovernanceProfile): WorkspaceGovernanceMutable {
  return {
    members: profile.space.members,
    memory: profile.space.memory,
    budgets: profile.budgets,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.workspace.GOVERNANCE_UPDATE,
  RPC_CHANNELS.workspace.ROUTING_SIMULATE,
  RPC_CHANNELS.workspace.REMOTE_SUPERVISION_GRANT,
  RPC_CHANNELS.workspace.REMOTE_SUPERVISION_REVOKE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  RPC_CHANNELS.rtk.GET_ENABLED,
  RPC_CHANNELS.rtk.SET_ENABLED,
  RPC_CHANNELS.rtk.GET_STATUS,
  RPC_CHANNELS.rtk.GET_GAIN,
] as const

export function registerSettingsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const assertSessionAccess = async (context: RequestContext, sessionId: string): Promise<void> => {
    const session = await deps.sessionManager.getSession(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)
    assertRequestWorkspace(context, session.workspaceId)
  }

  const authorizeWorkspaceAction = async (
    context: RequestContext,
    workspaceId: string,
    action: SpaceAction,
  ) => {
    assertRequestWorkspace(context, workspaceId)
    const workspace = getWorkspaceOrThrow(workspaceId)
    // A paired Remote device is a server-issued, workspace-scoped reader. It is
    // intentionally not persisted as a governance member, so allow only the
    // read action needed to hydrate the mobile workspace UI. Mutations still
    // pass through the durable governance membership checks below.
    if (context.roles.includes('remote-device') && action === 'policy.read') {
      return workspace
    }
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) throw new Error(`Failed to load workspace config: ${workspaceId}`)
    const initialGovernance = config.governance
      ? parseWorkspaceGovernanceProfile(config.governance)
      : createDefaultWorkspaceGovernance({
          workspaceId: config.id,
          workspaceName: config.name,
          createdAt: new Date(config.createdAt).toISOString(),
        })
    const governance = (await new WorkspaceGovernanceStore(workspace.rootPath)
      .loadOrCreate(initialGovernance)).profile
    assertSpaceAction(governance.space, context.actorId, action)
    return workspace
  }

  const remoteSupervisionContext = async (workspaceId: string) => {
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const loadConfig = () => {
      const config = loadWorkspaceConfig(workspace.rootPath)
      if (!config) throw new Error(`Failed to load workspace config: ${workspaceId}`)
      return config
    }
    const service = new RemoteSupervisionService({
      load: () => loadConfig().remoteSupervision,
      save: (profile) => {
        const config = loadConfig()
        config.remoteSupervision = profile
        saveWorkspaceConfig(workspace.rootPath, config)
      },
    })
    const config = loadConfig()
    const initialGovernance = config.governance
      ? parseWorkspaceGovernanceProfile(config.governance)
      : createDefaultWorkspaceGovernance({
          workspaceId: config.id,
          workspaceName: config.name,
          createdAt: new Date(config.createdAt).toISOString(),
        })
    const governance = (await new WorkspaceGovernanceStore(workspace.rootPath)
      .loadOrCreate(initialGovernance)).profile
    const identity: RemoteSupervisorIdentity = {
      subjectId: governance.space.createdBy,
      role: 'owner',
      allowedActions: [...REMOTE_ACTIONS],
    }
    return { service, identity }
  }

  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () => {
    return getDefaultThinkingLevel()
  })

  server.handle(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, async (_ctx, level: string) => {
    if (!isValidThinkingLevel(level)) {
      throw new Error(`Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
    }
    const success = setDefaultThinkingLevel(level)
    if (!success) {
      throw new Error('Failed to persist default thinking level')
    }
    return { success: true }
  })

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(RPC_CHANNELS.sessions.GET_MODEL, async (ctx, sessionId: string, _workspaceId: string): Promise<string | null> => {
    await assertSessionAccess(ctx, sessionId)
    const session = await deps.sessionManager.getSession(sessionId)
    return session?.model ?? null
  })

  // Set session-specific model (and optionally connection)
  server.handle(RPC_CHANNELS.sessions.SET_MODEL, async (_ctx, sessionId: string, workspaceId: string, model: string | null, connection?: string) => {
    await deps.sessionManager.updateSessionModel(sessionId, workspaceId, model, connection)
    deps.platform.logger.info(`Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`)
  })

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get workspace settings (model, permission mode, working directory, credential strategy)
  server.handle(RPC_CHANNELS.workspace.SETTINGS_GET, async (ctx, workspaceId: string) => {
    await authorizeWorkspaceAction(ctx, workspaceId, 'policy.read')
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger.error(`Workspace not found: ${workspaceId}`)
      return null
    }

    // Load workspace config
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      deps.platform.logger.error(`Workspace config not found: ${workspace.rootPath}`)
      return null
    }

    const initialGovernance = config.governance
      ? parseWorkspaceGovernanceProfile(config.governance)
      : createDefaultWorkspaceGovernance({
          workspaceId: config.id,
          workspaceName: config.name,
          createdAt: new Date(config.createdAt).toISOString(),
        })
    const governanceDocument = await new WorkspaceGovernanceStore(workspace.rootPath)
      .loadOrCreate(initialGovernance)

    return {
      name: config.name,
      model: config.defaults?.model,
      permissionMode: config.defaults?.permissionMode,
      externalActionPolicy: config.defaults?.externalActionPolicy ?? 'confirm',
      cyclablePermissionModes: config.defaults?.cyclablePermissionModes,
      thinkingLevel: normalizeThinkingLevel(config.defaults?.thinkingLevel),
      workingDirectory: config.defaults?.workingDirectory,
      localMcpEnabled: config.localMcpServers?.enabled ?? true,
      defaultLlmConnection: config.defaults?.defaultLlmConnection,
      enabledSourceSlugs: config.defaults?.enabledSourceSlugs ?? [],
      routingPolicy: config.routingPolicy,
      governance: governanceDocument.profile,
      governanceRevision: governanceDocument.revision,
      governanceUpdatedAt: governanceDocument.updatedAt,
      governanceUpdatedBy: governanceDocument.updatedBy,
      remoteSupervision: config.remoteSupervision ?? createDefaultRemoteSupervisionProfile(),
    }
  })

  server.handle(
    RPC_CHANNELS.workspace.GOVERNANCE_UPDATE,
    async (ctx, workspaceId: string, request: WorkspaceGovernanceUpdateRequest) => {
      await authorizeWorkspaceAction(ctx, workspaceId, 'policy.update')
      if (!Number.isInteger(request?.expectedRevision) || request.expectedRevision < 0) {
        throw new Error('Governance update requires a non-negative expected revision')
      }
      const submittedProfile = WorkspaceGovernanceProfileSchema.parse(request.profile)
      const workspace = getWorkspaceOrThrow(workspaceId)
      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
      const config = loadWorkspaceConfig(workspace.rootPath)
      if (!config) throw new Error(`Failed to load workspace config: ${workspaceId}`)
      const initialGovernance = config.governance
        ? parseWorkspaceGovernanceProfile(config.governance)
        : createDefaultWorkspaceGovernance({
            workspaceId: config.id,
            workspaceName: config.name,
            createdAt: new Date(config.createdAt).toISOString(),
          })
      const store = new WorkspaceGovernanceStore(workspace.rootPath)
      await store.loadOrCreate(initialGovernance)
      const updated = await store.update(
        request.expectedRevision,
        ctx.actorId,
        governanceMutableFromProfile(submittedProfile),
      )
      config.governance = updated.profile
      saveWorkspaceConfig(workspace.rootPath, config)
      return {
        governance: updated.profile,
        governanceRevision: updated.revision,
        governanceUpdatedAt: updated.updatedAt,
        governanceUpdatedBy: updated.updatedBy,
      }
    },
  )

  server.handle(
    RPC_CHANNELS.workspace.REMOTE_SUPERVISION_GRANT,
    async (ctx, workspaceId: string, request: RemoteSupervisionGrantRequest) => {
      await authorizeWorkspaceAction(ctx, workspaceId, 'policy.update')
      if (!request || !Array.isArray(request.fields) || !Array.isArray(request.actions)) {
        throw new Error('Remote supervision consent requires fields and actions')
      }
      const invalidFields = request.fields.filter((field) => !REMOTE_SYNC_FIELDS.includes(field))
      const invalidActions = request.actions.filter((action) => !REMOTE_ACTIONS.includes(action))
      if (invalidFields.length > 0 || invalidActions.length > 0) {
        throw new Error(`Invalid remote supervision consent: ${[...invalidFields, ...invalidActions].join(', ')}`)
      }
      if (!request.purpose?.trim()) throw new Error('Remote supervision purpose is required')
      const { service, identity } = await remoteSupervisionContext(workspaceId)
      return service.grant(identity, {
        consentId: randomUUID(),
        fields: request.fields,
        actions: request.actions,
        purpose: request.purpose.trim(),
        expiresAt: request.expiresAt,
      })
    },
  )

  server.handle(
    RPC_CHANNELS.workspace.REMOTE_SUPERVISION_REVOKE,
    async (ctx, workspaceId: string, request: RemoteSupervisionRevokeRequest) => {
      await authorizeWorkspaceAction(ctx, workspaceId, 'policy.update')
      if (!request?.reason?.trim()) throw new Error('Remote supervision revocation reason is required')
      const { service, identity } = await remoteSupervisionContext(workspaceId)
      return service.revoke(identity, request.reason.trim())
    },
  )

  // Explain the current persisted policy without starting a provider, checking a
  // credential, or writing any workspace/session state.
  server.handle(RPC_CHANNELS.workspace.ROUTING_SIMULATE, async (ctx, workspaceId: string, context: RoutingPolicyContext = {}) => {
    await authorizeWorkspaceAction(ctx, workspaceId, 'policy.read')
    const workspace = getWorkspaceOrThrow(workspaceId)
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) throw new Error(`Failed to load workspace config: ${workspaceId}`)

    if (context.sensitivity && !ALL_ROUTING_SENSITIVITIES.includes(context.sensitivity)) {
      throw new Error(`Invalid routing sensitivity: ${context.sensitivity}`)
    }
    const sanitizeStrings = (value: unknown): string[] | undefined => Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : undefined
    const safeContext: RoutingPolicyContext = {
      sensitivity: context.sensitivity,
      requestedConnectionSlug: typeof context.requestedConnectionSlug === 'string' ? context.requestedConnectionSlug : undefined,
      tags: sanitizeStrings(context.tags),
      sourceSlugs: sanitizeStrings(context.sourceSlugs),
    }
    const connections = getLlmConnections().map(({ slug, providerType }) => ({ slug, providerType }))
    return simulateRoutingPolicy(config.routingPolicy, connections, safeContext)
  })

  // Update a workspace setting
  server.handle(RPC_CHANNELS.workspace.SETTINGS_UPDATE, async (ctx, workspaceId: string, key: string, value: unknown) => {
    await authorizeWorkspaceAction(ctx, workspaceId, 'policy.update')
    const workspace = getWorkspaceOrThrow(workspaceId)
    const normalizedValue = key === 'workingDirectory' && typeof value === 'string'
      ? value.trim()
      : value

    // Validate key is a known workspace setting
    const validKeys = ['name', 'model', 'enabledSourceSlugs', 'permissionMode', 'externalActionPolicy', 'cyclablePermissionModes', 'thinkingLevel', 'workingDirectory', 'localMcpEnabled', 'defaultLlmConnection', 'routingPolicy']
    if (!validKeys.includes(key)) {
      throw new Error(`Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`)
    }

    // Validate defaultLlmConnection exists before saving
    if (key === 'defaultLlmConnection' && normalizedValue !== undefined && normalizedValue !== null) {
      const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
      if (!getLlmConnection(normalizedValue as string)) {
        throw new Error(`LLM connection "${normalizedValue}" not found`)
      }
    }

    if (key === 'routingPolicy' && normalizedValue !== undefined && normalizedValue !== null) {
      const knownSlugs = getLlmConnections().map(connection => connection.slug)
      const validation = validateRoutingPolicy(normalizedValue as RoutingPolicy, knownSlugs)
      if (!validation.valid) {
        throw new Error(validation.errors.join('; '))
      }
    }

    if (key === 'externalActionPolicy' && !['confirm', 'allow-in-execute'].includes(String(normalizedValue))) {
      throw new Error('externalActionPolicy must be "confirm" or "allow-in-execute"')
    }

    if (key === 'workingDirectory' && normalizedValue !== undefined && normalizedValue !== null) {
      const validation = isValidWorkingDirectory(String(normalizedValue))
      if (!validation.valid) {
        throw new Error(validation.reason!)
      }
    }

    const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const config = loadWorkspaceConfig(workspace.rootPath)
    if (!config) {
      throw new Error(`Failed to load workspace config: ${workspaceId}`)
    }

    // Handle 'name' specially - it's a top-level config property, not in defaults
    if (key === 'name') {
      config.name = String(normalizedValue).trim()
    } else if (key === 'routingPolicy') {
      config.routingPolicy = normalizedValue === undefined || normalizedValue === null
        ? undefined
        : normalizedValue as RoutingPolicy
    } else if (key === 'localMcpEnabled') {
      // Store in localMcpServers.enabled (top-level, not in defaults)
      config.localMcpServers = config.localMcpServers || { enabled: true }
      config.localMcpServers.enabled = Boolean(normalizedValue)
    } else {
      // Update the setting in defaults
      config.defaults = config.defaults || {}
      ;(config.defaults as Record<string, unknown>)[key] = normalizedValue
    }

    // Save the config
    saveWorkspaceConfig(workspace.rootPath, config)
    if (key === 'externalActionPolicy') {
      await deps.sessionManager.refreshWorkspaceExternalActionPolicy(
        workspaceId,
        normalizedValue as 'confirm' | 'allow-in-execute',
      )
    }
    deps.platform.logger.info(`Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`)
  })

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath()
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path }
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path }
  })

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content) // Validate JSON
      const path = getPreferencesPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    return getSessionDraft(sessionId)
  })

  // Set draft for a session (empty drafts are cleared)
  server.handle(RPC_CHANNELS.drafts.SET, async (ctx, sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft) => {
    await assertSessionAccess(ctx, sessionId)
    setSessionDraft(sessionId, draft)
  })

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (ctx, sessionId: string) => {
    await assertSessionAccess(ctx, sessionId)
    deleteSessionDraft(sessionId)
  })

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async (ctx) => {
    const workspaceId = ctx.workspaceId
    if (!workspaceId) return {}
    assertRequestWorkspaceAccess(ctx, workspaceId)
    const drafts = getAllSessionDrafts()
    return filterDraftsForWorkspace(
      drafts,
      workspaceId,
      async (sessionId) => (await deps.sessionManager.getSession(sessionId))?.workspaceId ?? null,
    )
  })

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    const { getAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    return getAutoCapitalisation()
  })

  // Set auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.SET_AUTO_CAPITALISATION, async (_ctx, enabled: boolean) => {
    const { setAutoCapitalisation } = await import('@craft-agent/shared/config/storage')
    setAutoCapitalisation(enabled)
  })

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import('@craft-agent/shared/config/storage')
    return getSendMessageKey()
  })

  // Set send message key setting
  server.handle(RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY, async (_ctx, key: 'enter' | 'cmd-enter') => {
    const { setSendMessageKey } = await import('@craft-agent/shared/config/storage')
    setSendMessageKey(key)
  })

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import('@craft-agent/shared/config/storage')
    return getSpellCheck()
  })

  // Set spell check setting
  server.handle(RPC_CHANNELS.input.SET_SPELL_CHECK, async (_ctx, enabled: boolean) => {
    const { setSpellCheck } = await import('@craft-agent/shared/config/storage')
    setSpellCheck(enabled)
  })

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    return getKeepAwakeWhileRunning()
  })

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS, async () => {
    const { getRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    return getRichToolDescriptions()
  })

  // Set rich tool descriptions setting
  server.handle(RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS, async (_ctx, enabled: boolean) => {
    const { setRichToolDescriptions } = await import('@craft-agent/shared/config/storage')
    setRichToolDescriptions(enabled)
  })

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    return getExtendedPromptCache()
  })

  // Set extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE, async (_ctx, enabled: boolean) => {
    const { setExtendedPromptCache } = await import('@craft-agent/shared/config/storage')
    setExtendedPromptCache(enabled)
  })

  // Get 1M context window setting
  server.handle(RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT, async () => {
    const { getEnable1MContext } = await import('@craft-agent/shared/config/storage')
    return getEnable1MContext()
  })

  // Set 1M context window setting
  server.handle(RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT, async (_ctx, enabled: boolean) => {
    const { setEnable1MContext } = await import('@craft-agent/shared/config/storage')
    setEnable1MContext(enabled)
  })

  // ============================================================
  // RTK Token-Optimization Settings
  // ============================================================

  // Get rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.GET_ENABLED, async () => {
    const { getRtkEnabled } = await import('@craft-agent/shared/config/storage')
    return getRtkEnabled()
  })

  // Set rtk Bash-output compression setting
  server.handle(RPC_CHANNELS.rtk.SET_ENABLED, async (_ctx, enabled: boolean) => {
    const { setRtkEnabled } = await import('@craft-agent/shared/config/storage')
    setRtkEnabled(enabled)
  })

  // Detect rtk installation (used by Settings UI to swap install prompt ↔ toggle)
  server.handle(RPC_CHANNELS.rtk.GET_STATUS, async (_ctx, opts?: { forceRecheck?: boolean }) => {
    const { getRtkStatus } = await import('@craft-agent/shared/agent')
    return getRtkStatus(opts)
  })

  // Token-savings summary from `rtk gain --format json` (efficiency meter)
  server.handle(RPC_CHANNELS.rtk.GET_GAIN, async () => {
    const { getRtkGain } = await import('@craft-agent/shared/agent')
    return getRtkGain()
  })

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    return getBrowserToolEnabled()
  })

  server.handle(RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED, async (_ctx, enabled: boolean) => {
    const { setBrowserToolEnabled } = await import('@craft-agent/shared/config/storage')
    setBrowserToolEnabled(enabled)
  })

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import('@craft-agent/shared/config/storage')
    return getNetworkProxySettings()
  })
}
