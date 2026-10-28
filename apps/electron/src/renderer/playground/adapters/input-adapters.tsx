import { omitUndefined } from '@craft-agent/shared/utils/json';
/**
 * Playground Adapters for Input Components
 *
 * Provides mock data generators and wrapper components that allow
 * the main app's input components to work in the playground context.
 */

import type { PermissionRequest } from '../../../shared/types'
import type { AdminApprovalRequestData } from '@/components/app-shell/input/structured/AdminApprovalRequest'

// ============================================================================
// Mock Data Generators
// ============================================================================

/**
 * Generate mock PermissionRequest data for playground
 */
export function mockPermissionRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
  return {
    requestId: 'mock-permission-1',
    sessionId: 'mock-session',
    toolName: 'Bash',
    description: 'Execute a shell command to list files in the current directory',
    command: 'ls -la /Users/demo/projects',
    ...overrides,
  }
}

/**
 * Generate mock AdminApprovalRequest data for playground
 */
export function mockAdminApprovalRequest(overrides?: Partial<AdminApprovalRequestData>): AdminApprovalRequestData {
  return {
    appName: 'Docker Desktop',
    reason: 'Homebrew needs admin access to complete post-install steps.',
    command: 'brew install --cask docker',
    impact: 'May install files in /Applications and system-managed directories.',
    requiresSystemPrompt: true,
    rememberForMinutes: 10,
    ...overrides,
  }
}


// ============================================================================
// Playground Wrapper Props
// ============================================================================

/**
 * Props for PermissionRequest in playground context
 */
export interface PermissionRequestPlaygroundProps {
  toolName?: string | undefined
  description?: string | undefined
  command?: string | undefined
  onAction?: (() => void) | undefined
  unstyled?: boolean | undefined
}

/**
 * Props for AdminApprovalRequest in playground context
 */
export interface AdminApprovalRequestPlaygroundProps {
  appName?: string | undefined
  reason?: string | undefined
  command?: string | undefined
  impact?: string | undefined
  requiresSystemPrompt?: boolean | undefined
  rememberForMinutes?: number | undefined
  onAction?: (() => void) | undefined
  unstyled?: boolean | undefined
}


// ============================================================================
// Adapter Functions
// ============================================================================

/**
 * Convert playground props to PermissionRequest type
 */
export function toPermissionRequest(props: PermissionRequestPlaygroundProps): PermissionRequest {
  return mockPermissionRequest(omitUndefined({
    toolName: props.toolName,
    description: props.description,
    command: props.command,
  }))
}


/**
 * Create a no-op response handler that calls onAction
 */
export function createNoOpHandler<T>(onAction?: () => void): (response: T) => void {
  return () => {
    onAction?.()
  }
}
