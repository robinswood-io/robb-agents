import { setOptional } from '@craft-agent/shared/utils/json';
import { RPC_CHANNELS, type LlmConnectionSetup } from '@craft-agent/shared/protocol';
import { getLlmConnection, addLlmConnection, updateLlmConnection, getDefaultLlmConnection, setDefaultLlmConnection, isCompatProvider, isAnthropicProvider, getDefaultModelsForConnection, getDefaultModelForConnection, type LlmConnection, toBedrockNativeId, deriveBedrockRegionPrefix } from '@craft-agent/shared/config';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { setSetupDeferred } from '@craft-agent/shared/config/storage';
import { ROBINSWOOD_BACKEND_NAME } from '@craft-agent/shared/robinswood-branding';
import { resolveSetupTestConnectionHint, testBackendConnection } from '@craft-agent/shared/agent/backend';
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers';
import { parseTestConnectionError, createBuiltInConnection, validateModelList, piAuthProviderDisplayName, validateSetupTestInput, setupTestRequiresApiKey, resolveCustomEndpointSetup } from '@craft-agent/server-core/domain';
import { buildBackendHostRuntimeContext } from '@craft-agent/server-core/handlers';
import { type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from "../../handler-deps";



export function registerLlmSetupHandlers(server: RpcServer, deps: HandlerDeps, sessionManager: HandlerDeps['sessionManager']): void {

  // Unified handler for LLM connection setup
  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }> => {
    try {
      const manager = getCredentialManager()

      // Ensure connection exists in config
      let connection = getLlmConnection(setup.slug)
      let isNewConnection = false
      if (!connection) {
        // Reauth guard: if updateOnly is set, the connection must already exist.
        // Clean up any orphaned credentials from a preceding OAuth flow.
        if (setup.updateOnly) {
          await manager.deleteLlmCredentials(setup.slug).catch(() => {})
          deps.platform.logger?.warn(`[SETUP_LLM_CONNECTION] updateOnly rejected for missing slug: ${setup.slug}`)
          return { success: false, error: 'Connection not found. Cannot re-authenticate a non-existent connection.' }
        }
        // Create connection with appropriate defaults based on slug
        connection = createBuiltInConnection(setup.slug, setup.baseUrl)
        isNewConnection = true
      }

      const updates: Partial<LlmConnection> = {}
      const hasConfiguredBaseUrl = !!setup.baseUrl?.trim()
      if (setup.baseUrl !== undefined) {
        setOptional(updates, "baseUrl", setup.baseUrl?.trim() || undefined)

        // Only mutate providerType for API key connections (not OAuth connections)
        if (isAnthropicProvider(connection.providerType) && connection.authType !== 'oauth') {
          if (hasConfiguredBaseUrl) {
            updates.providerType = 'pi_compat'
            updates.authType = 'api_key_with_endpoint'
            updates.customEndpoint = { api: 'anthropic-messages' }
          } else {
            updates.providerType = 'anthropic'
            updates.authType = 'api_key'
            updates.models = getDefaultModelsForConnection('anthropic')
            updates.defaultModel = getDefaultModelForConnection('anthropic')
          }
        }

        // Pi API key flow: store baseUrl on the connection (Pi SDK doesn't use it yet,
        // but it's persisted for future backend support)

      }

      if (setup.defaultModel !== undefined) {
        setOptional(updates, "defaultModel", setup.defaultModel ?? undefined)
      }
      if (setup.models !== undefined) {
        setOptional(updates, "models", setup.models ?? undefined)
      }
      if (setup.modelSelectionMode !== undefined) {
        updates.modelSelectionMode = setup.modelSelectionMode
      }
      if (setup.googleCloudProject !== undefined) {
        const projectId = setup.googleCloudProject.trim()
        if (projectId && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
          return { success: false, error: 'Google Cloud project ID must be 6-30 lowercase letters, digits, or hyphens, starting with a letter.' }
        }
        setOptional(updates, "googleCloudProject", projectId || undefined)
      }

      const customEndpoint = hasConfiguredBaseUrl ? setup.customEndpoint : undefined
      const isCustomEndpointCompat = !!customEndpoint
      if (customEndpoint) {
        updates.customEndpoint = customEndpoint
        updates.providerType = 'pi_compat'
        const branch = resolveCustomEndpointSetup({
          baseUrl: setup.baseUrl ?? undefined,
          credential: setup.credential ?? undefined,
          customEndpointApi: customEndpoint.api,
        })
        updates.authType = branch.authType
        if (branch.name !== undefined) updates.name = branch.name
        if (branch.piAuthProvider !== undefined) updates.piAuthProvider = branch.piAuthProvider

        // Brand-name override on first setup only (user-renamed connections aren't clobbered on re-save).
        if (isNewConnection && !updates.name && setup.baseUrl?.toLowerCase().includes('manifest.build')) {
          updates.name = 'Manifest'
        }
      } else if (setup.baseUrl !== undefined) {
        // Base URL was explicitly updated without custom protocol config.
        // Treat this as non-custom mode and clear stale custom endpoint metadata.
        // Only downgrade existing connections — new ones already have the correct
        // providerType from createBuiltInConnection().
        delete updates.customEndpoint;
        if (connection.providerType === 'pi_compat' && connection.authType !== 'oauth' && !isNewConnection) {
          updates.providerType = 'pi'
          updates.authType = 'api_key'
        }
      }

      // Pi API key flow: set piAuthProvider from setup data (e.g. 'anthropic', 'google', 'openai').
      // Skip when custom endpoint protocol is driving routing.
      if (setup.piAuthProvider && !isCustomEndpointCompat) {
        updates.piAuthProvider = setup.piAuthProvider
        // Update connection name to show the actual provider (e.g. "Robb Agents Backend (Google AI Studio)")
        const providerName = piAuthProviderDisplayName(setup.piAuthProvider)
        if (providerName) {
          updates.name = `${ROBINSWOOD_BACKEND_NAME} (${providerName})`
        }
        // Only set default models when using standard Pi provider AND user didn't pick explicit models
        if (!hasConfiguredBaseUrl && !setup.models?.length) {
          updates.models = getDefaultModelsForConnection('pi', setup.piAuthProvider)
          updates.defaultModel = getDefaultModelForConnection('pi', setup.piAuthProvider)
          updates.modelSelectionMode ??= 'automaticallySyncedFromProvider'
        }
      }

      // Pi+Bedrock auth method override — set authType for IAM or environment auth.
      // providerType stays 'pi' (Bedrock routes through Pi SDK).
      if (setup.bedrockAuthMethod) {
        updates.authType = setup.bedrockAuthMethod
      }

      // Resolved Anthropic OAuth identity (issue #838). Threaded through SETUP so
      // it persists on both the new-connection path (addLlmConnection) and the
      // re-auth path (updateLlmConnection) via the shared pendingConnection/updates
      // flow below. Fail-soft: only stamp when at least one identity block arrived.
      const oauthIdentity = setup.oauthIdentity
      if (oauthIdentity?.account || oauthIdentity?.organization) {
        // Set only fields that are actually present, so `updates` never carries an
        // explicit `undefined` (matches the guarded-assignment style used above and
        // keeps the update intent clean). Missing sub-fields are simply not touched;
        // on re-auth the storage allowlist then preserves any prior value.
        if (oauthIdentity.account?.uuid) updates.oauthAccountUuid = oauthIdentity.account.uuid
        if (oauthIdentity.account?.emailAddress) updates.oauthAccountEmail = oauthIdentity.account.emailAddress
        if (oauthIdentity.organization?.uuid) updates.oauthOrganizationUuid = oauthIdentity.organization.uuid
        if (oauthIdentity.organization?.name) updates.oauthOrganizationName = oauthIdentity.organization.name
        updates.oauthProfileVerifiedAt = Date.now()
      }

      const effectiveProviderType = updates.providerType ?? connection.providerType
      if (effectiveProviderType === 'pi') {
        const isBedrockPi = (updates.piAuthProvider ?? connection.piAuthProvider) === 'amazon-bedrock'
        // For Pi+Bedrock, normalize bare Anthropic IDs to Bedrock-native before adding pi/ prefix
        // so that resolvePiModel() can find them in the amazon-bedrock registry.
        // Use the configured AWS region to select the correct inference profile prefix (us/eu).
        const regionPrefix = isBedrockPi ? deriveBedrockRegionPrefix(setup.awsRegion) : undefined
        const toPiModelId = (id: string) => {
          const bare = id.startsWith('pi/') ? id.slice(3) : id
          const normalized = isBedrockPi ? toBedrockNativeId(bare, regionPrefix) : bare
          return `pi/${normalized}`
        }
        if (updates.models) {
          updates.models = updates.models.map(m => typeof m === 'string' ? toPiModelId(m) : { ...m, id: toPiModelId(m.id) })
        }
        if (updates.defaultModel) {
          updates.defaultModel = toPiModelId(updates.defaultModel)
        }
      }

      const pendingConnection: LlmConnection = {
        ...connection,
        ...updates,
      }

      if (pendingConnection.providerType === 'pi') {
        const modelIds = (pendingConnection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
        deps.platform.logger?.info('Pi setup pending connection snapshot', {
          slug: pendingConnection.slug,
          piAuthProvider: pendingConnection.piAuthProvider,
          modelSelectionMode: pendingConnection.modelSelectionMode,
          defaultModel: pendingConnection.defaultModel,
          modelCount: modelIds.length,
          modelsFirst5: modelIds.slice(0, 5),
          setupModelCount: setup.models?.length,
          setupDefaultModel: setup.defaultModel,
        })
      }

      if (pendingConnection.providerType === 'pi' && pendingConnection.piAuthProvider && !pendingConnection.modelSelectionMode) {
        const inferredMode = setup.models?.length
          ? 'userDefined3Tier'
          : 'automaticallySyncedFromProvider'
        pendingConnection.modelSelectionMode = inferredMode
        updates.modelSelectionMode = inferredMode
      }

      if (updates.models && updates.models.length > 0) {
        const validation = validateModelList(updates.models, pendingConnection.defaultModel)
        if (!validation.valid) {
          return { success: false, ...(validation.error !== undefined ? { error: validation.error } : {}) }
        }
        if (validation.resolvedDefaultModel) {
          pendingConnection.defaultModel = validation.resolvedDefaultModel
          updates.defaultModel = validation.resolvedDefaultModel
        }
      }

      if (isCompatProvider(pendingConnection.providerType) && !pendingConnection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      if (isNewConnection) {
        const added = addLlmConnection(pendingConnection)
        if (!added) {
          deps.platform.logger?.error(`Failed to persist LLM connection: ${setup.slug} (config may be inaccessible)`)
          return { success: false, error: 'Failed to save connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Created LLM connection: ${setup.slug}`)
      } else if (Object.keys(updates).length > 0) {
        const updated = updateLlmConnection(setup.slug, updates)
        if (!updated) {
          deps.platform.logger?.error(`Failed to update LLM connection: ${setup.slug}`)
          return { success: false, error: 'Failed to update connection. Check server logs for details.' }
        }
        deps.platform.logger?.info(`Updated LLM connection settings: ${setup.slug}`)
      }

      // Store credential if provided (skip masked placeholders from GET_API_KEY)
      const isMasked = setup.credential?.includes('••')
      if (setup.credential && !isMasked) {
        const authType = pendingConnection.authType
        if (authType === 'oauth') {
          await manager.setLlmOAuth(setup.slug, { accessToken: setup.credential })
          deps.platform.logger?.info('Saved OAuth access token to LLM connection')
        } else {
          await manager.setLlmApiKey(setup.slug, setup.credential)
          deps.platform.logger?.info('Saved API key to LLM connection')
        }
      }

      // Pi+Bedrock IAM credentials — stored separately from API keys
      if (setup.iamCredentials) {
        await manager.setLlmIamCredentials(setup.slug, {
          ...setup.iamCredentials,
          region: setup.awsRegion,
        })
        deps.platform.logger?.info('Saved IAM credentials to LLM connection')
      }

      // Set as default only if no default exists yet (first connection)
      if (!getDefaultLlmConnection()) {
        setDefaultLlmConnection(setup.slug)
        deps.platform.logger?.info(`Set default LLM connection: ${setup.slug}`)
      }

      // Fetch available models before returning to the UI.
      // Always refresh for auto-synced connections (e.g. Copilot, Bedrock) — the static
      // catalog from setup is just a seed that needs replacing with live API data
      // filtered by the user's policy. For user-defined connections, only refresh
      // when no models were populated during setup.
      // Awaited so the model selector shows real available models immediately.
      const pendingModels = Array.isArray(pendingConnection.models) ? pendingConnection.models : []
      const isAutoSynced = pendingConnection.modelSelectionMode === 'automaticallySyncedFromProvider'
      // Re-auth with a new credential may point at a different account whose
      // model entitlements differ — force a refresh instead of trusting the
      // cached models from the prior credential.
      const isReauthWithNewCredential = setup.updateOnly === true && !!setup.credential && !isMasked
      if (!pendingModels.length || isAutoSynced || isReauthWithNewCredential) {
        try {
          await getModelRefreshService().refreshNow(setup.slug)
        } catch (err) {
          deps.platform.logger?.warn(`Model refresh after setup failed for ${setup.slug}: ${err instanceof Error ? err.message : err}`)
        }
      }

      // Reinitialize auth for the connection that was just created/updated,
      // not the global default (which may be a different connection).
      await sessionManager.reinitializeAuth(setup.slug)
      deps.platform.logger?.info('Reinitialized auth after LLM connection setup')

      // Clear "Setup later" flag now that user has configured a provider
      setSetupDeferred(false)

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      deps.platform.logger?.error('Failed to setup LLM connection:', message)
      return { success: false, error: message }
    }
  })

  // Unified connection test — uses the agent factory to spawn a real agent subprocess
  // and validate credentials via runMiniCompletion(). Same code path as actual chat.
  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: import('@craft-agent/shared/protocol').TestLlmConnectionParams): Promise<import('@craft-agent/shared/protocol').TestLlmConnectionResult> => {
    const { provider, apiKey, baseUrl, model, piAuthProvider, customEndpoint } = params
    const trimmedKey = apiKey?.trim() ?? ''
    const allowEmptyApiKey = !setupTestRequiresApiKey(baseUrl)

    if (!trimmedKey && !allowEmptyApiKey) {
      return { success: false, error: 'API key is required' }
    }

    const setupValidation = validateSetupTestInput({ provider, ...(baseUrl !== undefined ? { baseUrl: baseUrl } : {}), ...(piAuthProvider !== undefined ? { piAuthProvider: piAuthProvider } : {}) })
    if (!setupValidation.valid) {
      return { success: false, error: setupValidation.error }
    }

    const hint = resolveSetupTestConnectionHint({ provider, ...(baseUrl !== undefined ? { baseUrl: baseUrl } : {}), ...(piAuthProvider !== undefined ? { piAuthProvider: piAuthProvider } : {}), ...(customEndpoint !== undefined ? { customEndpoint: customEndpoint } : {}) })
    deps.platform.logger?.info(`[testLlmConnectionSetup] Testing: provider=${provider}${piAuthProvider ? ` piAuth=${piAuthProvider}` : ''}${baseUrl ? ` baseUrl=${baseUrl}` : ''} hasCustomEndpoint=${!!customEndpoint} hintProvider=${hint.providerType}`)

    const startedAt = Date.now()
    try {
      const testModel = model || getDefaultModelForConnection(provider, piAuthProvider)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Resolved model: ${testModel}`)
      const result = await testBackendConnection({
        provider,
        apiKey: trimmedKey,
        allowEmptyApiKey,
        model: testModel,
        ...(baseUrl !== undefined ? { baseUrl: baseUrl } : {}),
        timeoutMs: 45000,
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        connection: hint,
      })
      const elapsed = Date.now() - startedAt

      if (!result.success) {
        deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=false`)
        deps.platform.logger?.info(`[testLlmConnectionSetup] Raw error: ${(result.error || '').slice(0, 1000)}`)
        return { success: false, error: parseTestConnectionError(result.error || 'Unknown error') }
      }
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, success=true`)
      return { success: true }
    } catch (error) {
      const elapsed = Date.now() - startedAt
      const msg = error instanceof Error ? error.message : String(error)
      deps.platform.logger?.info(`[testLlmConnectionSetup] Elapsed: ${elapsed}ms, threw: ${msg.slice(0, 1000)}`)
      return { success: false, error: parseTestConnectionError(msg) }
    }
  })
}
