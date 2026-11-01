import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { describe, expect, it } from 'bun:test';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import { SessionManager, createManagedSession } from './SessionManager';
import { ScriptedSessionAgent } from './testing/scripted-session-agent';
import { fixture, falsePolicy } from './testing/native-question-fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession } from '@craft-agent/shared/sessions/storage';

describe('observed native question-only completion', () => {
it('canonically verifies the completed native reply before an unknown budget can reject a false policy blocker', async () => {
    const h = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'native-policy-proof-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const host = manager;
    const reported = falsePolicy(h);
    try {
        const managed = createManagedSession({
            id: 'native-policy', name: 'Native policy'
        }, {
            id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath: directory, createdAt: 1
        }, {
            messagesLoaded: true
        });
        managed.activeObjective = structuredClone(h.objective);
        managed.messages = structuredClone(h.messages);
        sessionRuntimeStateForTest(host).sessions.set(managed.id, managed);
        managed.messages[0]!.isQueued = false;
        const events: SessionEvent[] = [];
        host['sendEvent'] = (event: SessionEvent) => { events.push(structuredClone(event)); };
        for (const name of [
            'startGenerationTelemetry', 'finishGenerationTelemetry', 'finishAllGenerationTelemetry', 'emitExecutionTelemetry'
        ] as const)
            host[name] = () => undefined;
        let calls = 0;
        let dispatch: Promise<void> | undefined;
        let budgetAtProvider: typeof managed.pendingTurnRecovery;
        const agent = new ScriptedSessionAgent(managed.workspace, {
            isProcessing: () => false, forceAbort: () => { }, async *chat() { calls++; budgetAtProvider = structuredClone(managed.pendingTurnRecovery); yield {
                type: 'text_complete', text: h.messages[3]!.content + '\n<!-- robb_objective_outcome ' + JSON.stringify(reported) + ' -->', turnId: 'native-policy-final'
            }; yield {
                type: 'complete'
            }; }
        });
        host['getOrCreateAgent'] = async () => { managed.agent = agent; return agent; };
        const send = host.sendMessage.bind(host);
        host.sendMessage = (...args: Parameters<SessionManager['sendMessage']>) => { dispatch = send(...args); return dispatch; };
        const originalMessages = JSON.stringify(managed.messages);
        expect(await manager.retryTurn(managed.id, 'root')).toEqual({
            status: 'started'
        });
        await dispatch;
        await manager.flushSession(managed.id);
        expect(budgetAtProvider).toMatchObject({
            attempts: 0, budgetHistoryUnavailable: true
        });
        expect(budgetAtProvider?.explicitRetryAllowances).toBeUndefined();
        expect(calls).toBe(1);
        expect(managed.activeObjective?.terminalState).toBe('complete_verified');
        expect(managed.pendingTurnRecovery).toBeUndefined();
        expect(managed.messages.filter(m => m.role === 'error')).toEqual([]);
        expect(JSON.stringify(managed.messages.slice(0, h.messages.length))).toBe(originalMessages);
        const final = managed.messages.find(m => m.turnId === 'native-policy-final')!;
        expect(final.objectiveOutcome).toMatchObject({
            state: 'complete_verified', blocker: null, remainingWork: [], hostProvenance: {
                kind: 'native-question-completion', schemaVersion: 1, objectiveId: 'root', finalMessageId: final.id, reportedOutcome: reported
            }
        });
        expect(managed.activeObjective?.lastOutcome).toEqual(final.objectiveOutcome);
        expect(events.filter((e): e is Extract<SessionEvent, { type: 'text_complete' }> => e.type === 'text_complete' && e.messageId === final.id).at(-1)?.objectiveOutcome).toEqual(final.objectiveOutcome);
        const saved = loadSession(directory, managed.id)!;
        expect(saved.activeObjective?.terminalState).toBe('complete_verified');
        expect(saved.activeObjective?.lastOutcome).toEqual(final.objectiveOutcome);
        expect(saved.messages.find(m => m.id === final.id)?.objectiveOutcome).toEqual(final.objectiveOutcome);
        expect(managed.messages.filter(m => m.role === 'tool')).toHaveLength(1);
        expect(managed.messages.filter(m => m.role === 'user' && !m.hidden)).toHaveLength(1);
    }
    finally {
        await manager.cleanup();
        rmSync(directory, {
            recursive: true, force: true
        });
    }
});

it('does not convert a late provider final after Stop into completion or grant credit', async () => {
    const h = fixture(), directory = mkdtempSync(join(tmpdir(), 'native-policy-stop-'));
    const manager = withSessionOperationsForTest(new SessionManager()), host = manager;
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    try {
        const managed = createManagedSession({
            id: 'native-policy-stop'
        }, {
            id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath: directory, createdAt: 1
        }, {
            messagesLoaded: true
        });
        managed.activeObjective = structuredClone(h.objective);
        managed.messages = structuredClone(h.messages);
        sessionRuntimeStateForTest(host).sessions.set(managed.id, managed);
        host['sendEvent'] = () => { };
        for (const name of [
            'startGenerationTelemetry', 'finishGenerationTelemetry', 'finishAllGenerationTelemetry', 'emitExecutionTelemetry'
        ] as const)
            host[name] = () => undefined;
        let calls = 0, dispatch: Promise<void> | undefined;
        const agent = new ScriptedSessionAgent(managed.workspace, {
            isProcessing: () => managed.isProcessing, forceAbort: () => { release(); }, async *chat() { calls++; started(); await gate; yield {
                type: 'text_complete', text: h.messages[3]!.content + '\n<!-- robb_objective_outcome ' + JSON.stringify(falsePolicy(h)) + ' -->', turnId: 'stale-native-final'
            }; yield {
                type: 'complete'
            }; }
        });
        host['getOrCreateAgent'] = async () => { managed.agent = agent; return agent; };
        const send = host.sendMessage.bind(host);
        host.sendMessage = (...args: Parameters<SessionManager['sendMessage']>) => { dispatch = send(...args); return dispatch; };
        await manager.retryTurn(managed.id, 'root');
        await ready;
        await manager.cancelProcessing(managed.id);
        release();
        await dispatch;
        await manager.flushSession(managed.id);
        expect(calls).toBe(1);
        expect(managed.activeObjective?.terminalState).not.toBe('complete_verified');
        expect(managed.messages.find(m => m.turnId === 'stale-native-final')?.objectiveOutcome).not.toHaveProperty('hostProvenance');
        expect(managed.pendingTurnRecovery).toMatchObject({
            budgetHistoryUnavailable: true, attempts: 0, validationExhausted: true
        });
        expect(managed.pendingTurnRecovery?.explicitRetryAllowances).toBeUndefined();
    }
    finally {
        release();
        await manager.cleanup();
        rmSync(directory, {
            recursive: true, force: true
        });
    }
});

it('finishes one explicit legacy Retry without asking again or inventing a recovery allowance', async () => {
    const h = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'native-answer-proof-'));
    const manager = withSessionOperationsForTest(new SessionManager());
    const host = manager;
    try {
        const managed = createManagedSession({
            id: 'native-retry', name: 'Native retry'
        }, {
            id: 'fixture', slug: 'fixture', name: 'Fixture', rootPath: directory, createdAt: 1
        }, {
            messagesLoaded: true
        });
        managed.activeObjective = structuredClone(h.objective);
        managed.messages = structuredClone(h.messages);
        sessionRuntimeStateForTest(host).sessions.set(managed.id, managed);
        host['sendEvent'] = () => { };
        for (const name of [
            'startGenerationTelemetry', 'finishGenerationTelemetry', 'finishAllGenerationTelemetry', 'emitExecutionTelemetry'
        ] as const)
            host[name] = () => undefined;
        let calls = 0;
        let dispatch: Promise<void> | undefined;
        const agent = new ScriptedSessionAgent(managed.workspace, {
            isProcessing: () => false, forceAbort: () => { }, async *chat() { calls++; yield {
                type: 'text_complete', text: h.messages[3]!.content + '\n<!-- robb_objective_outcome ' + JSON.stringify(h.outcome) + ' -->', turnId: 'native-restored-final'
            }; yield {
                type: 'complete'
            }; }
        });
        host['getOrCreateAgent'] = async () => { managed.agent = agent; return agent; };
        const send = host.sendMessage.bind(host);
        host.sendMessage = (...args: Parameters<SessionManager['sendMessage']>) => { dispatch = send(...args); return dispatch; };
        expect(await manager.retryTurn(managed.id, 'root')).toEqual({
            status: 'started'
        });
        await dispatch;
        await manager.flushSession(managed.id);
        expect(calls).toBe(1);
        expect(managed.activeObjective).toMatchObject({
            objectiveId: 'root', userMessageId: 'root', originalText: h.objective.originalText, orchestrationMode: 'mission', terminalState: 'complete_verified', budgetBaselineUsd: 0
        });
        expect(managed.messages.filter(message => message.role === 'tool')).toHaveLength(1);
        expect(managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1);
        expect(managed.messages.find(message => message.turnId === 'native-restored-final')?.content).toBe(h.messages[3]!.content);
    }
    finally {
        await manager.cleanup();
        rmSync(directory, {
            recursive: true, force: true
        });
    }
});
});
