import { describe, expect, it } from 'bun:test'
import { decideAutonomyRecovery, formatAutonomyContract } from './autonomy-decision.ts'

const sourceFailure = { toolName: 'mcp__crm__lookup', result: 'HTTP 503 service unavailable', browserEnabled: true, fallbackAlreadyAttempted: false }

describe('decideAutonomyRecovery', () => {
  it('uses the browser as the first safe alternative for a source failure', () => {
    expect(decideAutonomyRecovery(sourceFailure)).toEqual({ kind: 'fallback_browser' })
  })

  it('escalates OAuth and MFA without trying the browser', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, result: 'OAuth token expired; MFA required' }))
      .toEqual({ kind: 'escalate', reason: 'oauth_or_mfa' })
  })

  it('escalates missing credentials without trying the browser', () => {
    for (const result of [
      'Unauthorized: API key is required',
      'Please provide your API key',
      'Set your API key to continue',
      'API key needed',
      'Please provide your license key',
      'Set your access token to continue',
      'License key needed',
      'Access token needed',
      'Veuillez fournir votre clé API',
      'Renseignez votre jeton d’accès pour continuer',
      'Clé de licence nécessaire',
    ]) {
      expect(decideAutonomyRecovery({ ...sourceFailure, result }))
        .toEqual({ kind: 'escalate', reason: 'credential_required' })
    }
  })

  it('keeps the safe fallback for optional or documentary credential prose', () => {
    for (const result of [
      'No credentials are required for this endpoint; the service is unavailable.',
      'Credentials are optional; the service is unavailable.',
      'Documentation: password required is an example response.',
      'The credential helper is installed successfully.',
      'Password updated successfully; retry is required.',
      'Credentials validated successfully. The service is unavailable and retry is required.',
      'API key authentication succeeded; no matching records were found.',
      'The API key is valid, but the requested record is missing.',
      'Access token accepted. No results match the query.',
    ]) {
      expect(decideAutonomyRecovery({ ...sourceFailure, result }))
        .toEqual({ kind: 'fallback_browser' })
    }
  })

  it('does not loop after a browser fallback was attempted', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, fallbackAlreadyAttempted: true })).toEqual({ kind: 'none' })
  })

  it('switches a first browser failure to a structured access path', () => {
    expect(decideAutonomyRecovery({ ...sourceFailure, toolName: 'mcp__session__browser_tool' }))
      .toEqual({ kind: 'fallback_structured' })
  })

  it.each([
    ['browser_open', 'UI navigation failed'],
    ['mcp__session__browser_click_at', 'UI target was obscured'],
    ['mcp__session__browser_snapshot', 'UI snapshot could not be captured'],
  ])('normalizes browser alias %s and falls back to structured access on UI errors', (toolName, result) => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      toolName,
      result,
    })).toEqual({ kind: 'fallback_structured' })
  })

  it('escalates only after the structured fallback also failed', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      toolName: 'mcp__session__browser_tool',
      fallbackAlreadyAttempted: true,
    })).toEqual({ kind: 'escalate', reason: 'access_unavailable_after_fallback' })
  })

  it('uses structured provider status before legacy text parsing', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      result: 'generic failure',
      httpStatus: 401,
    })).toEqual({ kind: 'escalate', reason: 'credential_required' })
  })

  it('requests runtime reconnect for execution bridge failures', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      result: 'Execution bridge unavailable: handler timeout',
    })).toEqual({ kind: 'reconnect_runtime' })
  })

  it('does not waste a browser fallback on invalid input', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      result: 'generic failure',
      errorCode: 'INVALID_ARGUMENT',
    })).toEqual({ kind: 'none' })
  })

  it('treats contextual Gmail reply guidance as input repair, never a browser fallback', () => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      toolName: 'mcp__google-contacts__gmail_send',
      result: 'Validation failed: the accepted objective requires a contextual reply-all preserving the thread recipients. Run mcp__google-contacts__gmail_reply_all_preflight, then use mcp__google-contacts__gmail_reply_all with its recipientBinding. Do not use a browser fallback.',
      browserFallbackEligible: true,
    })).toEqual({ kind: 'none' })
  })

  it.each([
    ['INVALID_ARGUMENT', 'generic failure'],
    ['PERMISSION_DENIED', 'generic failure'],
  ])('does not escalate %s merely because browser access is disabled', (errorCode, result) => {
    expect(decideAutonomyRecovery({
      ...sourceFailure,
      browserEnabled: false,
      errorCode,
      result,
    })).toEqual({ kind: 'none' })
  })

  it('does not turn a local shell or filesystem failure into a browser turn', () => {
    expect(decideAutonomyRecovery({
      toolName: 'Bash',
      result: 'command failed with exit code 1',
      browserEnabled: true,
      fallbackAlreadyAttempted: false,
      browserFallbackEligible: false,
    })).toEqual({ kind: 'none' })
  })
})

