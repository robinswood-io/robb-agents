import { describe, expect, it } from 'bun:test';
import { deriveNativeQuestionOutcome, nativeQuestionCompletionRefs } from './native-question-completion';
import { extractObjectiveOutcome, validateObjectiveOutcome } from './objective-outcome';
import { fixture, falsePolicy, answerPrefix, legacyAnswerPrefix } from './testing/native-question-fixtures';

describe('observed native question-only completion', () => {
it('retains genuine blockers, extraction errors and independent evidence gates', () => {
    const h = fixture(), reported = falsePolicy(h);
    for (const options of ([
        {
            extractionError: 'malformed receipt'
        },
        {
            evidenceGap: 'missing evidence'
        },
        {
            executionEvidenceMissing: true
        },
        {
            autonomyEvents: [
                {
                    id: 'host-blocker', timestamp: 4, phase: 'escalated', message: 'External authorization required', escalationReason: 'external_authorization_required'
                }
            ]
        }
    ] satisfies Array<Partial<Parameters<typeof validateObjectiveOutcome>[1]>>)) {
        const result = validateObjectiveOutcome(reported, {
            ...h, ...options
        });
        expect(result.state).not.toBe('complete_verified');
        expect(result.declaration).toBeUndefined();
    }
    h.messages.splice(3, 0, {
        id: 'auth', role: 'auth-request', content: 'Sign in required', authStatus: 'pending', timestamp: 3
    });
    expect(validateObjectiveOutcome(reported, h).declaration).toBeUndefined();
});

for (const [name, change] of [
    [
        'human blocker', (d: ReturnType<typeof falsePolicy>) => { d.state = 'blocked_human'; d.blocker.kind = 'business_decision'; }
    ],
    [
        'real remaining work', (d: ReturnType<typeof falsePolicy>) => { d.remainingWork = [
            'Something remains'
        ]; }
    ],
    [
        'another unsatisfied criterion', (d: ReturnType<typeof falsePolicy>) => { d.criteria[0]!.satisfied = false; }
    ],
    [
        'duplicate criterion', (d: ReturnType<typeof falsePolicy>) => { d.criteria[0] = d.criteria[1]!; }
    ],
    [
        'foreign blocker evidence', (d: ReturnType<typeof falsePolicy>) => { d.blocker.evidence = [
            'another-authority'
        ]; }
    ],
    [
        'continue declaration', (d: ReturnType<typeof falsePolicy>) => { d.state = 'continue'; }
    ],
] as Array<[
    string,
    (value: ReturnType<typeof falsePolicy>) => void
]>)
    it('does not project ' + name, () => { const h = fixture(), d = structuredClone(falsePolicy(h)); change(d); expect(deriveNativeQuestionOutcome(d, h.objective, h.messages)).toBeUndefined(); });

it('does not trust model-supplied host provenance or mutate the model receipt', () => {
    const h = fixture(), d = {
        ...falsePolicy(h), hostProvenance: {
            kind: 'native-question-completion', nativeEvidence: [
                'invented'
            ]
        }
    };
    const parsed = extractObjectiveOutcome('Three lines\n<!-- robb_objective_outcome ' + JSON.stringify(d) + ' -->');
    expect(parsed.declaration).not.toHaveProperty('hostProvenance');
    const before = JSON.stringify(h);
    deriveNativeQuestionOutcome(falsePolicy(h), h.objective, h.messages);
    expect(JSON.stringify(h)).toBe(before);
});

it('validates the actual selected labels and exact free text without changing the legacy objective', () => {
    const h = fixture();
    const before = JSON.stringify(h);
    expect([
        ...nativeQuestionCompletionRefs(h.objective, h.messages)
    ]).toEqual([
        'tool', 'call-native', 'answer', 'input-native'
    ]);
    expect(validateObjectiveOutcome(h.outcome, h)).toMatchObject({
        valid: true, state: 'complete_verified', gaps: []
    });
    expect(JSON.stringify(h)).toBe(before);
});

it('keeps an already persisted legacy answer envelope verifiable', () => {
    const h = fixture();
    h.messages[2]!.content = h.messages[2]!.content.replace(answerPrefix, legacyAnswerPrefix);
    expect([
        ...nativeQuestionCompletionRefs(h.objective, h.messages)
    ]).toEqual([
        'tool', 'call-native', 'answer', 'input-native'
    ]);
});

for (const [name, mutate] of [
    [
        'extra work in original request', (h: ReturnType<typeof fixture>) => { h.objective.originalText = h.messages[0]!.content += '\nPuis déploie le serveur.'; }
    ],
    [
        'ordinary question during a business objective', (h: ReturnType<typeof fixture>) => { h.objective.originalText = h.messages[0]!.content = 'Demande le format puis crée et envoie le rapport.'; }
    ],
    [
        'changed selected answer in the final', (h: ReturnType<typeof fixture>) => { h.messages[3]!.content = h.messages[3]!.content.replace('Détaillé', 'Court'); }
    ],
    [
        'changed free note', (h: ReturnType<typeof fixture>) => { h.messages[3]!.content = h.messages[3]!.content.replace('sans action.', 'sans actions.'); }
    ],
    [
        'extra final paragraph', (h: ReturnType<typeof fixture>) => { h.messages[3]!.content += '\nAutre action achevée.'; }
    ],
    [
        'missing answer', (h: ReturnType<typeof fixture>) => { h.messages.splice(2, 1); }
    ],
    [
        'tool-provided fake user answer', (h: ReturnType<typeof fixture>) => { delete h.messages[2]!.internalOrigin; }
    ],
    [
        'foreign request', (h: ReturnType<typeof fixture>) => { h.messages[2]!.content = h.messages[2]!.content.replace('input-native', 'foreign'); }
    ],
    [
        'duplicate answer', (h: ReturnType<typeof fixture>) => { h.messages.splice(3, 0, {
            ...h.messages[2]!, id: 'duplicate'
        }); }
    ],
    [
        'question mismatch', (h: ReturnType<typeof fixture>) => { h.questions[0]!.question = 'Une autre question'; }
    ],
    [
        'failed question tool', (h: ReturnType<typeof fixture>) => { h.messages[1]!.isError = true; }
    ],
    [
        'unexecuted question tool', (h: ReturnType<typeof fixture>) => { h.messages[1]!.toolExecuted = false; }
    ],
    [
        'another executed tool', (h: ReturnType<typeof fixture>) => { h.messages.splice(3, 0, {
            id: 'write', role: 'tool', content: '', toolName: 'Write', toolExecuted: true, timestamp: 3
        }); }
    ],
    [
        'new accepted user instruction', (h: ReturnType<typeof fixture>) => { h.objective.lastUserMessageId = 'new'; }
    ],
    [
        'public message after original', (h: ReturnType<typeof fixture>) => { h.messages.splice(3, 0, {
            id: 'new', role: 'user', content: 'Continue', timestamp: 3
        }); }
    ],
    [
        'registered business checks', (h: ReturnType<typeof fixture>) => { h.objective.requiresAcceptanceCriteria = true; }
    ],
    [
        'execution requirement', (h: ReturnType<typeof fixture>) => { h.objective.requiresExecutionEvidence = true; }
    ],
    [
        'observation requirement', (h: ReturnType<typeof fixture>) => { h.objective.requiresObservationEvidence = true; }
    ],
    [
        'malformed native result', (h: ReturnType<typeof fixture>) => { h.messages[1]!.toolResult = 'null'; }
    ],
    [
        'malformed native reply', (h: ReturnType<typeof fixture>) => { h.messages[2]!.content = answerPrefix + 'null'; }
    ],
    [
        'queued original', (h: ReturnType<typeof fixture>) => { h.messages[0]!.isQueued = true; }
    ],
    [
        'pending original', (h: ReturnType<typeof fixture>) => { h.messages[0]!.isPending = true; }
    ],
    [
        'queued answer', (h: ReturnType<typeof fixture>) => { h.messages[2]!.isQueued = true; }
    ],
    [
        'pending answer', (h: ReturnType<typeof fixture>) => { h.messages[2]!.isPending = true; }
    ],
    [
        'agent-delivered answer', (h: ReturnType<typeof fixture>) => { h.messages[2]!.agentDelivery = {
            id: 'other-agent', status: 'processed', attempts: 1
        }; }
    ],
    [
        'legacy amendments', (h: ReturnType<typeof fixture>) => { h.objective.amendments = [
            {
                messageId: 'other', text: 'Déploie', timestamp: 5
            }
        ]; }
    ],
    [
        'unreviewed contract change', (h: ReturnType<typeof fixture>) => { h.objective.acceptanceNeedsReview = true; }
    ],
    [
        'running question tool', (h: ReturnType<typeof fixture>) => { h.messages[1]!.toolStatus = 'executing'; }
    ],
    [
        'contradictory error status', (h: ReturnType<typeof fixture>) => { h.messages[1]!.toolStatus = 'error'; }
    ],
    [
        'intermediate final', (h: ReturnType<typeof fixture>) => { h.messages[3]!.isIntermediate = true; }
    ],
    [
        'ambiguous message ID', (h: ReturnType<typeof fixture>) => { h.messages[3]!.id = 'answer'; }
    ],
    [
        'ambiguous tool-use ID', (h: ReturnType<typeof fixture>) => { h.messages[3]!.toolUseId = 'call-native'; }
    ],
] as Array<[
    string,
    (h: ReturnType<typeof fixture>) => void
]>)
    it('does not credit ' + name, () => { const h = fixture(); mutate(h); expect(nativeQuestionCompletionRefs(h.objective, h.messages).size).toBe(0); });
});
