import { isUnknownArray } from '../../utils/json.ts';
import { parseCapabilityOperationRequest, parseOperationCapability } from "../../governance/capability-broker";
import type { ConnectorCapabilityAuthorization, ConnectorHttpRequest, InvocationEnvelope } from './contracts.ts';
import { ConnectorDriverError } from './contracts.ts';

export function readInvocationEnvelope(input: Record<string, unknown>): InvocationEnvelope {
  const rawPayload = input["payload"]
  const payload = rawPayload && typeof rawPayload === 'object' && !isUnknownArray(rawPayload)
    ? { ...rawPayload } as Record<string, unknown>
    : {}
  const resourceId = typeof input["resourceId"] === 'string' && input["resourceId"].trim()
    ? input["resourceId"].trim()
    : undefined
  const idempotencyKey = typeof input["idempotencyKey"] === 'string' && input["idempotencyKey"].trim()
    ? input["idempotencyKey"].trim()
    : undefined
  const rawAuthorization = input["authorization"]
  let authorization: ConnectorCapabilityAuthorization | undefined
  if (rawAuthorization && typeof rawAuthorization === 'object' && !isUnknownArray(rawAuthorization)) {
    try {
      authorization = {
        request: parseCapabilityOperationRequest(Reflect.get(rawAuthorization, 'request')),
        capability: parseOperationCapability(Reflect.get(rawAuthorization, 'capability')),
      }
    } catch {
      authorization = undefined
    }
  }
  return { payload, ...(resourceId !== undefined ? { resourceId } : {}), ...(idempotencyKey !== undefined ? { idempotencyKey } : {}), ...(authorization !== undefined ? { authorization } : {}) }
}

/**
 * Materialize the exact structured value released to the HTTP transport.
 * GET has no JSON body in this driver, so only one scalar per query key is
 * representable. Values are canonicalized to their wire strings before
 * authorization and receipting; arrays, objects, nulls and non-finite numbers
 * fail closed instead of being silently omitted from the request URL.
 */
export function materializeConnectorHttpPayload(
  method: ConnectorHttpRequest['method'],
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (method !== 'GET') return structuredClone(payload)
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(payload)) {
    if (
      typeof value !== 'string'
      && typeof value !== 'boolean'
      && !(typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new ConnectorDriverError(
        'INVALID_INPUT',
        `GET connector query field "${key}" is not representable as one scalar value`,
      )
    }
    entries.push([key, String(value)])
  }
  return Object.fromEntries(entries)
}

export function renderPath(path: string, resourceId?: string): string {
  if (!path.includes(':resourceId')) return path
  if (!resourceId) {
    throw new ConnectorDriverError('INVALID_INPUT', 'resourceId is required for this connector operation')
  }
  return path.replace(':resourceId', encodeURIComponent(resourceId))
}
