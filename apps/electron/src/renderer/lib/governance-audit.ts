import type { GovernanceAuditEvent } from '@craft-agent/shared/governance'

export interface GovernanceAuditVerification {
  valid: boolean
  invalidSequence?: number
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded)
  return bytesToHex(new Uint8Array(digest))
}

async function auditEventHash(event: Omit<GovernanceAuditEvent, 'hash'>): Promise<string> {
  const canonical = [
    event.sequence,
    event.spaceId,
    event.action,
    event.actorId,
    event.targetId,
    event.timestamp,
    event.detailsHash,
    event.previousHash,
  ].join('\u001f')
  return sha256(canonical)
}

export async function verifyGovernanceAuditInBrowser(
  events: readonly GovernanceAuditEvent[],
): Promise<GovernanceAuditVerification> {
  let previousHash = 'GENESIS'
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event) continue
    const { hash, ...base } = event
    if (
      event.sequence !== index + 1
      || event.previousHash !== previousHash
      || await auditEventHash(base) !== hash
    ) {
      return { valid: false, invalidSequence: event.sequence }
    }
    previousHash = hash
  }
  return { valid: true }
}
