import { describe, expect, it } from 'bun:test';
import { USER_INPUT_LIMITS, normalizeUserInputQuestions, normalizeUserInputResponse } from '../src/utils/user-input.ts';
import type { UserInputQuestion } from '../src/types/user-input.ts';

const questions: UserInputQuestion[] = [
  { id: 'audience', question: 'À qui est destiné le document ?', options: [
    { id: 'team', label: 'Équipe', recommended: true }, { id: 'clients', label: 'Clients' },
  ] },
  { id: 'formats', question: 'Quels formats préparer ?', multiSelect: true, options: [
    { id: 'pdf', label: 'PDF' }, { id: 'docx', label: 'Word' },
  ] },
  { id: 'context', question: 'Quel contexte manque-t-il ?' },
];
const request = { id: 'question-request-1', questions };

describe('structured user input validation', () => {
  it('accepts single, multiple and text-only questions without selecting a recommendation', () => {
    const normalized = normalizeUserInputQuestions(questions);
    expect(normalized).toEqual(questions);
    expect(() => normalizeUserInputResponse({ id: request.id, questions: [questions[0]!] }, {
      requestId: request.id, answers: [{ questionId: 'audience', optionIds: [] }],
    })).toThrow('Choose an option or enter an answer');
  });

  it('canonicalizes equivalent retries and accepts free text with or instead of options', () => {
    const result = normalizeUserInputResponse(request, { requestId: request.id, answers: [
      { questionId: 'context', text: '  Conserver les chiffres de septembre.  ' },
      { questionId: 'formats', optionIds: ['docx', 'pdf'], text: 'Version imprimable' },
      { questionId: 'audience', optionIds: [], text: 'Le conseil d’administration' },
    ] });
    expect(result.answers).toEqual([
      { questionId: 'audience', optionIds: [], text: 'Le conseil d’administration' },
      { questionId: 'formats', optionIds: ['pdf', 'docx'], text: 'Version imprimable' },
      { questionId: 'context', optionIds: [], text: 'Conserver les chiffres de septembre.' },
    ]);
    expect(normalizeUserInputResponse(request, result)).toEqual(result);
  });

  it('does not mutate inputs or retain nested request references', () => {
    const input = JSON.parse(JSON.stringify(questions));
    const normalized = normalizeUserInputQuestions(input);
    normalized[0]!.options![0]!.label = 'changed';
    expect(input).toEqual(questions);
  });

  it('rejects forged questions, options and the wrong request', () => {
    const one = { id: request.id, questions: [questions[0]!] };
    for (const response of [
      { requestId: 'another-request', answers: [{ questionId: 'audience', optionIds: ['team'] }] },
      { requestId: request.id, answers: [{ questionId: 'forged', optionIds: ['team'] }] },
      { requestId: request.id, answers: [{ questionId: 'audience', optionIds: ['unknown'] }] },
      { requestId: request.id, answers: [{ questionId: 'audience', optionIds: ['team', 'clients'] }] },
      { requestId: request.id, answers: [{ questionId: 'audience', optionIds: ['team', 'team'] }] },
    ]) expect(() => normalizeUserInputResponse(one, response)).toThrow();
  });

  it('requires exactly one answer per question, with no duplicated or empty answer', () => {
    const good = { questionId: 'audience', optionIds: ['team'] };
    for (const answers of [[], [good], [good, good, { questionId: 'context', text: 'ok' }]]) {
      expect(() => normalizeUserInputResponse(request, { requestId: request.id, answers })).toThrow();
    }
    expect(() => normalizeUserInputResponse({ id: request.id, questions: [questions[2]!] }, {
      requestId: request.id, answers: [{ questionId: 'context', text: ' \n ' }],
    })).toThrow();
  });

  it('distinguishes explicit dismissal from an answer and rejects ambiguous submissions', () => {
    expect(normalizeUserInputResponse(request, { requestId: request.id, cancelled: true })).toEqual({ requestId: request.id, cancelled: true });
    expect(() => normalizeUserInputResponse(request, {
      requestId: request.id, cancelled: true, answers: [{ questionId: 'context', text: 'answer' }],
    })).toThrow();
    expect(() => normalizeUserInputResponse(request, { requestId: request.id, cancelled: 'true' })).toThrow();
  });

  it('bounds tool and form payloads and rejects duplicate or malformed identities', () => {
    for (const input of [
      null, [], [...questions, questions[0]],
      [questions[0], questions[0]],
      [{ ...questions[0], id: 'bad\nid' }],
      [{ ...questions[0], options: [...questions[0]!.options!, questions[0]!.options![0]] }],
      [{ ...questions[0], multiSelect: 'yes' }],
      [{ ...questions[0], question: 'q'.repeat(USER_INPUT_LIMITS.maxQuestionLength + 1) }],
      [{ ...questions[0], options: Array.from({ length: 9 }, (_, i) => ({ id: String(i), label: 'option' })) }],
    ]) expect(() => normalizeUserInputQuestions(input)).toThrow();
    expect(() => normalizeUserInputResponse({ id: request.id, questions: [questions[2]!] }, {
      requestId: request.id, answers: [{ questionId: 'context', text: 'a'.repeat(USER_INPUT_LIMITS.maxAnswerLength + 1) }],
    })).toThrow();
  });
});
