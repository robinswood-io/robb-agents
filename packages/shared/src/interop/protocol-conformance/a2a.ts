import { randomUUID } from "node:crypto";
import type { InteropConformanceCheck, InteropConformanceReport, InteropConformanceTransport } from './probe-types.ts';
import { A2A_PROTOCOL_VERSION, authorizationHeaders, check, endpointUrl, parseJsonOrSse, recordValue, report, stringValue } from './probe-types.ts';

const a2aTaskStates = new Set([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
])

function a2aTask(value: unknown): Record<string, unknown> | null {
  const candidate = recordValue(value)
  const status = recordValue(candidate?.status)
  return candidate
    && stringValue(candidate.id)
    && stringValue(status?.state)
    && a2aTaskStates.has(String(status?.state))
    ? candidate
    : null
}

export async function runA2AConformance(input: {
  baseUrl: string
  authorization?: string
  transport: InteropConformanceTransport
  message?: string
  timeoutMs?: number
}): Promise<InteropConformanceReport> {
  const base = endpointUrl(input.baseUrl)
  const timeoutMs = input.timeoutMs ?? 15_000
  const checks: InteropConformanceCheck[] = []
  const headers = {
    Accept: 'application/a2a+json, application/json',
    'A2A-Version': A2A_PROTOCOL_VERSION,
    ...authorizationHeaders(input.authorization),
  }
  try {
    const cardUrl = new URL('/.well-known/agent-card.json', base).toString()
    const cardResponse = await input.transport({
      method: 'GET',
      url: cardUrl,
      headers,
      timeoutMs,
    })
    const card = recordValue(parseJsonOrSse(cardResponse.body))
    check(
      checks,
      'agent card',
      cardResponse.status >= 200 && cardResponse.status < 300 && Boolean(stringValue(card?.name)),
      'well-known endpoint returns a named Agent Card',
    )
    const interfaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : []
    const preferred = recordValue(interfaces[0])
    check(
      checks,
      'supported interface',
      preferred?.protocolBinding === 'HTTP+JSON'
        && preferred?.protocolVersion === A2A_PROTOCOL_VERSION
        && Boolean(stringValue(preferred?.url)),
      'preferred interface declares HTTP+JSON version 1.0 and its URL',
    )
    check(
      checks,
      'security declaration',
      Boolean(recordValue(card?.securitySchemes)),
      'Agent Card declares its security schemes without credentials',
    )

    if (input.message) {
      const preferredUrl = stringValue(preferred?.url)
      const serviceBase = endpointUrl(preferredUrl ?? base.toString())
      const sendUrl = new URL(`${serviceBase.pathname.replace(/\/+$/u, '')}/message:send`, serviceBase)
      const response = await input.transport({
        method: 'POST',
        url: sendUrl.toString(),
        headers: {
          ...headers,
          'Content-Type': 'application/a2a+json',
        },
        body: JSON.stringify({
          message: {
            messageId: randomUUID(),
            role: 'ROLE_USER',
            parts: [{ text: input.message }],
          },
          configuration: {
            acceptedOutputModes: ['text/plain', 'application/json'],
          },
        }),
        timeoutMs,
      })
      const sendResult = recordValue(parseJsonOrSse(response.body))
      const task = a2aTask(sendResult?.task ?? sendResult)
      const message = recordValue(sendResult?.message ?? sendResult)
      check(
        checks,
        'message:send',
        response.status >= 200
          && response.status < 300
          && Boolean(task || stringValue(message?.messageId)),
        'message:send returns a valid task or message',
      )
      if (task) {
        const taskId = stringValue(task.id)
        if (taskId) {
          const taskUrl = new URL(`${serviceBase.pathname.replace(/\/+$/u, '')}/tasks/${encodeURIComponent(taskId)}`, serviceBase)
          const taskResponse = await input.transport({
            method: 'GET',
            url: taskUrl.toString(),
            headers,
            timeoutMs,
          })
          check(
            checks,
            'tasks/{id}',
            taskResponse.status >= 200
              && taskResponse.status < 300
              && Boolean(a2aTask(parseJsonOrSse(taskResponse.body))),
            'task status is retrievable using the versioned REST binding',
          )
        }
      }
    }
  } catch (error) {
    check(checks, 'transport', false, error instanceof Error ? error.message : String(error))
  }
  return report('a2a', base.toString(), checks)
}
