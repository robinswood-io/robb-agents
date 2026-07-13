import { describe, expect, it } from 'bun:test'
import { redactDiagnosticText } from '../diagnostics.ts'

describe('redactDiagnosticText', () => {
  it('removes common API and OAuth credential forms while retaining diagnostic context', () => {
    const input = [
      '401 Authorization: Bearer very-secret-token-value',
      'access_token=oauth-secret-value',
      'api_key: sk_1234567890abcdef',
      'credential=op://Robb/Production/token',
    ].join('; ')

    const redacted = redactDiagnosticText(input)

    expect(redacted).toContain('401 Authorization: Bearer [REDACTED]')
    expect(redacted).toContain('access_token=[REDACTED]')
    expect(redacted).toContain('api_key: [REDACTED]')
    expect(redacted).not.toContain('very-secret-token-value')
    expect(redacted).not.toContain('oauth-secret-value')
    expect(redacted).not.toContain('sk_1234567890abcdef')
    expect(redacted).not.toContain('op://Robb/Production/token')
  })

  it('redacts URL user-info without removing the endpoint', () => {
    expect(redactDiagnosticText('Fetch failed for https://user:password@example.test/v1/models'))
      .toBe('Fetch failed for https://[REDACTED]@example.test/v1/models')
  })
})
