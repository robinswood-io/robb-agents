import { omitUndefined } from '@craft-agent/shared/utils/json';
import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { activeAuthorizationExpiry, messages, objective, receipt } from "./testing/objective-outcome-fixture.ts";

describe('objective outcome receipt', () => {

  it('accepts an exact host policy denial and retires it after the same request succeeds', () => {
    const denied: Message = {
      id: 'explore-denied', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__ops__ssh_execute', toolUseId: 'explore-call', toolStatus: 'error',
      toolExecuted: true, isError: true, toolInput: { server: 'dev', command: 'bun test' },
      toolResult: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: [],
      blocker: { kind: 'policy', description: 'Explore blocks the required invocation', evidence: ['tool:mcp__ops__ssh_execute'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied] }).state)
      .toBe('blocked_policy');

    const resolved: Message = {
      ...denied, id: 'explore-resolved', toolUseId: 'explore-resolved-call', timestamp: 5,
      toolStatus: 'completed', isError: false, toolResult: '{"ok":true}',
    };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, denied, resolved] }).state)
      .toBe('continue');
  });

  it('never promotes internal acceptance-contract refusals to terminal policy blockers', () => {
    const immutable: Message = {
      id: 'immutable-contract', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__session__set_completion_criteria', toolUseId: 'immutable-contract-call',
      toolStatus: 'error', toolExecuted: true, isError: true,
      toolInput: { criteria: [] },
      toolResult: '[ERROR] The host rejected these criteria: Registered criteria cannot be weakened or replaced.',
    };
    const blocked = receipt({
      state: 'blocked_policy', criteria: [], remainingWork: [],
      blocker: { kind: 'policy', description: 'The immutable host contract cannot be replaced',
        evidence: ['immutable-contract-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, immutable] }).state)
      .toBe('continue');

    const repairable = { ...immutable, id: 'repairable-contract', toolUseId: 'repairable-contract-call',
      toolResult: '[ERROR] Invalid set_completion_criteria arguments: Unsupported fields.' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, repairable] }).state)
      .toBe('continue');
  });

  it('accepts completed transport receipts that explicitly report pending human authorization', () => {
    const pending: Message = {
      id: 'device-pending', role: 'tool', content: '', timestamp: 4,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'device-pending-call',
      toolStatus: 'completed', toolExecuted: true, isError: false, toolInput: { requestId: 'auth-1' },
      toolResult: JSON.stringify({ ok: false, pending: true, error: 'authorization_pending',
        message: 'Microsoft sign-in is not completed yet.' }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['device-pending-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, pending] }).state)
      .toBe('blocked_human');

    const machineOnlyPending: Message = {
      ...pending, id: 'machine-only-device-pending', toolUseId: 'machine-only-device-pending-call',
      toolResult: JSON.stringify({ pending: true }),
    };
    const machineOnlyBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['machine-only-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(machineOnlyBlocked, {
      objective, messages: [...messages, machineOnlyPending],
    }).state).toBe('blocked_human');

    for (const [label, toolResult] of [
      ['status', { status: 'authorization_pending' }],
      ['state', { state: 'pending' }],
      ['error', { error: 'authorization_pending' }],
      ['code', { code: 'authentication_pending' }],
      ['negative-transport', { ok: false, error: 'authorization_pending' }],
    ] as const) {
      const statePending: Message = {
        ...pending,
        id: `${label}-device-pending`,
        toolUseId: `${label}-device-pending-call`,
        toolResult: JSON.stringify(toolResult),
      };
      const stateBlocked = receipt({
        state: 'blocked_human', criteria: [], remainingWork: [],
        blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
          evidence: [statePending.toolUseId!] },
      });
      expect(validateObjectiveOutcome(stateBlocked, {
        objective, messages: [...messages, statePending],
      }).state).toBe('blocked_human');
    }

    for (const [label, toolResult] of [
      ['false-pending', { pending: false, status: 'authorization_pending' }],
      ['success-status', { pending: true, status: 'authorized' }],
      ['success-state', { pending: true, state: 'completed' }],
      ['mixed-state-error', { status: 'authorized', error: 'authorization_pending' }],
      ['fatal-error', { pending: true, error: 'fatal auth failure' }],
      ['boolean-success', { pending: true, success: true }],
      ['contradictory-booleans', { pending: true, ok: true, success: false }],
    ] as const) {
      const contradictory: Message = {
        ...pending,
        id: `${label}-device-poll`,
        toolUseId: `${label}-device-poll-call`,
        toolResult: JSON.stringify(toolResult),
      };
      const contradictoryBlocked = receipt({
        state: 'blocked_human', criteria: [], remainingWork: [],
        blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
          evidence: [contradictory.toolUseId!] },
      });
      expect(validateObjectiveOutcome(contradictoryBlocked, {
        objective, messages: [...messages, contradictory],
      }).state).toBe('continue');
    }

    const statusPending: Message = {
      ...pending,
      id: 'status-cycle-device-pending',
      toolUseId: 'status-cycle-device-pending-call',
      toolResult: JSON.stringify({ status: 'authorization_pending' }),
    };
    const statusBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: [statusPending.toolUseId!] },
    });
    const statusCompleted: Message = {
      ...statusPending,
      id: 'status-cycle-device-completed',
      toolUseId: 'status-cycle-device-completed-call',
      timestamp: 5,
      toolResult: JSON.stringify({ status: 'authorized' }),
    };
    expect(validateObjectiveOutcome(statusBlocked, {
      objective,
      messages: [...messages, statusPending, {
        ...statusCompleted,
        id: 'other-status-cycle-device-completed',
        toolUseId: 'other-status-cycle-device-completed-call',
        toolInput: { requestId: 'auth-2' },
      }],
    }).state).toBe('blocked_human');
    expect(validateObjectiveOutcome(statusBlocked, {
      objective, messages: [...messages, statusPending, statusCompleted],
    }).state).toBe('continue');

    const unboundPending = {
      ...machineOnlyPending,
      id: 'unbound-device-pending',
      toolUseId: 'unbound-device-pending-call',
      toolInput: {},
    };
    const unboundBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['unbound-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(unboundBlocked, {
      objective, messages: [...messages, unboundPending],
    }).state).toBe('continue');
    const unboundVerbosePending = {
      ...unboundPending,
      id: 'unbound-verbose-device-pending',
      toolUseId: 'unbound-verbose-device-pending-call',
      toolResult: JSON.stringify({
        ok: false,
        error: 'authorization_pending',
        message: 'authorization pending',
      }),
    };
    const unboundVerboseBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Interactive authorization is pending',
        evidence: ['unbound-verbose-device-pending-call'] },
    });
    expect(validateObjectiveOutcome(unboundVerboseBlocked, {
      objective, messages: [...messages, unboundVerbosePending],
    }).state).toBe('continue');

    const completed: Message = {
      ...pending, id: 'device-completed', toolUseId: 'device-completed-call', timestamp: 5,
      toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    for (const [index, toolResult] of [{}, { ok: true }, { status: 'pending' }].entries()) {
      expect(validateObjectiveOutcome(blocked, {
        objective,
        messages: [...messages, pending, {
          ...completed,
          id: `ambiguous-device-completed-${index}`,
          toolUseId: `ambiguous-device-completed-call-${index}`,
          toolResult: JSON.stringify(toolResult),
        }],
      }).state).toBe('blocked_human');
    }
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, pending, completed] }).state)
      .toBe('continue');
  });

  it('accepts a strict successful device-code start receipt as pending external authorization', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'device-started', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'device-started-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({
        ok: true,
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: activeAuthorizationExpiry(startedAt),
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['device-started-call'] },
    });
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, started] }).state)
      .toBe('blocked_human');
    const explicitlyPending = {
      ...started,
      id: 'explicitly-pending-device-start',
      toolUseId: 'explicitly-pending-device-start-call',
      toolResult: JSON.stringify({
        ...JSON.parse(started.toolResult!),
        pending: true,
        status: 'authorization_pending',
        error: '',
      }),
    };
    const explicitlyPendingBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['explicitly-pending-device-start-call'] },
    });
    expect(validateObjectiveOutcome(explicitlyPendingBlocked, {
      objective, messages: [...messages, explicitlyPending],
    }).state).toBe('blocked_human');
    const uncorrelatedPoll: Message = {
      id: 'uncorrelated-device-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'uncorrelated-device-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: {}, toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, uncorrelatedPoll],
    }).state).toBe('blocked_human');

    for (const invalid of [
      { verification_uri: 'http://login.microsoft.com/device' },
      { user_code: '' },
      { pollAfterHumanLoginWith: 'continue' },
      { expiresAt: 'tomorrow' },
      { expiresAt: new Date(startedAt + 25 * 60 * 60 * 1_000).toISOString() },
      { requestId: 'auth-request-1', authRequestId: 'auth-request-2' },
      { success: false },
      { pending: false },
      { error: 'fatal auth failure' },
      { status: 'authorized' },
      { state: 'completed' },
    ]) {
      const malformed: Message = { ...started, id: `malformed-${Object.keys(invalid)[0]}`,
        toolUseId: `malformed-${Object.keys(invalid)[0]}-call`,
        toolResult: JSON.stringify({ ...JSON.parse(started.toolResult!), ...invalid }) };
      expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, malformed] }).state)
        .toBe('continue');
    }
    const generic = { ...started, id: 'generic-device-start', toolUseId: 'generic-device-start-call',
      toolName: 'mcp__files__read_document' };
    expect(validateObjectiveOutcome(blocked, { objective, messages: [...messages, generic] }).state)
      .toBe('continue');
  });

  it('retires a successful auth start only after its exact correlated poll succeeds', () => {
    const startedAt = Date.now();
    const started: Message = {
      id: 'correlated-device-start', role: 'tool', content: '', timestamp: startedAt,
      toolName: 'mcp__identity__device_code_start', toolUseId: 'correlated-device-start-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { tenant: 'tenant-1', requestId: 'auth-request-1' },
      toolResult: JSON.stringify({
        ok: true,
        connectionId: 'identity-connection-1',
        verification_uri: 'https://login.microsoft.com/device',
        user_code: 'D949VGHX3',
        expiresAt: activeAuthorizationExpiry(startedAt),
        pollAfterHumanLoginWith: 'device_code_poll',
      }),
    };
    const blocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['correlated-device-start-call'] },
    });
    const completedPoll: Message = {
      id: 'correlated-device-poll', role: 'tool', content: '', timestamp: startedAt + 1,
      toolName: 'mcp__identity__device_code_poll', toolUseId: 'correlated-device-poll-call',
      toolStatus: 'completed', toolExecuted: true, isError: false,
      toolInput: { requestId: 'auth-request-1' },
      toolResult: JSON.stringify({ ok: true, pending: false }),
    };
    for (const toolResult of [completedPoll.toolResult, JSON.stringify({ status: 'authorized' })]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, omitUndefined<Message>({ ...completedPoll, toolResult })],
      }).state).toBe('continue');
    }
    const resultCorrelatedPoll: Message = {
      ...completedPoll,
      id: 'result-correlated-device-poll',
      toolUseId: 'result-correlated-device-poll-call',
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({ pending: false, requestId: 'auth-request-1' }),
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, resultCorrelatedPoll],
    }).state).toBe('continue');

    const connectionOnlyPoll = {
      ...completedPoll,
      id: 'connection-only-device-poll',
      toolUseId: 'connection-only-device-poll-call',
      toolInput: { connectionId: 'identity-connection-1' },
    };
    const otherFlowPoll = {
      ...connectionOnlyPoll,
      id: 'other-flow-device-poll',
      toolUseId: 'other-flow-device-poll-call',
      toolInput: { requestId: 'auth-request-2', connectionId: 'identity-connection-1' },
    };
    for (const candidate of [connectionOnlyPoll, otherFlowPoll]) {
      expect(validateObjectiveOutcome(blocked, {
        objective, messages: [...messages, started, candidate],
      }).state).toBe('blocked_human');
    }
    const otherFlowStart = {
      ...started,
      id: 'other-flow-device-start',
      toolUseId: 'other-flow-device-start-call',
      toolInput: { tenant: 'tenant-1', requestId: 'auth-request-2' },
    };
    expect(validateObjectiveOutcome(blocked, {
      objective, messages: [...messages, started, otherFlowStart, otherFlowPoll],
    }).state).toBe('blocked_human');

    const connectionOnlyStart = {
      ...started,
      id: 'connection-only-device-start',
      toolUseId: 'connection-only-device-start-call',
      toolInput: { tenant: 'tenant-1' },
      toolResult: JSON.stringify({
        ...JSON.parse(started.toolResult!),
        connectionId: 'connection-only',
      }),
    };
    const connectionOnlyBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['connection-only-device-start-call'] },
    });
    expect(validateObjectiveOutcome(connectionOnlyBlocked, {
      objective,
      messages: [...messages, connectionOnlyStart, {
        ...connectionOnlyPoll,
        id: 'matching-connection-only-device-poll',
        toolUseId: 'matching-connection-only-device-poll-call',
        toolInput: { connectionId: 'connection-only' },
      }],
    }).state).toBe('continue');

    const conflictingStart = {
      ...started,
      id: 'conflicting-device-start',
      toolUseId: 'conflicting-device-start-call',
      toolResult: JSON.stringify({ ...JSON.parse(started.toolResult!), requestId: 'auth-request-2' }),
    };
    const conflictingBlocked = receipt({
      state: 'blocked_human', criteria: [], remainingWork: [],
      blocker: { kind: 'external_authorization', description: 'Complete Microsoft device login',
        evidence: ['conflicting-device-start-call'] },
    });
    expect(validateObjectiveOutcome(conflictingBlocked, {
      objective, messages: [...messages, conflictingStart],
    }).state).toBe('continue');
  });
});
