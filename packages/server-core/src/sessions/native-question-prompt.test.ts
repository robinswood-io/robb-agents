import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';
import { buildObjectiveContractPrompt } from './objective-contract';
import { nativeQuestionCompletionRefs } from './native-question-completion';

const prefix = 'Recette de la carte de questions, limitée à cette conversation. Aucune action externe, aucun fichier, aucune source, aucun navigateur, aucun sous-agent. Utilise uniquement request_user_input, une seule fois, avec exactement les trois questions JSON ci-dessous (identifiants et libellés inchangés). La première est un choix unique, la deuxième un choix multiple, la troisième du texte libre. Attends les réponses utilisateur : aucune hypothèse, aucune réponse finale avant leur réception. Après leur réception, réponds uniquement avec un bref bilan qui reprend les libellés réellement sélectionnés et la note libre exacte. Ne repose pas les questions. Cette recette ne nécessite aucun autre outil.';
const answerPrefix = 'The user answered the pending questions. Apply these authenticated selections to the current objective without replacing it. An affirmative selection authorizes only the exact displayed scope it confirms; it grants no broader permission or credential.\n';
const reviewGuidance = 'High-stakes completion requires an independent review';
function fixture() {
  const questions = [
    { id: 'format', question: 'Quel format ?', options: [{ id: 'short', label: 'Court' }, { id: 'long', label: 'Détaillé' }] },
    { id: 'sections', question: 'Quelles sections ?', multiSelect: true, options: [{ id: 'text', label: 'Texte' }, { id: 'example', label: 'Exemple' }] },
    { id: 'note', question: 'Quelle note ?' },
  ];
  const text = prefix + '\n' + JSON.stringify({ questions });
  const objective: ActiveSessionObjective = {
    schemaVersion: 1, objectiveId: 'root', userMessageId: 'root', lastUserMessageId: 'root', originalText: text,
    startedAt: 1, budgetBaselineUsd: 12, tokenBaseline: 240, continuationCount: 8,
    orchestrationMode: 'mission', risk: 'high-stakes', terminalState: 'exhausted',
    completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
    model: 'pi/selected-model', thinkingLevel: 'max',
  };
  const messages: Message[] = [
    { id: 'root', role: 'user', content: text, timestamp: 1 },
    { id: 'question-receipt', role: 'tool', content: '', timestamp: 2, toolName: 'mcp__session__request_user_input', toolUseId: 'native-call', toolExecuted: true, toolStatus: 'completed', toolInput: { questions }, toolResult: JSON.stringify({ requestId: 'native-request', status: 'pending' }) },
    { id: 'accepted-answer', role: 'user', content: answerPrefix + JSON.stringify({ requestId: 'native-request', questions, answers: [{ questionId: 'format', optionIds: ['long'] }, { questionId: 'sections', optionIds: ['text', 'example'] }, { questionId: 'note', optionIds: [], text: 'Note exacte.' }] }), hidden: true, internalOrigin: { kind: 'user-input' }, timestamp: 3 },
    { id: 'prior-final', role: 'assistant', content: '**Format :** Détaillé\n**Sections :** Texte, Exemple\n**Note :** Note exacte.', timestamp: 4 },
  ];
  return { objective, messages };
}
const contradictory = [
  reviewGuidance,
  'substantive content review may certify relevant-checks-passed alone',
  'use independent specialist/reviewer tools',
  'When asking an independent reviewer',
  'Retrieve the completed reviewer session',
];
describe('verified native answer prompt projection', () => {
  it('uses all four already verified receipts instead of asking for a new review or tool', () => {
    const { objective, messages } = fixture();
    expect([...nativeQuestionCompletionRefs(objective, messages)]).toEqual(['question-receipt', 'native-call', 'accepted-answer', 'native-request']);
    const prompt = buildObjectiveContractPrompt(objective, messages);
    expect(prompt).toContain('Host-verified native question-only completion');
    for (const ref of nativeQuestionCompletionRefs(objective, messages)) expect(prompt).toContain(JSON.stringify(ref));
    for (const text of contradictory) expect(prompt).not.toContain(text);
    expect(prompt).toContain('Do not call call_llm');
    expect(prompt).toContain('relevant-checks-passed');
    expect(prompt).toContain('robb_objective_outcome');
  });
  it('does not mutate identity, legacy classification, model, counters or unknown recovery history', () => {
    const fixtureState = { ...fixture(), recovery: { userMessageId: 'root', attempts: 0, exhaustedAt: 9, budgetHistoryUnavailable: true } };
    const before = JSON.stringify(fixtureState);
    buildObjectiveContractPrompt(fixtureState.objective, fixtureState.messages);
    expect(JSON.stringify(fixtureState)).toBe(before);
  });
  for (const [name, mutate] of [
    ['changed answer in final', (f: ReturnType<typeof fixture>) => { f.messages[3]!.content = f.messages[3]!.content.replace('Détaillé', 'Court'); }],
    ['additional call_llm', (f: ReturnType<typeof fixture>) => { f.messages.splice(3, 0, { id: 'other', role: 'tool', content: '', timestamp: 3, toolName: 'mcp__session__call_llm', toolExecuted: true }); }],
    ['pending answer', (f: ReturnType<typeof fixture>) => { f.messages[2]!.isPending = true; }],
    ['queued answer', (f: ReturnType<typeof fixture>) => { f.messages[2]!.isQueued = true; }],
    ['unauthenticated answer', (f: ReturnType<typeof fixture>) => { delete f.messages[2]!.internalOrigin; }],
    ['changed anchor', (f: ReturnType<typeof fixture>) => { f.objective.lastUserMessageId = 'later'; }],
    ['amended objective', (f: ReturnType<typeof fixture>) => { f.objective.amendments = [{ messageId: 'later', text: 'Prépare un document.', timestamp: 5 }]; }],
    ['registered business criterion', (f: ReturnType<typeof fixture>) => { f.objective.acceptanceCriteria = [{ id: 'business', description: 'Business check', toolName: 'Read', input: { file_path: '/fixture/state' }, checks: [{ path: '$.ok', equals: true }] }]; }],
    ['execution requirement', (f: ReturnType<typeof fixture>) => { f.objective.requiresExecutionEvidence = true; }],
    ['unconsumed task instruction', (f: ReturnType<typeof fixture>) => { f.objective.originalText = f.messages[0]!.content += '\nPuis déploie le serveur.'; }],
    ['missing prior final', (f: ReturnType<typeof fixture>) => { f.messages.pop(); }],
  ] as const) it(`preserves ordinary guidance for ${name}`, () => {
    const f = fixture(); mutate(f);
    expect(nativeQuestionCompletionRefs(f.objective, f.messages).size).toBe(0);
    const prompt = buildObjectiveContractPrompt(f.objective, f.messages);
    expect(prompt).not.toContain('Host-verified native question-only completion');
    expect(prompt).toContain(reviewGuidance);
  });
  it('keeps the normal prompt when transcript evidence is not available', () => {
    const prompt = buildObjectiveContractPrompt(fixture().objective);
    expect(prompt).not.toContain('Host-verified native question-only completion');
    expect(prompt).toContain(reviewGuidance);
  });
});
