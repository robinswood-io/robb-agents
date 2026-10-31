import { z } from 'zod';

/** Validate CDP metadata here; values returned by page scripts stay untrusted. */
const AXValueSchema = z.object({ value: z.unknown().optional() });
const AXNodeSchema = z.object({
  role: AXValueSchema.optional(), name: AXValueSchema.optional(),
  value: AXValueSchema.optional(), description: AXValueSchema.optional(),
  backendDOMNodeId: z.number().optional(),
  properties: z.array(z.object({ name: z.string(), value: AXValueSchema.optional() })).optional(),
});
const RuntimeResultSchema = z.object({
  result: z.object({ objectId: z.string().optional(), value: z.unknown().optional() }).optional(),
  exceptionDetails: z.unknown().optional(),
});
const AccessibilitySchema = z.object({ nodes: z.array(AXNodeSchema).optional() });
const ResolvedNodeSchema = z.object({ object: z.object({ objectId: z.string() }) });
const BoxModelSchema = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) });
const FrameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string().optional(), loaderId: z.string().optional() }).optional() }).optional(),
});
const IsolatedWorldSchema = z.object({ executionContextId: z.number() });
function ignoreResult(_value: unknown): void {}

const responseReaders = {
  'Accessibility.getFullAXTree': (value: unknown) => AccessibilitySchema.parse(value),
  'DOM.resolveNode': (value: unknown) => ResolvedNodeSchema.parse(value),
  'DOM.getBoxModel': (value: unknown) => BoxModelSchema.parse(value),
  'Page.getFrameTree': (value: unknown) => FrameTreeSchema.parse(value),
  'Page.createIsolatedWorld': (value: unknown) => IsolatedWorldSchema.parse(value),
  'Runtime.evaluate': (value: unknown) => RuntimeResultSchema.parse(value),
  'Runtime.callFunctionOn': (value: unknown) => RuntimeResultSchema.parse(value),
  'Runtime.releaseObject': ignoreResult,
  'Input.insertText': ignoreResult,
  'Input.dispatchKeyEvent': ignoreResult,
  'Input.dispatchMouseEvent': ignoreResult,
  'DOM.focus': ignoreResult,
  'DOM.setFileInputFiles': ignoreResult,
};
export type CDPCommandResponses = {
  [Method in keyof typeof responseReaders]: ReturnType<(typeof responseReaders)[Method]>;
};
const checkedReaders: {
  [Method in keyof CDPCommandResponses]: (value: unknown) => CDPCommandResponses[Method];
} = responseReaders;

export function parseCDPResponse<Method extends keyof CDPCommandResponses>(
  method: Method, value: unknown,
): CDPCommandResponses[Method] {
  return checkedReaders[method](value);
}

export interface SelectorGeometryReceipt {
  width: number;
  height: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  tag?: string;
  text?: string;
}
