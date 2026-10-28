import type { AgentEvent } from '@craft-agent/core/types';
import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { createPiAgentTestConfig } from './fixtures/pi-agent-config.ts';


describe('PiAgent subprocess error handling', () => {
  it('maps raw HTML subprocess errors to typed proxy_error events', () => {
    const agent = new PiAgent(createPiAgentTestConfig())

    const enqueued: AgentEvent[] = []
    ;agent['eventQueue'].enqueue = (event: AgentEvent) => {
      enqueued.push(event)
    }

    ;agent.handleLine(JSON.stringify({
      type: 'error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(1)
    const event = enqueued[0]
    if (event?.type !== 'typed_error') throw new Error('Expected one typed subprocess proxy error')
    expect(event.type).toBe('typed_error')
    expect(event.error.code).toBe('proxy_error')
    expect(event.error.message.toLowerCase()).not.toContain('<html')

    agent.destroy()
  })

  it('does not enqueue chat errors for mini_completion_error messages', () => {
    const agent = new PiAgent(createPiAgentTestConfig())

    const enqueued: AgentEvent[] = []
    ;agent['eventQueue'].enqueue = (event: AgentEvent) => {
      enqueued.push(event)
    }

    let rejectedMessage = ''
    ;agent.pendingMiniCompletions.set('mini-1', {
      resolve: () => {},
      reject: (error: Error) => {
        rejectedMessage = error.message
      },
    })

    ;agent.handleLine(JSON.stringify({
      type: 'error',
      code: 'mini_completion_error',
      message: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
    }))

    expect(enqueued).toHaveLength(0)
    expect(agent.pendingMiniCompletions.size).toBe(0)
    expect(rejectedMessage).toContain('400 Bad Request')

    agent.destroy()
  })

  it('suppresses only identical consecutive subprocess errors', () => {
    const agent = new PiAgent(createPiAgentTestConfig())

    const enqueued: AgentEvent[] = []
    ;agent['eventQueue'].enqueue = (event: AgentEvent) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 4; i++) {
      ;agent.handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    expect(enqueued).toHaveLength(3)
    expect(enqueued.every((event) => event.type === 'error' || event.type === 'typed_error')).toBe(true)

    agent.destroy()
  })

  it('resets repeated subprocess error suppression after non-error traffic', () => {
    const agent = new PiAgent(createPiAgentTestConfig())

    const enqueued: AgentEvent[] = []
    ;agent['eventQueue'].enqueue = (event: AgentEvent) => {
      enqueued.push(event)
    }

    for (let i = 0; i < 3; i++) {
      ;agent.handleLine(JSON.stringify({
        type: 'error',
        message: 'EFAULT: broken pipe',
      }))
    }

    ;agent.handleLine(JSON.stringify({
      type: 'event',
      event: { type: 'agent_message_delta', delta: 'ok' },
    }))

    ;agent.handleLine(JSON.stringify({
      type: 'error',
      message: 'EFAULT: broken pipe',
    }))

    expect(enqueued.filter((event) => event.type === 'error' || event.type === 'typed_error')).toHaveLength(4)

    agent.destroy()
  })
})
