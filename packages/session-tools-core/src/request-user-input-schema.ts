import { z } from 'zod';
import { USER_INPUT_LIMITS } from '@craft-agent/core';

const idSchema = z.string().max(USER_INPUT_LIMITS.maxIdLength).trim().min(1);

const optionSchema = z.object({
  id: idSchema,
  label: z.string().max(USER_INPUT_LIMITS.maxOptionLabelLength).trim().min(1),
  description: z.string().max(USER_INPUT_LIMITS.maxOptionDescriptionLength).optional(),
  recommended: z.boolean().optional(),
});

const questionSchema = z.object({
  id: idSchema,
  question: z.string().max(USER_INPUT_LIMITS.maxQuestionLength).trim().min(1),
  options: z.array(optionSchema).max(USER_INPUT_LIMITS.maxOptions)
    .refine(options => new Set(options.map(option => option.id)).size === options.length, 'Option IDs must be unique within each question.')
    .optional(),
  multiSelect: z.boolean().default(false),
});

// Shared by the advertised tool schema and the runtime handler: proxy/MCP
// callers must receive the same validation as Claude's SDK tool adapter.
export const RequestUserInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(USER_INPUT_LIMITS.maxQuestions)
    .refine(questions => new Set(questions.map(question => question.id)).size === questions.length, 'Question IDs must be unique.'),
});
