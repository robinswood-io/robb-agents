import { describe, expect, it } from 'bun:test'
import { parseError } from '../errors.ts'

describe('parseError proxy interception handling', () => {
  it('maps interceptor proxy marker message to proxy_error', () => {
    const message = 'Received an unexpected HTML error page (HTTP 400) instead of a JSON API response. This may be caused by your network proxy (http://example.com:8080). Check your proxy settings in Settings > Network.'
    const parsed = parseError(new Error(message))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toBe(message)
  })

  it('maps raw Cloudflare HTML error page to proxy_error with sanitized message', () => {
    const rawHtml = `<html>
<head><title>400 Bad Request</title></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`

    const parsed = parseError(new Error(rawHtml))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toContain('unexpected HTML error page')
    expect(parsed.message).toContain('HTTP 400')
    expect(parsed.message.toLowerCase()).toContain('proxy settings')
    expect(parsed.message.toLowerCase()).not.toContain('<html')
    expect(parsed.originalError).toBe(rawHtml)
  })

  it('does not remap regular 401 auth errors as proxy_error', () => {
    const parsed = parseError(new Error('401 Unauthorized'))

    expect(parsed.code).toBe('invalid_api_key')
  })
})

describe('parseError tool-support classification', () => {
  // Regression for the misclassification in the screenshot: an Anthropic
  // cache_control TTL ordering error mentioning `tools` in its hint string
  // was being labeled "Model Does Not Support Tools". It's an invalid_request,
  // not a tool-support refusal.
  const CACHE_CONTROL_ORDERING_ERROR =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control.ttl: ' +
    'a ttl=\'1h\' cache_control block must not come after a ttl=\'5m\' cache_control block. ' +
    'Note that blocks are processed in the following order: `tools`, `system`, `messages`."}}'

  it('does NOT classify cache_control TTL ordering errors as model_no_tool_support', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).not.toBe('model_no_tool_support')
  })

  it('classifies cache_control TTL ordering errors as invalid_request', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).toBe('invalid_request')
  })

  it('still classifies explicit tool-support refusals as model_no_tool_support', () => {
    const cases = [
      'No endpoints found that support tool use for this model',
      'The model gpt-3.5-turbo-instruct does not support tools',
      'tool_use is not supported by this model',
      'function calling not available on this endpoint',
    ]
    for (const message of cases) {
      const parsed = parseError(new Error(message))
      expect(parsed.code).toBe('model_no_tool_support')
    }
  })
})

describe('parseError runtime bridge classification', () => {
  it('maps local execution bridge failures to an actionable runtime reconnect error', () => {
    const parsed = parseError(new Error('Execution bridge unavailable: handler timeout while dispatching exec_command'))

    expect(parsed.code).toBe('execution_bridge_unavailable')
    expect(parsed.canRetry).toBe(true)
    expect(parsed.actions.some(action => action.action === 'reconnect_runtime')).toBe(true)
  })

  it('maps the local LangGraph agent port failure to runtime reconnect', () => {
    const parsed = parseError(new Error('curl: (7) Failed to connect to localhost:3201 after 0 ms: Connection refused'))

    expect(parsed.code).toBe('execution_bridge_unavailable')
  })

  it('does not classify generic bridge-adjacent words as runtime bridge failures', () => {
    expect(parseError(new Error('empty query')).code).not.toBe('execution_bridge_unavailable')
    expect(parseError(new Error('handler timeout')).code).not.toBe('execution_bridge_unavailable')
    expect(parseError(new Error('rpc handler failed')).code).not.toBe('execution_bridge_unavailable')
  })
})
