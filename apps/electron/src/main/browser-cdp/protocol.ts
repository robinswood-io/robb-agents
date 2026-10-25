/** The CDP response fields consumed by this client. Page script values remain untrusted. */
interface AXValue {
  value?: unknown;
}

interface AXNode {
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  backendDOMNodeId?: number;
  properties?: Array<{ name: string; value?: AXValue }>;
}

interface RemoteObject {
  objectId?: string;
  value?: unknown;
}

interface RuntimeResult {
  result?: RemoteObject;
  exceptionDetails?: unknown;
}

export interface CDPCommandResponses {
  'Accessibility.getFullAXTree': { nodes?: AXNode[] };
  'DOM.resolveNode': { object: { objectId: string } };
  'DOM.getBoxModel': { model: { content: number[] } };
  'Page.getFrameTree': { frameTree?: { frame?: { id?: string; loaderId?: string } } };
  'Page.createIsolatedWorld': { executionContextId: number };
  'Runtime.evaluate': RuntimeResult;
  'Runtime.callFunctionOn': RuntimeResult;
  'Runtime.releaseObject': void;
  'Input.insertText': void;
  'Input.dispatchKeyEvent': void;
  'Input.dispatchMouseEvent': void;
  'DOM.focus': void;
  'DOM.setFileInputFiles': void;
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
