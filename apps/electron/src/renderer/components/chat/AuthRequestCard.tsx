import * as React from 'react';
import { useState, useCallback } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import "@craft-agent/ui";
import "@/components/ui/button";
import "@/components/ui/input";
import "@/components/ui/label";
import { cn } from '@/lib/utils';
import { validateBasicAuthCredentials, getPasswordValue, getPasswordLabel, getPasswordPlaceholder } from '@/utils/auth-validation';

import { AuthRequestContent } from "./auth-request-content";
import { type AuthCardVariant, VARIANT_STYLES, AuthCardHeader } from "./auth-request-primitives";





import type { Message, CredentialResponse } from '../../../shared/types';
import type { AuthRequestType } from '@craft-agent/core/types';


// ============================================================================
// Main Component
// ============================================================================

interface AuthRequestCardProps {
  message: Message
  /** Callback to respond to credential request */
  onRespondToCredential?: ((sessionId: string, requestId: string, response: CredentialResponse) => void | Promise<void>) | undefined
  /** Session ID for this auth request */
  sessionId: string
  /** Whether the card is interactive (last message, no user message after). Default true. */
  isInteractive?: boolean | undefined
}

/**
 * AuthRequestCard - Inline auth UI displayed in chat history
 *
 * Renders different UIs based on auth type:
 * - credential: Form for API key, bearer token, basic auth
 * - oauth/oauth-google/oauth-slack/oauth-microsoft: OAuth flow with browser redirect
 *
 * Status handling:
 * - pending: Show interactive form/button
 * - completed: Show success state
 * - cancelled: Show cancelled state
 * - failed: Show error state
 */
