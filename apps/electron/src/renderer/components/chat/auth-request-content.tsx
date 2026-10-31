import * as React from 'react';

import { Key, User, Lock, Eye, EyeOff, CheckCircle2, XCircle } from 'lucide-react';
import { Spinner } from '@craft-agent/ui';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

import type { AuthStatus } from '@craft-agent/core/types';

import { AuthCardHeader, AuthCardActions } from "./auth-request-primitives";

interface AuthRequestContentProps {
  authStatus: AuthStatus | undefined
  authSourceName: string | undefined
  authEmail: string | undefined
  authWorkspace: string | undefined
  authError: string | undefined
  isOAuth: boolean | undefined
  isSubmitting: boolean
  authTypeLabel: "OAuth" | "Google Sign-In" | "Slack Sign-In" | "Microsoft Sign-In" | "Authentication"
  authDescription: string | undefined
  isBasicAuth: boolean
  authRequestId: string | undefined
  usernameLabel: string
  username: string
  setUsername: React.Dispatch<React.SetStateAction<string>>
  handleKeyDown: (e: React.KeyboardEvent) => void
  passwordLabel: string
  showPassword: boolean
  password: string
  setPassword: React.Dispatch<React.SetStateAction<string>>
  passwordPlaceholder: string
  setShowPassword: React.Dispatch<React.SetStateAction<boolean>>
  isMultiHeader: boolean
  authHeaderNames: string[] | undefined
  headerValues: Record<string, string>
  setHeaderValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  credentialLabel: string
  authCredentialMode: import("@craft-agent/core").CredentialInputMode | undefined
  authHeaderName: string | undefined
  value: string
  setValue: React.Dispatch<React.SetStateAction<string>>
  authHint: string | undefined
  hasActions: boolean
  handleOAuthClick: () => Promise<void>
  handleCancel: () => void
  handleSubmit: () => void
  isValid: boolean
  variantTextClass: string
  variantBg: string
  shadowColor: string | undefined
  handleFormSubmit: (e: React.FormEvent) => void
  authSourceUrl: string | undefined
}

