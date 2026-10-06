import { z } from 'zod';
import { completionCriterionPathKeys } from './completion-criteria-selectors.ts';

const AcceptanceScalar = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()]);
const AcceptanceResultScalar = AcceptanceScalar
  .describe('Exact expected scalar result. $text requires a string; only one final LF/CRLF terminator is ignored.');

/** Shared by provider schemas and proxy-handler validation. The host remains authoritative. */
export const SetCompletionCriteriaSchema = z.object({
  _hostTerminalReconciliationCapability: z.string().min(32).max(128).optional()
    .describe('Host-reserved invocation capability. Never provide this field yourself.'),
  procedure: z.enum(['document-package', 'document-delivery', 'campaign-preparation', 'software-change', 'software-deployment']).optional()
    .describe('Select a business outcome procedure. It cannot be changed once selected. The host returns its requirements and missing coverage; add a check with requirementId for every requirement.'),
  criteria: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .describe('Stable criterion ID, e.g. target-ready. Use this same ID in the final outcome receipt.'),
    supersedes: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional()
      .describe('Explicitly replace one failed registered criterion with its next `_vN` ID, e.g. target-ready_v2 supersedes target-ready. The host rejects unobserved or passing predecessors and retains their history.'),
    description: z.string().min(1).max(1000).refine(value => value.trim().length > 0, 'A concrete description is required')
      .describe('The concrete expected result on the requested target.'),
    requirementId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional()
      .describe('Requirement covered by this check in the selected business procedure. Use the exact ID returned by the host.'),
    toolName: z.string().min(1).max(256).refine(value => value.trim().length > 0, 'An exact tool name is required')
      .describe('Exact callable observation tool name, e.g. Bash or mcp__service__get_status. The field is toolName, not verificationTool.'),
    input: z.record(z.string().min(1).max(256), AcceptanceScalar)
      .refine(input => Object.keys(input).length >= 1 && Object.keys(input).length <= 16,
        'input must contain 1–16 exact target selectors and expected scalar values')
      .meta({ minProperties: 1, maxProperties: 16 })
      .describe('Map of selectors in the observation tool arguments to exact expected values. Example: {"command":"cat /absolute/path/state.json"}. Use input, not targetInputs or a nested verification object.'),
    checks: z.array(z.object({
      path: z.string().min(1).max(256)
        .describe('Selector in the observed result: $.ready, $[0].status, or $text for the whole text output.'),
      equals: AcceptanceResultScalar,
    }).strict()).min(1).max(16)
      .describe('Every listed result check must match the same successful observation invocation.'),
  }).strict()).min(1).max(16)
    .describe('One to sixteen immutable criteria. Each item requires id, description, toolName, input and checks. A failed erroneous check can be replaced only by an explicit next-version criterion using supersedes.'),
}).strict().superRefine(({ criteria }, ctx) => {
  const ids = new Set<string>();
  criteria.forEach((criterion, index) => {
    if (ids.has(criterion.id)) ctx.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'Criterion IDs must be unique' });
    ids.add(criterion.id);
    const inputs = new Set<string>();
    for (const selector of Object.keys(criterion.input)) {
      const keys = completionCriterionPathKeys(selector);
      const identity = JSON.stringify(keys);
      if (!keys?.length || inputs.has(identity)) ctx.addIssue({
        code: 'custom', path: ['criteria', index, 'input'],
        message: 'Use unique nonempty property/index selectors; root, wildcards, expressions and prototype keys are not allowed',
      });
      inputs.add(identity);
    }
    const checks = new Set<string>();
    criterion.checks.forEach((check, checkIndex) => {
      const keys = check.path === '$text' ? ['$text'] : completionCriterionPathKeys(check.path);
      const identity = JSON.stringify(keys);
      if (keys === undefined || checks.has(identity)) ctx.addIssue({
        code: 'custom', path: ['criteria', index, 'checks', checkIndex, 'path'],
        message: 'Use unique simple property/index selectors, $ for a scalar root, or $text; expressions and prototype keys are not allowed',
      });
      if (check.path === '$text' && typeof check.equals !== 'string') ctx.addIssue({
        code: 'custom', path: ['criteria', index, 'checks', checkIndex, 'equals'],
        message: '$text requires an exact string value',
      });
      checks.add(identity);
    });
  });
});

/** Preserve scalar identity through Pi's JSON Schema argument validation. */
export function getCompletionCriteriaJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(SetCompletionCriteriaSchema, {
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema !== AcceptanceScalar && zodSchema !== AcceptanceResultScalar) return;
      // Pi tries anyOf alternatives with coercion in their listed order.
      // A string-first union changes 1/true/null into "1"/"true"/"" before
      // registration. A multi-type scalar accepts each original JSON type
      // without conversion. TypeBox applies maxLength to null in mixed-type
      // schemas, so the unchanged strict Zod host check enforces that bound.
      delete jsonSchema.anyOf;
      Object.assign(jsonSchema, {
        type: ['string', 'number', 'boolean', 'null'],
        description: [jsonSchema.description, 'String values are limited to 2048 characters; preserve the exact JSON scalar type.'].filter(Boolean).join(' '),
      });
    },
  }) as Record<string, unknown>;
}

export const SET_COMPLETION_CRITERIA_EXAMPLE = JSON.stringify({
  criteria: [{
    id: 'target-ready',
    description: 'The requested target reports ready',
    toolName: 'Bash',
    input: { command: 'cat /absolute/path/state.json' },
    checks: [{ path: '$.ready', equals: true }],
  }],
});

export const SET_COMPLETION_CRITERIA_FORMAT_HELP =
  `Exact argument shape: ${SET_COMPLETION_CRITERIA_EXAMPLE}. Replace the example tool, target and expected values with the actual requested check. Use toolName/input/checks, not verificationTool/targetInputs/verification. To correct a registered check only after its exact failed observation, add a next-version ID such as target-ready_v2 and supersedes:"target-ready"; the failed predecessor remains in host history. Repair only the registration arguments; do not repeat external actions to fix the schema.`;

/** Report structural locations, never raw target values or arbitrary input keys. */
export function completionCriteriaSchemaError(error: z.ZodError): string {
  const fields = new Set(['procedure', 'criteria', 'id', 'supersedes', 'requirementId', 'description', 'toolName', 'input', 'checks', 'path', 'equals']);
  return error.issues.slice(0, 6).map(issue => {
    const path: string[] = [];
    for (const part of issue.path) {
      if (typeof part === 'number') path.push(`[${part}]`);
      else if (typeof part === 'string' && fields.has(part)) path.push(`${path.length ? '.' : ''}${part}`);
      else break;
      if (part === 'input') break;
    }
    const message = issue.code === 'unrecognized_keys'
      ? 'Unsupported fields; use only the documented shape'
      : issue.message.slice(0, 180);
    return `${path.join('') || 'arguments'}: ${message}`;
  }).join('; ');
}
