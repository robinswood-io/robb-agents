import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Logger } from '../runtime/platform'

export interface PrivilegedExecutionRequest {
  requestId: string
  sessionId: string
  command: string
  commandHash: string
  reason?: string
  impact?: string
  approvalTtlSeconds: number
  createdAt: number
  expiresAt: number
}

interface PendingPrivilegedRequest extends PrivilegedExecutionRequest {
  policyAllowed: boolean
  policyReason?: string
}

const DEFAULT_APPROVAL_TTL_SECONDS = 120
const MIN_APPROVAL_TTL_SECONDS = 10
const MAX_APPROVAL_TTL_SECONDS = 600
const AUDIT_LOG_PATH = join(homedir(), '.craft-agent', 'logs', 'privileged-actions.jsonl')
const FORBIDDEN_SHELL_SYNTAX = /[\0\r\n;&|<>`$\\]/
const BREW_CASK_COMMAND = /^brew\s+(?:install|upgrade)\s+--cask\s+[a-z0-9][a-z0-9+._@/-]*$/i
const INSTALLER_COMMAND = /^installer\s+-pkg\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[a-z0-9_./][a-z0-9_./+@%:,=-]*)\s+-target\s+\/$/i

/**
 * PrivilegedExecutionBroker
 *
 * Owns privileged-execution approval binding and auditing.
 * Execution itself is delegated to backend tool execution paths.
 */
export class PrivilegedExecutionBroker {
  private pending = new Map<string, PendingPrivilegedRequest>()

  constructor(
    private logger: Logger,
    private readonly auditLogPath = AUDIT_LOG_PATH,
  ) {}

  createRequest(input: {
    requestId: string
    sessionId: string
    command: string
    reason?: string
    impact?: string
    approvalTtlSeconds?: number
  }): PrivilegedExecutionRequest {
    if (this.pending.has(input.requestId)) {
      throw new Error('A privileged approval request with this ID is already pending')
    }

    const now = Date.now()
    const ttl = input.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS
    if (
      !Number.isInteger(ttl)
      || ttl < MIN_APPROVAL_TTL_SECONDS
      || ttl > MAX_APPROVAL_TTL_SECONDS
    ) {
      throw new Error(
        `Privileged approval TTL must be an integer between ${MIN_APPROVAL_TTL_SECONDS} and ${MAX_APPROVAL_TTL_SECONDS} seconds`,
      )
    }
    const policy = this.validatePolicy(input.command)

    const request: PendingPrivilegedRequest = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      command: input.command,
      commandHash: this.hashCommand(input.command),
      reason: input.reason,
      impact: input.impact,
      approvalTtlSeconds: ttl,
      createdAt: now,
      expiresAt: now + ttl * 1000,
      policyAllowed: policy.allowed,
      policyReason: policy.reason,
    }

    this.pending.set(input.requestId, request)
    void this.appendAudit({
      event: 'privileged_request_created',
      requestId: request.requestId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      policyAllowed: request.policyAllowed,
      policyReason: request.policyReason,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    })

    return request
  }

  resolveApproval(
    requestId: string,
    approved: boolean,
    options?: {
      expectedCommandHash?: string
      expectedSessionId?: string
    },
  ): {
    ok: boolean
    reason?: string
    request?: PrivilegedExecutionRequest
  } {
    const request = this.pending.get(requestId)
    if (!request) {
      return { ok: false, reason: 'No pending privileged request found' }
    }

    if (options?.expectedSessionId && options.expectedSessionId !== request.sessionId) {
      void this.appendAudit({
        event: 'privileged_request_session_mismatch',
        requestId: request.requestId,
        expectedSessionId: options.expectedSessionId,
        actualSessionId: request.sessionId,
      })
      return { ok: false, reason: 'Session mismatch for privileged approval request' }
    }

    if (options?.expectedCommandHash && options.expectedCommandHash !== request.commandHash) {
      void this.appendAudit({
        event: 'privileged_request_hash_mismatch',
        requestId: request.requestId,
        sessionId: request.sessionId,
        expectedCommandHash: options.expectedCommandHash,
        actualCommandHash: request.commandHash,
      })
      return { ok: false, reason: 'Command hash mismatch for privileged approval request' }
    }

    this.pending.delete(requestId)

    if (!request.policyAllowed) {
      void this.appendAudit({
        event: 'privileged_request_blocked_by_policy',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        policyReason: request.policyReason,
      })
      return { ok: false, reason: request.policyReason ?? 'Command is not allowed by privileged policy' }
    }

    if (Date.now() > request.expiresAt) {
      void this.appendAudit({
        event: 'privileged_request_expired',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        expiresAt: request.expiresAt,
      })
      return { ok: false, reason: 'Privileged approval request expired' }
    }

    void this.appendAudit({
      event: approved ? 'privileged_request_approved' : 'privileged_request_denied',
      requestId: request.requestId,
      sessionId: request.sessionId,
      commandHash: request.commandHash,
      resolvedAt: Date.now(),
    })

    return {
      ok: true,
      request: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        command: request.command,
        commandHash: request.commandHash,
        reason: request.reason,
        impact: request.impact,
        approvalTtlSeconds: request.approvalTtlSeconds,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      },
    }
  }

  private hashCommand(command: string): string {
    return createHash('sha256').update(command, 'utf8').digest('hex')
  }

  private validatePolicy(command: string): { allowed: boolean; reason?: string } {
    const normalized = command.trim()
    if (FORBIDDEN_SHELL_SYNTAX.test(normalized)) {
      return {
        allowed: false,
        reason: 'Privileged execution policy rejects shell control and expansion syntax',
      }
    }

    const allowlisted =
      BREW_CASK_COMMAND.test(normalized)
      || INSTALLER_COMMAND.test(normalized)

    if (!allowlisted) {
      return {
        allowed: false,
        reason: 'Privileged execution policy only allows brew cask install/upgrade and installer -pkg -target / commands',
      }
    }

    return { allowed: true }
  }

  auditEvent(event: string, payload: Record<string, unknown>): void {
    void this.appendAudit({ event, ...payload })
  }

  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(dirname(this.auditLogPath), { recursive: true, mode: 0o700 })
      await appendFile(
        this.auditLogPath,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...payload })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      await chmod(this.auditLogPath, 0o600)
    } catch (error) {
      this.logger.warn('[PrivilegedExecutionBroker] Failed to write audit log:', error)
    }
  }
}
