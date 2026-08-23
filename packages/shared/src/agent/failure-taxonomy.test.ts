import { describe, expect, it } from 'bun:test'
import { classifyAgentFailure } from './failure-taxonomy.ts'

describe('classifyAgentFailure', () => {
  it('prefers a structured status over ambiguous message text', () => {
    expect(classifyAgentFailure({
      message: 'upstream said something unexpected',
      httpStatus: 429,
      retryAfterMs: 2_000,
    })).toEqual({
      failureClass: 'rate-limited',
      retryability: 'safe',
      recovery: 'provider-fallback',
      confidence: 'structured',
      retryAfterMs: 2_000,
    })
  })

  it('distinguishes interactive authentication from missing credentials', () => {
    expect(classifyAgentFailure({ message: 'OAuth requires MFA' }).failureClass)
      .toBe('interactive-auth-required')
    expect(classifyAgentFailure({ message: 'Unauthorized: API key missing' }).failureClass)
      .toBe('credential-required')
    expect(classifyAgentFailure({ message: 'OAuth access token expired' }).failureClass)
      .toBe('credential-required')
  })

  it('classifies validation errors as non-retryable input failures', () => {
    expect(classifyAgentFailure({
      message: 'ignored',
      code: 'INVALID_ARGUMENT',
    })).toMatchObject({
      failureClass: 'invalid-input',
      retryability: 'never',
      recovery: 'fix-input',
      confidence: 'structured',
    })
  })

  it('classifies execution bridge failures as runtime reconnect candidates', () => {
    expect(classifyAgentFailure({
      message: 'Command bridge returned empty query while tools context is corrupted',
    })).toMatchObject({
      failureClass: 'execution-bridge-unavailable',
      retryability: 'safe',
      recovery: 'runtime-reconnect',
      confidence: 'heuristic',
    })

    expect(classifyAgentFailure({
      message: 'fetch failed',
      code: 'EXECUTION_BRIDGE_UNAVAILABLE',
    })).toMatchObject({
      failureClass: 'execution-bridge-unavailable',
      recovery: 'runtime-reconnect',
      confidence: 'structured',
    })
  })

  it('keeps generic structured handler and client errors out of runtime reconnect without bridge context', () => {
    expect(classifyAgentFailure({
      message: 'generic handler failure',
      code: 'HANDLER_ERROR',
    })).toMatchObject({
      failureClass: 'unknown',
      recovery: 'browser-fallback',
      confidence: 'fallback',
    })

    expect(classifyAgentFailure({
      message: 'browser client timed out waiting for response',
      code: 'CLIENT_REQUEST_TIMEOUT',
      toolName: 'mcp__session__browser_tool',
    })).toMatchObject({
      failureClass: 'timeout',
      recovery: 'retry',
      confidence: 'structured',
    })

    expect(classifyAgentFailure({
      message: 'client websocket went away',
      code: 'CLIENT_DISCONNECTED',
    })).toMatchObject({
      failureClass: 'network-unavailable',
      recovery: 'browser-fallback',
      confidence: 'structured',
    })

    expect(classifyAgentFailure({
      message: 'empty query',
    }).failureClass).not.toBe('execution-bridge-unavailable')
  })

  it('uses contextual structured bridge errors for runtime reconnect', () => {
    expect(classifyAgentFailure({
      message: 'handler failed while dispatching exec_command',
      code: 'HANDLER_ERROR',
    })).toMatchObject({
      failureClass: 'execution-bridge-unavailable',
      recovery: 'runtime-reconnect',
      confidence: 'structured',
    })
  })

  it('treats the local LangGraph agent port as runtime bridge infrastructure', () => {
    expect(classifyAgentFailure({
      message: 'curl: (7) Failed to connect to localhost:3201 after 0 ms: Connection refused',
    })).toMatchObject({
      failureClass: 'execution-bridge-unavailable',
      recovery: 'runtime-reconnect',
    })
  })

  it('keeps an explicit fallback class for legacy unstructured errors', () => {
    expect(classifyAgentFailure({ message: 'unexpected provider response' })).toEqual({
      failureClass: 'unknown',
      retryability: 'conditional',
      recovery: 'browser-fallback',
      confidence: 'fallback',
    })
  })
})
