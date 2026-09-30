import type { UserInputAnswer, UserInputQuestion, UserInputRequest, UserInputResponse } from '../types/user-input.ts';

/** Canonical host envelopes for persisted native-question answers. Keep the
 * legacy form readable so existing sessions remain restart-compatible. */
export const USER_INPUT_ANSWER_MESSAGE_PREFIX = 'The user answered the pending questions. Apply these authenticated selections to the current objective without replacing it. An affirmative selection authorizes only the exact displayed scope it confirms; it grants no broader permission or credential.\n';
export const LEGACY_USER_INPUT_ANSWER_MESSAGE_PREFIX = 'The user answered the pending questions. Apply these answers to the current objective without replacing it. They are preferences or information, not an execution permission or credential.\n';

/** Shared, dependency-free validation for tools, the host and form submissions. */
export const USER_INPUT_LIMITS = {
  maxQuestions: 3,
  maxOptions: 8,
  maxIdLength: 80,
  maxQuestionLength: 2_000,
  maxOptionLabelLength: 200,
  maxOptionDescriptionLength: 500,
  maxAnswerLength: 8_000,
} as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new Error(`${name} must be a string of at most ${maximum} characters`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

function identifier(value: unknown, name: string): string {
  const id = text(value, USER_INPUT_LIMITS.maxIdLength, name);
  if (/[\u0000-\u001f\u007f]/.test(id)) throw new Error(`${name} must not contain control characters`);
  return id;
}

function optionalBoolean(value: unknown, name: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${name} must be boolean`);
  return value === true;
}

function assertUnique(ids: string[], name: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${name} must be unique`);
}

export function normalizeUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > USER_INPUT_LIMITS.maxQuestions) {
    throw new Error(`Provide between 1 and ${USER_INPUT_LIMITS.maxQuestions} questions`);
  }
  const questions = value.map((entry): UserInputQuestion => {
    const question = record(entry, 'Question');
    if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > USER_INPUT_LIMITS.maxOptions)) {
      throw new Error(`Provide at most ${USER_INPUT_LIMITS.maxOptions} options per question`);
    }
    const options = (question.options as unknown[] | undefined)?.map(entry => {
      const option = record(entry, 'Option');
      const description = option.description === undefined ? undefined
        : text(option.description, USER_INPUT_LIMITS.maxOptionDescriptionLength, 'Option description', true);
      return {
        id: identifier(option.id, 'Option id'),
        label: text(option.label, USER_INPUT_LIMITS.maxOptionLabelLength, 'Option label'),
        ...(description ? { description } : {}),
        ...(optionalBoolean(option.recommended, 'recommended') ? { recommended: true } : {}),
      };
    });
    if (options) assertUnique(options.map(option => option.id), 'Option ids');
    const multiple = optionalBoolean(question.multiSelect, 'multiSelect');
    return {
      id: identifier(question.id, 'Question id'),
      question: text(question.question, USER_INPUT_LIMITS.maxQuestionLength, 'Question'),
      ...(options?.length ? { options } : {}),
      ...(multiple && options?.length ? { multiSelect: true } : {}),
    };
  });
  assertUnique(questions.map(question => question.id), 'Question ids');
  return questions;
}

/** Canonical ordering lets equivalent retries be acknowledged idempotently. */
export function normalizeUserInputResponse(
  request: Pick<UserInputRequest, 'id' | 'questions'>,
  value: unknown,
): UserInputResponse {
  const response = record(value, 'Response');
  const requestId = identifier(response.requestId, 'Request id');
  if (requestId !== request.id) throw new Error('Response does not match this request');
  if (optionalBoolean(response.cancelled, 'cancelled')) {
    if (response.answers !== undefined && (!Array.isArray(response.answers) || response.answers.length > 0)) {
      throw new Error('A cancelled response must not include answers');
    }
    return { requestId, cancelled: true };
  }
  const questions = normalizeUserInputQuestions(request.questions);
  if (!Array.isArray(response.answers) || response.answers.length !== questions.length) {
    throw new Error('Answer each question exactly once');
  }
  const answers = response.answers.map((entry): UserInputAnswer => {
    const answer = record(entry, 'Answer');
    const questionId = identifier(answer.questionId, 'Question id');
    const question = questions.find(question => question.id === questionId);
    if (!question) throw new Error('Unknown question');
    const rawIds = answer.optionIds ?? [];
    if (!Array.isArray(rawIds) || rawIds.length > USER_INPUT_LIMITS.maxOptions) throw new Error('Invalid option selection');
    const optionIds = rawIds.map(id => identifier(id, 'Selected option id'));
    assertUnique(optionIds, 'Selected options');
    if (!question.multiSelect && optionIds.length > 1) throw new Error('Select only one option for this question');
    if (optionIds.some(id => !question.options?.some(option => option.id === id))) throw new Error('Unknown option');
    const freeText = answer.text === undefined ? '' : text(answer.text, USER_INPUT_LIMITS.maxAnswerLength, 'Answer', true);
    if (!optionIds.length && !freeText) throw new Error('Choose an option or enter an answer');
    return {
      questionId,
      optionIds: (question.options ?? []).filter(option => optionIds.includes(option.id)).map(option => option.id),
      ...(freeText ? { text: freeText } : {}),
    };
  });
  assertUnique(answers.map(answer => answer.questionId), 'Answered question ids');
  return { requestId, answers: questions.map(question => answers.find(answer => answer.questionId === question.id)!) };
}
