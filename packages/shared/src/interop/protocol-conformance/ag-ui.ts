import { isUnknownArray } from '../../utils/json.ts';
import { randomUUID } from "node:crypto";
import type { InteropConformanceCheck, InteropConformanceReport, InteropConformanceTransport } from './probe-types.ts';
import { authorizationHeaders, check, endpointUrl, parseSseEvents, recordValue, report, stringValue } from './probe-types.ts';

function validateAgUiSequence(events: Record<string, unknown>[], checks: InteropConformanceCheck[]): void {
  const types = events.map((event) => stringValue(event["type"])).filter((type): type is string => Boolean(type))
  check(checks, 'event stream', events.length > 0, 'SSE stream contains JSON events')
  check(checks, 'run start', types[0] === 'RUN_STARTED', 'first event is RUN_STARTED')
  check(
    checks,
    'run terminal',
    types.at(-1) === 'RUN_FINISHED' || types.at(-1) === 'RUN_ERROR',
    'last event is RUN_FINISHED or RUN_ERROR',
  )
  check(
    checks,
    'deprecated events',
    !types.some((type) => type.startsWith('THINKING_')),
    'stream does not use deprecated THINKING_* events',
  )

  const openMessages = new Set<string>()
  let validMessages = true
  let validStateDeltas = true
  for (const event of events) {
    const type = stringValue(event["type"])
    const messageId = stringValue(event["messageId"])
    if (type === 'TEXT_MESSAGE_START') {
      validMessages = validMessages && Boolean(messageId) && event["role"] === 'assistant'
      if (messageId) openMessages.add(messageId)
    }
    if (type === 'TEXT_MESSAGE_CONTENT') {
      validMessages = validMessages
        && Boolean(messageId && openMessages.has(messageId))
        && Boolean(stringValue(event["delta"]))
    }
    if (type === 'TEXT_MESSAGE_END') {
      validMessages = validMessages && Boolean(messageId && openMessages.delete(messageId))
    }
    if (type === 'STATE_DELTA') {
      const delta = event["delta"]
      validStateDeltas = validStateDeltas
        && isUnknownArray(delta)
        && delta.every((operation: unknown) => {
          const patch = recordValue(operation)
          return Boolean(
            patch
            && ['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(String(patch["op"]))
            && typeof patch["path"] === 'string',
          )
        })
    }
  }
  check(
    checks,
    'text message lifecycle',
    validMessages && openMessages.size === 0,
    'TEXT_MESSAGE_START/CONTENT/END events are balanced with non-empty deltas',
  )
  check(
    checks,
    'state delta',
    validStateDeltas,
    'STATE_DELTA events use RFC 6902 operation arrays',
  )
}

export async function runAgUiConformance(input: {
  endpoint: string
  authorization?: string
  transport: InteropConformanceTransport
  message?: string
  timeoutMs?: number
}): Promise<InteropConformanceReport> {
  const endpoint = endpointUrl(input.endpoint).toString()
  const timeoutMs = input.timeoutMs ?? 30_000
  const checks: InteropConformanceCheck[] = []
  try {
    const response = await input.transport({
      method: 'POST',
      url: endpoint,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...authorizationHeaders(input.authorization),
      },
      body: JSON.stringify({
        threadId: randomUUID(),
        runId: randomUUID(),
        state: {},
        messages: [{
          id: randomUUID(),
          role: 'user',
          content: input.message ?? 'Reply with the single word OK.',
        }],
        tools: [],
        context: [],
        forwardedProps: {
          conformanceProbe: true,
        },
      }),
      timeoutMs,
    })
    const contentType = response.headers['content-type'] ?? ''
    check(
      checks,
      'SSE response',
      response.status >= 200
        && response.status < 300
        && contentType.includes('text/event-stream'),
      'endpoint returns a successful text/event-stream response',
    )
    validateAgUiSequence(parseSseEvents(response.body), checks)
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }
  return report('ag-ui', endpoint, checks)
}

export const fetchInteropConformanceTransport: InteropConformanceTransport = async (request) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: controller.signal,
    })
    return {
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value]),
      ),
      body: await response.text(),
    }
  } finally {
    clearTimeout(timeout)
  }
}
