const CRAFT_DISPLAY_NAME_KEY = '_displayName';
const CRAFT_INTENT_KEY = '_intent';

const CRAFT_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: human-friendly action name for display only.',
};

const CRAFT_INTENT_SCHEMA = {
  type: 'string',
  description: 'Craft UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * Return a Pi tool schema that accepts Craft's root-level metadata fields.
 *
 * Pi validates tool arguments before Craft's pre-tool-use hook can strip
 * `_displayName` / `_intent`. Built-in Pi tools often use strict schemas with
 * `additionalProperties: false`, so we add those fields as optional root
 * properties at the adapter boundary. Unknown schema shapes are returned
 * unchanged, and upstream-defined metadata properties win if Pi adds them later.
 */
export function allowCraftMetadataProperties<T>(schema: T, sdkToolName?: string): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(CRAFT_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[CRAFT_DISPLAY_NAME_KEY] = CRAFT_DISPLAY_NAME_SCHEMA;
  }
  if (!(CRAFT_INTENT_KEY in nextProperties)) {
    nextProperties[CRAFT_INTENT_KEY] = CRAFT_INTENT_SCHEMA;
  }

  // Pi's Edit schema uses { path, edits: [{ oldText, newText }] }, while the
  // shared Craft contract and older resumed turns use
  // { file_path, old_string, new_string }. Validation runs before execute(),
  // so both shapes must be accepted at the schema boundary and normalized
  // immediately before calling Pi.
  if (sdkToolName === 'Edit') {
    nextProperties.file_path ??= { type: 'string', description: 'Compatibility alias for path.' };
    nextProperties.old_string ??= { type: 'string', description: 'Compatibility alias for edits[0].oldText.' };
    nextProperties.new_string ??= { type: 'string', description: 'Compatibility alias for edits[0].newText.' };

    Object.defineProperty(nextSchema, 'required', {
      value: [],
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(nextSchema, 'anyOf', {
      value: [
        { required: ['path', 'edits'] },
        { required: ['file_path', 'old_string', 'new_string'] },
      ],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** Convert Craft-compatible file arguments back to the strict Pi SDK shape. */
export function normalizeForPiTool<T>(sdkToolName: string, input: T): T {
  if (!isRecord(input)) return input;
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(sdkToolName)) return input;

  const normalized: Record<string, unknown> = { ...input };
  if (typeof normalized.file_path === 'string') {
    normalized.path = normalized.file_path;
  }

  if (sdkToolName === 'Edit' && !Array.isArray(normalized.edits)
      && typeof normalized.old_string === 'string'
      && typeof normalized.new_string === 'string') {
    normalized.edits = [{ oldText: normalized.old_string, newText: normalized.new_string }];
  }

  delete normalized.file_path;
  delete normalized.old_string;
  delete normalized.new_string;
  delete normalized.oldText;
  delete normalized.newText;
  return normalized as T;
}

/** Strip Craft-only metadata before invoking the upstream Pi tool implementation. */
export function stripCraftMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(CRAFT_DISPLAY_NAME_KEY in input) && !(CRAFT_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[CRAFT_DISPLAY_NAME_KEY];
  delete cleanInput[CRAFT_INTENT_KEY];

  return cleanInput as T;
}
