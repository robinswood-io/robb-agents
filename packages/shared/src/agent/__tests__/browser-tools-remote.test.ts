/** Pi browser errors expose useful messages for the caller. */

import { describe, it, expect } from 'bun:test'
import { mapBrowserToolErrorCode } from '../pi-agent/shared.ts'
import { CodedError } from '../../protocol/types.ts'

const EXPECTED: Record<string, string> = {
  BROWSER_NO_CAPABLE_CLIENT: 'No connected desktop client',
  CAPABILITY_UNAVAILABLE: 'No connected desktop client',
  CLIENT_DISCONNECTED: 'disconnected',
  CLIENT_REQUEST_TIMEOUT: 'timed out',
  // Substring intentionally avoids the apostrophe so the contract test
  // doesn't have to mirror source-level escaping.
  BROWSER_INSTANCE_NOT_OWNED: 'belong to this session',
  BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED: 'File upload from a remote agent',
  BROWSER_REMOTE_EVALUATE_BLOCKED: 'JavaScript evaluation is disabled',
}

describe('pi-agent browser_tool error mapping (contract)', () => {
  for (const [code, expectedFragment] of Object.entries(EXPECTED)) {
    it(`maps ${code} to a friendly agent message`, () => {
      const message = mapBrowserToolErrorCode(code)
      expect(typeof message).toBe('string')
      expect(message).toContain(expectedFragment)
    })
  }

  it('CodedError carries the right code', () => {
    const err = new CodedError('BROWSER_NO_CAPABLE_CLIENT', 'no client')
    expect(err.code).toBe('BROWSER_NO_CAPABLE_CLIENT')
    expect(err.message).toBe('no client')
    expect(err).toBeInstanceOf(Error)
  })
})