export function AuthRequestCard({ message, onRespondToCredential, sessionId, isInteractive = true }: AuthRequestCardProps) {
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const credentialResponseInFlightRef = React.useRef(false)
  const oauthInFlightRef = React.useRef(false)

  const {
    authRequestId,
    authRequestType,
    authSourceSlug,
    authSourceName,
    authStatus,
    authCredentialMode,
    authHeaderName,
    authHeaderNames,
    authLabels,
    authDescription,
    authHint,
    authSourceUrl,
    authPasswordRequired,
    authError,
    authEmail,
    authWorkspace,
  } = message

  // Multi-header state: { "DD-API-KEY": "", "DD-APPLICATION-KEY": "" }
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    if (authHeaderNames) {
      for (const name of authHeaderNames) {
        initial[name] = ''
      }
    }
    return initial
  })

  const isBasicAuth = authCredentialMode === 'basic'
  const isMultiHeader = authCredentialMode === 'multi-header'
  const passwordRequired = authPasswordRequired ?? true  // default true for backward compatibility

  // Validation logic
  const isValid = isBasicAuth
    ? validateBasicAuthCredentials(username, password, passwordRequired)
    : isMultiHeader
    ? authHeaderNames?.every(name => (headerValues[name]?.trim().length ?? 0) > 0) ?? false
    : value.trim().length > 0

  const submitCredentialResponse = useCallback(async (response: CredentialResponse) => {
    if (!authRequestId || !onRespondToCredential || credentialResponseInFlightRef.current) return
    credentialResponseInFlightRef.current = true
    setIsSubmitting(true)
    // Retain the immutable payload only for the RPC; remove credential values
    // from component state immediately so historical cards do not keep them.
    setValue('')
    setUsername('')
    setPassword('')
    setHeaderValues(current => Object.fromEntries(Object.keys(current).map(key => [key, ''])))
    try {
      await onRespondToCredential(sessionId, authRequestId, response)
    } catch (error) {
      console.error('[AuthRequestCard] Failed to submit credential response:', error)
    } finally {
      credentialResponseInFlightRef.current = false
      setIsSubmitting(false)
    }
  }, [onRespondToCredential, sessionId, authRequestId])

  const handleSubmit = useCallback(() => {
    if (!isValid) return
    if (isBasicAuth) {
      void submitCredentialResponse({
        type: 'credential',
        username: username.trim(),
        password: getPasswordValue(password, passwordRequired),
        cancelled: false
      })
    } else if (isMultiHeader) {
      // Trim all header values
      const trimmedHeaders: Record<string, string> = {}
      for (const [key, val] of Object.entries(headerValues)) {
        trimmedHeaders[key] = val.trim()
      }
      void submitCredentialResponse({
        type: 'credential',
        headers: trimmedHeaders,
        cancelled: false
      })
    } else {
      void submitCredentialResponse({
        type: 'credential',
        value: value.trim(),
        cancelled: false
      })
    }
  }, [isBasicAuth, isMultiHeader, username, password, value, headerValues, isValid, passwordRequired, submitCredentialResponse])

  const handleCancel = useCallback(() => {
    void submitCredentialResponse({ type: 'credential', cancelled: true })
  }, [submitCredentialResponse])

  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    handleSubmit()
  }, [handleSubmit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isValid) {
      handleSubmit()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }, [isValid, handleSubmit, handleCancel])

  const handleOAuthClick = useCallback(async () => {
    // Client-driven OAuth: callback server runs locally, server owns tokens
    if (oauthInFlightRef.current) return
    if (!authRequestId || !authSourceSlug) {
      console.warn('[AuthRequestCard] handleOAuthClick bailed: missing', {
        authRequestId: authRequestId ?? 'MISSING',
        authSourceSlug: authSourceSlug ?? 'MISSING',
        sessionId,
      })
      return
    }
    oauthInFlightRef.current = true
    setIsSubmitting(true)
    try {
      const result = await window.electronAPI.performOAuth({
        sourceSlug: authSourceSlug,
        sessionId,
        authRequestId,
      })
      if (!result.success) {
        console.warn('[AuthRequestCard] performOAuth returned failure:', result.error)
      }
    } catch (error) {
      console.error('[AuthRequestCard] performOAuth threw:', error)
    } finally {
      oauthInFlightRef.current = false
      setIsSubmitting(false)
    }
  }, [sessionId, authRequestId, authSourceSlug])

  // Get field labels
  const credentialLabel = authLabels?.credential ||
    (authCredentialMode === 'bearer' ? 'Bearer Token' : 'API Key')
  const usernameLabel = authLabels?.username || 'Username'
  const basePasswordLabel = authLabels?.password || 'Password'
  const passwordLabel = getPasswordLabel(basePasswordLabel, passwordRequired)
  const passwordPlaceholder = getPasswordPlaceholder(basePasswordLabel, passwordRequired)

  // Get auth type label
  const getAuthTypeLabel = (type: AuthRequestType | undefined) => {
    switch (type) {
      case 'oauth':
        return 'OAuth'
      case 'oauth-google':
        return 'Google Sign-In'
      case 'oauth-slack':
        return 'Slack Sign-In'
      case 'oauth-microsoft':
        return 'Microsoft Sign-In'
      case 'credential':
      default:
        return 'Authentication'
    }
  }

  const authTypeLabel = getAuthTypeLabel(authRequestType)

  // Determine variant based on status
  const variant: AuthCardVariant =
    authStatus === 'completed' ? 'success' :
    authStatus === 'cancelled' ? 'muted' :
    authStatus === 'failed' ? 'error' :
    'default'

  // Determine if we need action bar (pending states with forms/buttons)
  // Show actions when: pending credential form, OR pending OAuth that hasn't started yet
  const isOAuth = authRequestType && authRequestType !== 'credential'
  const hasActions = authStatus === 'pending' && (
    !isOAuth || !isSubmitting
  )

  const { bg: variantBg, textClass: variantTextClass, shadowColor } = VARIANT_STYLES[variant]

  // Compact card view for non-interactive terminal states (after user sends message)
  if (!isInteractive && authStatus !== 'pending') {
    const StatusIcon = authStatus === 'completed' ? CheckCircle2 : XCircle
    const title =
      authStatus === 'completed' ? `${authSourceName} Connected` :
      authStatus === 'cancelled' ? `${authSourceName} Cancelled` :
      `${authSourceName} Failed`
    const subtitle =
      authStatus === 'completed' && authEmail ? `Signed in as ${authEmail}` :
      authStatus === 'failed' && authError ? authError :
      undefined

    return (
      <div
        className={cn('rounded-[8px] overflow-hidden w-fit select-none', variantTextClass)}
        style={{
          backgroundColor: variantBg,
          ...(shadowColor ? { '--shadow-color': shadowColor } as React.CSSProperties : {})
        }}
      >
        <div className="pl-4 pr-5 py-3">
          <AuthCardHeader
            icon={StatusIcon}
            title={title}
            subtitle={subtitle}
          />
        </div>
      </div>
    )
  }

  return (
    <AuthRequestContent
      authStatus={authStatus}
      authSourceName={authSourceName}
      authEmail={authEmail}
      authWorkspace={authWorkspace}
      authError={authError}
      isOAuth={isOAuth}
      isSubmitting={isSubmitting}
      authTypeLabel={authTypeLabel}
      authDescription={authDescription}
      isBasicAuth={isBasicAuth}
      authRequestId={authRequestId}
      usernameLabel={usernameLabel}
      username={username}
      setUsername={setUsername}
      handleKeyDown={handleKeyDown}
      passwordLabel={passwordLabel}
      showPassword={showPassword}
      password={password}
      setPassword={setPassword}
      passwordPlaceholder={passwordPlaceholder}
      setShowPassword={setShowPassword}
      isMultiHeader={isMultiHeader}
      authHeaderNames={authHeaderNames}
      headerValues={headerValues}
      setHeaderValues={setHeaderValues}
      credentialLabel={credentialLabel}
      authCredentialMode={authCredentialMode}
      authHeaderName={authHeaderName}
      value={value}
      setValue={setValue}
      authHint={authHint}
      hasActions={hasActions}
      handleOAuthClick={handleOAuthClick}
      handleCancel={handleCancel}
      handleSubmit={handleSubmit}
      isValid={isValid}
      variantTextClass={variantTextClass}
      variantBg={variantBg}
      shadowColor={shadowColor}
      handleFormSubmit={handleFormSubmit}
      authSourceUrl={authSourceUrl}
    />
  )
}

/**
 * Memoized version for performance in chat list
 */
export const MemoizedAuthRequestCard = React.memo(AuthRequestCard, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.authStatus === next.message.authStatus &&
    prev.sessionId === next.sessionId &&
    prev.isInteractive === next.isInteractive
  )
})