export function AuthRequestContent({
  authStatus,
  authSourceName,
  authEmail,
  authWorkspace,
  authError,
  isOAuth,
  isSubmitting,
  authTypeLabel,
  authDescription,
  isBasicAuth,
  authRequestId,
  usernameLabel,
  username,
  setUsername,
  handleKeyDown,
  passwordLabel,
  showPassword,
  password,
  setPassword,
  passwordPlaceholder,
  setShowPassword,
  isMultiHeader,
  authHeaderNames,
  headerValues,
  setHeaderValues,
  credentialLabel,
  authCredentialMode,
  authHeaderName,
  value,
  setValue,
  authHint,
  hasActions,
  handleOAuthClick,
  handleCancel,
  handleSubmit,
  isValid,
  variantTextClass,
  variantBg,
  shadowColor,
  handleFormSubmit,
  authSourceUrl,
}: AuthRequestContentProps) {
const renderContent = () => {
    // Completed state
    if (authStatus === 'completed') {
      return (
        <AuthCardHeader
          icon={CheckCircle2}
          title={`${authSourceName} Connected`}
          subtitle={authEmail ? `Signed in as ${authEmail}` : undefined}
          subtitleSecondary={authWorkspace ? `Workspace: ${authWorkspace}` : undefined}
        />
      )
    }

    // Cancelled state
    if (authStatus === 'cancelled') {
      return (
        <AuthCardHeader
          icon={XCircle}
          title={`${authSourceName} Cancelled`}
        />
      )
    }

    // Failed state
    if (authStatus === 'failed') {
      return (
        <AuthCardHeader
          icon={XCircle}
          title={`${authSourceName} Failed`}
          subtitle={authError || undefined}
        />
      )
    }

    // OAuth authenticating state (waiting for browser)
    if (isOAuth && isSubmitting) {
      return (
        <div className="flex gap-3">
          <Spinner className="text-[10px] shrink-0 mt-1" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium leading-5">
              {`${authSourceName} Authenticating...`}
            </div>
            <div className="text-xs mt-0.5 opacity-50">
              Complete authentication in your browser
            </div>
          </div>
        </div>
      )
    }

    // OAuth pending state (button)
    if (isOAuth) {
      return (
        <AuthCardHeader
          title={`${authSourceName} ${authTypeLabel}`}
          description={authDescription || undefined}
        />
      )
    }

    // Credential input form - just the header part
    return (
      <AuthCardHeader
        title={`${authSourceName} Authentication`}
        description={authDescription || undefined}
      />
    )
  }

const renderCredentialFields = () => {
    if (authStatus !== 'pending' || isOAuth) return null

    return (
      <div className="space-y-3">
        {isBasicAuth ? (
          <>
            {/* Username field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-username-${authRequestId}`} className="text-xs">
                {usernameLabel}
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={`auth-username-${authRequestId}`}
                  name="username"
                  autoComplete="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9"
                  placeholder={`Enter ${usernameLabel.toLowerCase()}`}
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>
            </div>
            {/* Password field */}
            <div className="space-y-1.5">
              <Label htmlFor={`auth-password-${authRequestId}`} className="text-xs">
                {passwordLabel}
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id={`auth-password-${authRequestId}`}
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="pl-9 pr-9"
                  placeholder={passwordPlaceholder}
                  disabled={isSubmitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </>
        ) : isMultiHeader && authHeaderNames ? (
          /* Multi-header fields (e.g., Datadog DD-API-KEY + DD-APPLICATION-KEY) */
          <>
            {authHeaderNames.map((headerName, index) => (
              <div key={headerName} className="space-y-1.5">
                <Label htmlFor={`auth-header-${authRequestId}-${index}`} className="text-xs">
                  {headerName}
                </Label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id={`auth-header-${authRequestId}-${index}`}
                    name={headerName}
                    autoComplete="off"
                    type={showPassword ? 'text' : 'password'}
                    value={headerValues[headerName] || ''}
                    onChange={(e) => setHeaderValues(prev => ({
                      ...prev,
                      [headerName]: e.target.value
                    }))}
                    onKeyDown={handleKeyDown}
                    className="pl-9 pr-9"
                    placeholder={`Enter ${headerName}`}
                    autoFocus={index === 0}
                    disabled={isSubmitting}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : (
          /* Single credential field (API key, bearer token) */
          <div className="space-y-1.5">
            <Label htmlFor={`auth-value-${authRequestId}`} className="text-xs">
              {credentialLabel}
              {authCredentialMode === 'header' && authHeaderName && (
                <span className="text-muted-foreground ml-1">
                  ({authHeaderName})
                </span>
              )}
            </Label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id={`auth-value-${authRequestId}`}
                name="credential"
                autoComplete="current-password"
                type={showPassword ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="pl-9 pr-9"
                placeholder={`Enter ${credentialLabel.toLowerCase()}`}
                autoFocus
                disabled={isSubmitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        )}

        {/* Hint */}
        {authHint && (
          <p className="text-[11px] text-muted-foreground">
            {authHint}
          </p>
        )}
      </div>
    )
  }

const renderActions = () => {
    if (!hasActions) return null

    // OAuth pending - sign in button
    if (isOAuth) {
      return (
        <AuthCardActions
          primary={{
            label: `Sign in with ${authTypeLabel.replace(' Sign-In', '')}`,
            onClick: handleOAuthClick,
            dataTutorial: 'oauth-sign-in-button',
          }}
          secondary={{
            label: 'Cancel',
            onClick: handleCancel,
          }}
        />
      )
    }

    // Credential form - save button (uses type="submit" inside form)
    return (
      <AuthCardActions
        primary={{
          label: isSubmitting ? 'Saving...' : 'Save',
          onClick: handleSubmit,
          disabled: !isValid || isSubmitting,
          loading: isSubmitting,
        }}
        secondary={{
          label: 'Cancel',
          onClick: handleCancel,
          disabled: isSubmitting,
        }}
        hint="Credentials are encrypted at rest"
      />
    )
  }

const isCredentialForm = authStatus === 'pending' && !isOAuth

const cardContent = (
    <>
      <div
        className={cn(
          hasActions ? 'p-4' : 'px-4 py-3',
          !isOAuth && authStatus === 'pending' && 'space-y-4'
        )}
      >
        {renderContent()}
        {renderCredentialFields()}
      </div>

      {hasActions && renderActions()}
    </>
  )
  return (
    <div
      className={cn('rounded-[8px] overflow-hidden', variantTextClass)}
      style={{
        backgroundColor: variantBg,
        ...(shadowColor ? { '--shadow-color': shadowColor } as React.CSSProperties : {})
      }}
    >
      {/* Form wrapper enables password manager (1Password) detection and autofill.
          action points to the source URL for domain-based credential matching. */}
      {isCredentialForm ? (
        <form
          onSubmit={handleFormSubmit}
          action={authSourceUrl || undefined}
          method="post"
        >
          {cardContent}
        </form>
      ) : (
        cardContent
      )}
    </div>
  )
}
