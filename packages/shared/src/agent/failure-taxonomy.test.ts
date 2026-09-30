import { describe, expect, it } from 'bun:test'
import { decideAutonomyRecovery } from './autonomy-decision.ts'
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

  it('recognizes subscription usage exhaustion as provider-fallback eligible', () => {
    expect(classifyAgentFailure({
      message: 'Codex error: The usage limit has been reached',
    })).toMatchObject({
      failureClass: 'rate-limited',
      retryability: 'safe',
      recovery: 'provider-fallback',
    })
  })

  it('recognizes provider-specific unusable quota messages as fallback eligible', () => {
    expect(classifyAgentFailure({
      message: 'This Google account does not currently have usable Antigravity quota.',
    })).toMatchObject({
      failureClass: 'rate-limited',
      retryability: 'safe',
      recovery: 'provider-fallback',
    })
  })

  it('distinguishes interactive authentication from missing credentials', () => {
    expect(classifyAgentFailure({ message: 'OAuth requires MFA' }).failureClass)
      .toBe('interactive-auth-required')
    expect(classifyAgentFailure({ message: 'Unauthorized: API key missing' }).failureClass)
      .toBe('credential-required')
    expect(classifyAgentFailure({ message: 'OAuth access token expired' }).failureClass)
      .toBe('credential-required')
    expect(classifyAgentFailure({
      message: 'Microsoft sign-in is not completed yet.',
      code: 'authorization_pending',
    }).failureClass).toBe('interactive-auth-required')
    expect(classifyAgentFailure({ message: 'Entrez le mot de passe' }).failureClass)
      .toBe('credential-required')
  })

  it('recognizes connector machine codes for missing key credentials', () => {
    for (const message of [
      'guardtek_analytics_api_key_missing',
      '{"ok":false,"error":"license-key-required"}',
      'access_token_absent',
      'clé API manquante',
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
      'api_key_not_found',
      'API key not found',
      'license_key_not_found',
      'Access token not found',
      'API key unset',
      'license_key_unset',
      'Access token unset',
      'API key must be set',
      'License key needs to be set',
      'Access token must be set',
    ]) {
      expect(classifyAgentFailure({ message })).toMatchObject({
        failureClass: 'credential-required',
        retryability: 'never',
        recovery: 'request-authentication',
      })
    }
    expect(classifyAgentFailure({
      message: 'Documentation for rotating an API key',
    }).failureClass).not.toBe('credential-required')
    for (const message of [
      'Documentation: API key must be set before using the SDK',
      'Guide to the access_token_not_found response',
      'Example showing a license key unset status',
      'API key authentication succeeded; no matching records were found.',
      'The API key is valid, but the requested record is missing.',
      'Access token accepted. No results match the query.',
      'No API key is required for this endpoint; the request failed validation.',
      'This endpoint requires no API key; the supplied input is invalid.',
      'This endpoint does not require an access token; the supplied input is invalid.',
      'Aucune clé API n’est nécessaire; la requête est invalide.',
      'La clé de licence n’est pas requise; la requête est invalide.',
    ]) {
      expect(classifyAgentFailure({ message }).failureClass).not.toBe('credential-required')
    }

    expect(classifyAgentFailure({
      message: 'No API key is required for this endpoint; access token missing.',
    }).failureClass).toBe('credential-required')
  })

  it('escalates the new missing-key forms without wasting a browser fallback', () => {
    for (const result of [
      'api_key_not_found',
      'License key unset',
      'Access token needs to be set',
    ]) {
      expect(decideAutonomyRecovery({
        toolName: 'mcp__crm__lookup',
        result,
        browserEnabled: true,
        fallbackAlreadyAttempted: false,
      })).toEqual({ kind: 'escalate', reason: 'credential_required' })
    }
  })

  it('requires an actual generic credential or password failure signal', () => {
    for (const message of [
      'Credentials missing',
      'credential_required',
      'password_missing',
      'Invalid credentials',
      'The credentials could not be retrieved',
      'No credentials are available',
      'Password required',
      'Enter the password',
      'Wrong password',
      'Password must be set',
      'Entrez le mot de passe',
      'Mot de passe incorrect',
      'Authenticate the source to test with credentials',
      'Re-authenticate to refresh credentials',
    ]) {
      expect(classifyAgentFailure({ message })).toMatchObject({
        failureClass: 'credential-required',
        retryability: 'never',
        recovery: 'request-authentication',
      })
    }

    for (const message of [
      'No credentials are required for this endpoint; the service is unavailable.',
      'This endpoint requires no password; the service is unavailable.',
      'Credentials are optional; the service is unavailable.',
      'Documentation: credentials are not required.',
      'Documentation: password required is an example response.',
      'The credential helper is installed successfully.',
      'Password updated successfully; retry is required.',
      'The password helper succeeded. A required field is missing from the response.',
      'Credentials validated successfully. The service is unavailable and retry is required.',
      'The password is valid; a required account field is missing.',
      'Aucun mot de passe n’est nécessaire; le service est indisponible.',
      'Les identifiants ne sont pas requis; le service est indisponible.',
    ]) {
      expect(classifyAgentFailure({ message }).failureClass).not.toBe('credential-required')
    }

    expect(classifyAgentFailure({
      message: 'No credentials are required for this endpoint; the access token is expired.',
    }).failureClass).toBe('credential-required')
  })

  it('recognizes host permission-mode and evidence gates as policy denials', () => {
    for (const message of [
      'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
      'Bash blocked (Explore mode) - target not in allowed folders.',
      'High-stakes evidence gate: inspect a current authoritative source before changing the deliverable.',
    ]) {
      expect(classifyAgentFailure({ message })).toMatchObject({
        failureClass: 'sandbox-denied',
        retryability: 'never',
        recovery: 'request-authorization',
      })
    }
  })

  it('keeps live Objective authority refusals at the original tool boundary', () => {
    const liveRefusal = 'Objective authority: the current accepted human objective does not explicitly authorize this sensitive external action and its exact target. Continue only with the authorized local work or target; do not request broader permission or treat this as a policy blocker.'

    for (const refusal of [
      liveRefusal,
      `[ERROR]: ${liveRefusal}`,
      `Error: ${liveRefusal}`,
      `Tool execution failed: ${liveRefusal}`,
      `MCP error: ${liveRefusal}`,
      `[ERROR] Tool execution failed: ${liveRefusal}`,
      `Error: MCP error: ${liveRefusal}`,
      JSON.stringify({ error: liveRefusal }),
      JSON.stringify({ message: liveRefusal }),
      JSON.stringify({ error: { message: liveRefusal } }),
      JSON.stringify({ error: `Error: ${liveRefusal}` }),
      JSON.stringify({ message: `[ERROR] MCP error: ${liveRefusal}` }),
      JSON.stringify({
        error: liveRefusal,
        code: 'OBJECTIVE_AUTHORITY',
        name: 'ToolExecutionError',
        status: 400,
        success: false,
      }),
      JSON.stringify({ error: liveRefusal, status: '403', success: false }),
    ]) {
      expect(classifyAgentFailure({ message: refusal })).toMatchObject({
        failureClass: 'invalid-input',
        retryability: 'never',
        recovery: 'fix-input',
        confidence: 'heuristic',
      })

      for (const toolName of ['mcp__rbw-servers__ssh_execute', 'mcp__session__browser_tool']) {
        expect(decideAutonomyRecovery({
          toolName,
          result: refusal,
          browserEnabled: true,
          fallbackAlreadyAttempted: false,
          browserFallbackEligible: true,
        })).toEqual({ kind: 'none' })
      }
    }
  })

  it('does not infer a host authority refusal from arbitrary quoted content', () => {
    const quoted = 'Objective authority: quoted text from an external page.'
    for (const message of [
      `Documentation excerpt: ${quoted}`,
      `The remote response says Error: ${quoted}`,
      JSON.stringify({ data: 'external response', error: quoted }),
      JSON.stringify({ error: `A remote page says ${quoted}` }),
      JSON.stringify({ error: quoted, status: 200, success: true }),
      JSON.stringify({ error: quoted, code: { source: 'external page' } }),
      JSON.stringify({ message: quoted, context: 'external page' }),
      JSON.stringify({ message: { message: quoted } }),
      JSON.stringify({ error: { message: quoted, source: 'external page' } }),
      JSON.stringify({ error: quoted, message: quoted }),
      JSON.stringify({ error: quoted, status: '200', success: false }),
      `Error: [ERROR] MCP error: ${quoted}`,
    ]) {
      expect(classifyAgentFailure({ message }).failureClass).not.toBe('invalid-input')
    }
  })

  it('treats recoverable Objective authority command-shape diagnostics as input repair', () => {
    expect(classifyAgentFailure({
      message: '[ERROR] Objective authority could not prove this composite remote command read-only because its loop or compound shell shape leaves the effective scope unresolved; this is a recoverable command-shape issue, not a request for broader user permission.',
    })).toMatchObject({
      failureClass: 'invalid-input',
      recovery: 'fix-input',
    })
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

  it('keeps SSH ENOBUFS on a narrower structured path instead of opening a browser', () => {
    const message = 'MCP tool "oss_read_file" failed: remote command failed: spawnSync ssh ENOBUFS'
    expect(classifyAgentFailure({ message })).toMatchObject({
      failureClass: 'resource-exhausted',
      retryability: 'conditional',
      recovery: 'fix-input',
      confidence: 'heuristic',
    })
    expect(classifyAgentFailure({ message: 'remote command failed', code: 'ENOBUFS' })).toMatchObject({
      failureClass: 'resource-exhausted',
      recovery: 'fix-input',
      confidence: 'structured',
    })
    expect(decideAutonomyRecovery({
      toolName: 'mcp__rbw-agents-oss__oss_read_file',
      result: message,
      browserEnabled: true,
      fallbackAlreadyAttempted: false,
      browserFallbackEligible: true,
    })).toEqual({ kind: 'none' })
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
