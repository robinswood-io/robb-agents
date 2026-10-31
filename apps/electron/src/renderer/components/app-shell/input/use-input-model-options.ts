import * as React from 'react';

import { ANTHROPIC_MODELS, getModelDisplayName } from '@config/models';
import { resolveEffectiveConnectionSlug, isCompatProvider } from '@config/llm-connections';
import { useOptionalAppShellContext } from '@/context/AppShellContext';

import { derivePickerMode } from './picker-mode';

import { THINKING_LEVELS } from '@craft-agent/shared/agent/thinking-levels';

import { getSelectableConnectionModels, groupConnectionsByProvider, stripPiPrefixForDisplay } from './model-picker-helpers';

import { cmdKey } from "./free-form-input-helpers";

interface useInputModelOptionsInput {
  t: import("i18next").TFunction<"translation", undefined>
  placeholder: string | string[] | undefined
  currentConnection: string | undefined
  connectionUnavailable: boolean
  isEmptySession: boolean
  currentModel: string
}

export function useInputModelOptions({
  t,
  placeholder,
  currentConnection,
  connectionUnavailable,
  isEmptySession,
  currentModel,
}: useInputModelOptionsInput) {
const defaultPlaceholders = React.useMemo(() => [
    t("chatInput.placeholder.workOn"),
    t("chatInput.placeholder.shiftTab"),
    t("chatInput.placeholder.mention"),
    t("chatInput.placeholder.labels"),
    t("chatInput.placeholder.newLine"),
    t("chatInput.placeholder.sidebar", { key: cmdKey }),
    t("chatInput.placeholder.focusMode", { key: cmdKey }),
  ], [t])

const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

const appShellCtx = useOptionalAppShellContext()

const llmConnections = React.useMemo(() => appShellCtx?.llmConnections ?? [], [appShellCtx?.llmConnections])

const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection

const connectionDefaultModel = React.useMemo(() => {
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const conn = llmConnections.find(c => c.slug === effectiveSlug)
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    // Allow model switching when connection has multiple models
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [currentConnection, workspaceDefaultConnection, llmConnections])

const pickerMode = derivePickerMode({
    connectionUnavailable,
    connectionDefaultModel,
    isEmptySession,
    connectionCount: llmConnections.length,
  })

const availableModels = React.useMemo(() => {
    // Connection removed — don't fall through to another connection's models
    if (connectionUnavailable) return []

    // Determine effective connection using the canonical fallback chain
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const connection = llmConnections.find(c => c.slug === effectiveSlug)

    if (!connection) {
      return ANTHROPIC_MODELS // Safety net — shouldn't happen
    }

    return getSelectableConnectionModels(connection, ANTHROPIC_MODELS)
  }, [llmConnections, currentConnection, workspaceDefaultConnection, connectionUnavailable])

const availableThinkingLevels = THINKING_LEVELS

const thinkingDisabled = React.useMemo(() => {
    const model = availableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [availableModels, currentModel])

const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? currentModel
    const model = availableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      // Fallback: use helper function to format unknown model IDs nicely
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    if (typeof model === 'string') return stripPiPrefixForDisplay(model)
    // Defensive: partial entries (custom-endpoint user-config or vision-toggle
    // promotions) may lack `name`. Fall back to the id so the trigger button
    // never goes blank.
    return model.name ?? stripPiPrefixForDisplay(model.id)
  }, [availableModels, currentModel, connectionDefaultModel])

const connectionsByProvider = React.useMemo(
    () => groupConnectionsByProvider(llmConnections),
    [llmConnections],
  )

const currentConnectionDetails = React.useMemo(() => {
    if (!currentConnection) return null
    return llmConnections.find(c => c.slug === currentConnection) ?? null
  }, [llmConnections, currentConnection])

const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)

const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])

const selectorDisplayName = `${t(
    'chat.modelPicker.manual',
  )} · ${currentModelDisplayName}`
return { appShellCtx, effectivePlaceholderProp, effectiveConnectionDetails, currentModelDisplayName, selectorDisplayName, llmConnections, pickerMode, connectionDefaultModel, connectionsByProvider, effectiveConnection, currentConnectionDetails, availableModels, availableThinkingLevels, thinkingDisabled }
}