describe('formatAutonomyContract sensitive external action guard', () => {
  const contract = formatAutonomyContract()

  it('keeps permission modes separate from task-level authorization', () => {
    expect(contract).toContain('Apply safe, ask, and allow-all exactly as configured')
    expect(contract).toContain('No permission mode expands the task scope or supplies business authorization')
  })

  it('covers the observed sensitive external action categories', () => {
    expect(contract).toContain('secret or credential disclosure or transfer')
    expect(contract).toContain('git push or deployment')
    expect(contract).toContain('service restart')
    expect(contract).toContain('payment or financial submission')
    expect(contract).toContain('publication or sending to an external audience')
  })

  it('keeps connector output failures on a structured recovery path', () => {
    expect(contract).toContain('including ENOBUFS or maxBuffer')
    expect(contract).toContain('Never invent a raw host URL or browser route')
  })

  it('rejects ambiguous continuation without re-prompting explicit requests', () => {
    expect(contract).toContain('A generic continuation such as "continue", "proceed", or "poursuis" does not authorize')
    expect(contract).toContain('when the current request is already explicit, do not ask again')
    expect(contract).toContain('A conversational correction or status observation')
    expect(contract).toContain('does not authorize sending, deleting, deploying, or changing external state')
  })

  it('uses thread-bound replies and does not re-ask an established third-party wait', () => {
    expect(contract).toContain('use the connector\'s thread-bound reply operation')
    expect(contract).toContain('Do not convert that instruction into a new send with model-supplied recipients')
    expect(contract).toContain('pending from an identified third party')
    expect(contract).toContain('do not ask the user to choose the same wait state again')
    expect(contract).toContain('Finish every independent safe step')
  })

  it('preserves safe and reversible local work without extra confirmation', () => {
    expect(contract).toContain('Continue safe, reversible local edits and local verification without extra confirmation')
  })

  it('sets a compact phase budget and preserves mutation verification', () => {
    expect(contract).toContain('target 3-5 calls total')
    expect(contract).toContain('Batch independent searches and reads')
    expect(contract).toContain('reserve enough tool budget for verification and cleanup')
    expect(contract).toContain('provider quota, rate limit')
    expect(contract).toContain('A technical obstacle is a diagnosis checkpoint')
    expect(contract).toContain('Do not defer an identified next correction')
    expect(contract).toContain('Operate like a senior owner')
    expect(contract).toContain('For RDP, Guacamole, VNC')
    expect(contract).toContain('switch to the structured route')
  })

  it('keeps an explicit structured access-channel correction binding', () => {
    expect(contract).toContain('Treat an explicit user access-channel correction as binding')
    expect(contract).toContain('do not use browser automation for equivalent operational reads or writes')
    expect(contract).toContain('immediately return to the specified structured channel afterwards')
  })

  it('does not reinterpret host build provenance as a target revision', () => {
    expect(contract).toContain('buildCommit, routingMeta, or a local staging label')
    expect(contract).toContain('Robb Agents runtime only')
    expect(contract).toContain('Never infer that such an identifier is the target project revision')
    expect(contract).toContain('explicit target-bound evidence')
  })

  it('aligns the model with the explicit total-autonomy workspace policy', () => {
    const executeContract = formatAutonomyContract('allow-in-execute')
    expect(executeContract).toContain('standing authorization for in-scope sensitive external actions')
    expect(executeContract).toContain('do not request an additional confirmation solely because an action is sensitive')
    expect(executeContract).toContain('Ask and Safe remain confirmation-bound')
    expect(executeContract).not.toContain('No permission mode expands the task scope or supplies business authorization')
  })
})
