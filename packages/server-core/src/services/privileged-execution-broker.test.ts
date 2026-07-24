import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { Logger } from '../runtime/platform'
import { PrivilegedExecutionBroker } from './privileged-execution-broker'

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}

function createBroker(): PrivilegedExecutionBroker {
  return new PrivilegedExecutionBroker(
    logger,
    join(tmpdir(), `robb-privileged-broker-${randomUUID()}`, 'audit.jsonl'),
  )
}

function createRequest(
  broker: PrivilegedExecutionBroker,
  command: string,
  approvalTtlSeconds = 120,
): string {
  const requestId = randomUUID()
  broker.createRequest({
    requestId,
    sessionId: 'session-test',
    command,
    approvalTtlSeconds,
  })
  return requestId
}

describe('PrivilegedExecutionBroker policy', () => {
  test.each([
    'brew install --cask visual-studio-code',
    'brew upgrade --cask 1password',
    'installer -pkg "/tmp/Robb Agents.pkg" -target /',
  ])('allows exact privileged command %s', (command) => {
    const broker = createBroker()
    const requestId = createRequest(broker, command)

    expect(broker.resolveApproval(requestId, true)).toMatchObject({
      ok: true,
      request: { command },
    })
  })

  test.each([
    'brew install --cask visual-studio-code; rm -rf /tmp/example',
    'brew install --cask visual-studio-code && whoami',
    'brew install --cask $(whoami)',
    'installer -pkg /tmp/app.pkg -target / | sh',
    'installer -pkg /tmp/app.pkg -target / --verbose',
  ])('rejects command injection or trailing arguments in %s', (command) => {
    const broker = createBroker()
    const requestId = createRequest(broker, command)
    const result = broker.resolveApproval(requestId, true)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('policy')
  })

  test.each([0, 9, 10.5, 601])('rejects invalid approval TTL %s', (approvalTtlSeconds) => {
    const broker = createBroker()

    expect(() => createRequest(
      broker,
      'brew install --cask visual-studio-code',
      approvalTtlSeconds,
    )).toThrow('between 10 and 600 seconds')
  })

  test('binds approval to its session and preserves the request after a mismatch', () => {
    const broker = createBroker()
    const requestId = randomUUID()
    const request = broker.createRequest({
      requestId,
      sessionId: 'session-owner',
      command: 'brew install --cask visual-studio-code',
    })

    expect(broker.resolveApproval(requestId, true, {
      expectedCommandHash: request.commandHash,
      expectedSessionId: 'session-other',
    })).toEqual({
      ok: false,
      reason: 'Session mismatch for privileged approval request',
    })

    expect(broker.resolveApproval(requestId, true, {
      expectedCommandHash: request.commandHash,
      expectedSessionId: 'session-owner',
    }).ok).toBe(true)
  })

  test('rejects duplicate pending request IDs', () => {
    const broker = createBroker()
    const requestId = createRequest(broker, 'brew install --cask visual-studio-code')

    expect(() => broker.createRequest({
      requestId,
      sessionId: 'session-other',
      command: 'brew upgrade --cask 1password',
    })).toThrow('already pending')
  })
})
