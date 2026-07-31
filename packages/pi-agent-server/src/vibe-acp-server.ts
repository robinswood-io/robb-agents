#!/usr/bin/env node
/**
 * Mistral Vibe ACP bridge.
 *
 * Runs the official `vibe-acp` Agent Client Protocol server as a child process
 * and translates its ACP JSON-RPC stdio stream into the JSONL subprocess
 * protocol consumed by Robb's existing PiAgent client. Vibe owns its local
 * subscription credential; this bridge never reads or forwards it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

interface InitMessage {
  type: 'init';
  cwd: string;
  workingDirectory?: string;
  /** ACP session ID persisted by Robb as non-secret session metadata. */
  sdkSessionId?: string;
  model?: string;
}

type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt?: string }
  | { type: 'abort' }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'update_runtime_config'; id: string }
  | { type: 'register_tools'; tools: unknown[] }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify' }
  | { type: 'mini_completion'; id: string }
  | { type: 'llm_query'; id: string }
  | { type: 'steer'; message: string }
  | { type: 'token_update' }
  | { type: 'shutdown' };

type PermissionAction = 'allow' | 'block' | 'modify';

let vibeProcess: ChildProcess | null = null;
let acpConnection: any = null;
let acpSession: any = null;
let bridgeSessionId: string | null = null;
let activePrompt = false;
let promptQueue: Promise<void> = Promise.resolve();
const pendingPermissions = new Map<string, (action: PermissionAction) => void>();

const VIBE_SETUP_GUIDANCE = 'Install Mistral Vibe, then run vibe-acp --setup to sign in with your Mistral plan.';

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function debug(message: string): void {
  process.stderr.write(`[vibe-acp-server] ${message}\n`);
}

/**
 * Vibe owns authentication and may include sensitive context in its own errors.
 * Bridge diagnostics therefore use only static, actionable messages.
 */
function reportVibeError(code: string, message: string): void {
  send({ type: 'error', code, message });
}

function clearVibeState(): void {
  for (const resolve of pendingPermissions.values()) resolve('block');
  pendingPermissions.clear();
  activePrompt = false;
  acpSession = null;
  acpConnection = null;
  bridgeSessionId = null;
  vibeProcess = null;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function textFromContent(content: any): string {
  if (!content || typeof content !== 'object') return '';
  return content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

function emitEvent(event: Record<string, unknown>): void {
  send({ type: 'event', event });
}

function selectPermissionOption(options: any[], action: PermissionAction): string | undefined {
  if (action === 'allow' || action === 'modify') {
    return options.find(option => option?.kind === 'allow_once')?.optionId
      ?? options.find(option => option?.kind === 'allow_always')?.optionId;
  }
  return options.find(option => option?.kind === 'reject_once')?.optionId
    ?? options.find(option => option?.kind === 'reject_always')?.optionId;
}

async function waitForPermission(params: any): Promise<any> {
  const requestId = randomId('vibe-permission');
  const toolCall = params.toolCall ?? {};
  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: toolCall.title || toolCall.kind || 'Mistral Vibe tool',
    toolCallId: toolCall.toolCallId,
    input: typeof toolCall.rawInput === 'object' && toolCall.rawInput ? toolCall.rawInput : {},
  });

  const action = await new Promise<PermissionAction>((resolve) => {
    pendingPermissions.set(requestId, resolve);
  });
  const optionId = selectPermissionOption(params.options ?? [], action);
  if (!optionId) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}

async function startVibe(init: InitMessage): Promise<void> {
  if (acpSession) return;

  const command = process.env.ROBB_VIBE_ACP_COMMAND || 'vibe-acp';
  const cwd = init.workingDirectory || init.cwd || process.cwd();
  debug('Launching official Vibe ACP command.');

  const child = spawn(command, [], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  vibeProcess = child;
  const launched = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });

  child.once('error', () => {
    reportVibeError('MISTRAL_VIBE_UNAVAILABLE', `Mistral Vibe ACP could not launch. ${VIBE_SETUP_GUIDANCE}`);
    clearVibeState();
  });
  // Do not relay Vibe stderr: it is Vibe-owned and may contain sensitive context.
  child.stderr?.on('data', () => debug('Official Vibe ACP emitted stderr; details remain in Vibe-owned logs.'));
  child.on('exit', () => {
    const wasActive = activePrompt;
    clearVibeState();
    if (wasActive) {
      reportVibeError('MISTRAL_VIBE_EXITED', 'Mistral Vibe stopped before the turn completed. Start a new turn after Vibe is available again.');
      emitEvent({ type: 'agent_end' });
    }
  });

  // Do not start ACP negotiation until the OS has confirmed the executable.
  // This prevents a launch failure from also surfacing as a second protocol error.
  if (!await launched) return;

  const app: any = client({ name: 'Robb Agents' });
  app.onRequest(methods.client.session.requestPermission, async ({ params }: any) => waitForPermission(params));

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
  );
  acpConnection = app.connect(stream);

  const initializeResult = await acpConnection.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // Vibe executes its own native file and terminal tools. Robb advertises
      // permission handling, but deliberately does not expose its filesystem
      // or terminal RPC as a second execution surface.
      session: {},
      plan: {},
    },
    clientInfo: { name: 'Robb Agents', version: '0.11.5' },
  });

  // ACP session IDs are non-secret conversation metadata. Reuse the existing
  // Robb sdkSessionId only if Vibe explicitly advertises official load support;
  // otherwise create a fresh Vibe session and let the normal callback persist it.
  const canLoadSession = Boolean((initializeResult as any)?.agentCapabilities?.loadSession);
  if (init.sdkSessionId && canLoadSession) {
    try {
      const restored = await acpConnection.agent.request(methods.agent.session.load, {
        sessionId: init.sdkSessionId,
        cwd,
        mcpServers: [],
      });
      acpSession = (acpConnection.agent as any).attachSession({
        sessionId: init.sdkSessionId,
        ...(restored as object),
      });
      debug(`Restored official Vibe ACP session ${init.sdkSessionId}`);
    } catch (error) {
      debug(`Could not restore Vibe ACP session; creating a new session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!acpSession) acpSession = await acpConnection.agent.buildSession(cwd).start();
  bridgeSessionId = String(acpSession.sessionId);
  send({ type: 'ready', sessionId: bridgeSessionId, callbackPort: 0 });
}

function emitToolUpdate(update: any): void {
  const toolCallId = String(update.toolCallId || randomId('vibe-tool'));
  if (update.sessionUpdate === 'tool_call') {
    emitEvent({
      type: 'tool_execution_start',
      toolCallId,
      toolName: update.title || update.kind || 'Mistral Vibe tool',
      args: typeof update.rawInput === 'object' && update.rawInput ? update.rawInput : {},
    });
    if (update.status === 'completed' || update.status === 'failed') {
      emitEvent({
        type: 'tool_execution_end',
        toolCallId,
        toolName: update.title || update.kind || 'Mistral Vibe tool',
        result: { content: [{ type: 'text', text: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? '') }] },
        isError: update.status === 'failed',
      });
    }
    return;
  }

  if (update.sessionUpdate === 'tool_call_update' && (update.status === 'completed' || update.status === 'failed')) {
    emitEvent({
      type: 'tool_execution_end',
      toolCallId,
      toolName: update.title || update.kind || 'Mistral Vibe tool',
      result: { content: [{ type: 'text', text: typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput ?? '') }] },
      isError: update.status === 'failed',
    });
  }
}

async function runPrompt(message: string): Promise<void> {
  if (!acpSession) throw new Error('Mistral Vibe ACP session is not initialized');
  activePrompt = true;
  try {
  let text = '';
  let sdkMessageId: string | undefined;
  emitEvent({ type: 'agent_start' });
  emitEvent({ type: 'turn_start' });

  const promptResult = acpSession.prompt(message);
  while (true) {
    const next = await acpSession.nextUpdate();
    if (next.kind === 'stop') break;

    const update = next.update;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const delta = textFromContent(update.content);
      if (delta) {
        text += delta;
        sdkMessageId = update.messageId ?? sdkMessageId;
        emitEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const delta = textFromContent(update.content);
      if (delta) emitEvent({ type: 'thinking_delta', delta });
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      emitToolUpdate(update);
    } else if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number') {
      emitEvent({ type: 'usage_update', usage: { input: update.used, contextWindow: 262144 } });
    }
  }
  await promptResult;

  emitEvent({
    type: 'message_end',
    sdkMessageId,
    message: {
      id: sdkMessageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
    },
  });
  emitEvent({ type: 'turn_end' });
  emitEvent({ type: 'agent_end' });
  } finally {
    activePrompt = false;
  }
}

async function handle(message: InboundMessage): Promise<void> {
  switch (message.type) {
    case 'init':
      await startVibe(message);
      return;
    case 'prompt':
      promptQueue = promptQueue.then(() => runPrompt(message.message)).catch(() => {
        reportVibeError('MISTRAL_VIBE_PROMPT_FAILED', 'Mistral Vibe could not complete this turn. Confirm that Vibe is available and start a new turn.');
        emitEvent({ type: 'agent_end' });
      });
      return;
    case 'abort':
      if (acpConnection && bridgeSessionId) {
        await acpConnection.agent.notify(methods.agent.session.cancel, { sessionId: bridgeSessionId });
      }
      return;
    case 'set_model':
      if (acpConnection && bridgeSessionId && message.model !== 'pi/mistral-vibe') {
        await acpConnection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: bridgeSessionId,
          configId: 'model',
          value: message.model.replace(/^pi\//, ''),
        }).catch(() => undefined);
      }
      return;
    case 'ensure_session_ready':
      send({ type: 'ensure_session_ready_result', id: message.id, sessionId: bridgeSessionId });
      return;
    case 'set_auto_compaction':
      // ACP does not standardize compaction. Keep the capability disabled rather
      // than claiming a Vibe-side behavior we cannot verify.
      send({ type: 'set_auto_compaction_result', id: message.id, success: false, enabled: false, errorMessage: 'Mistral Vibe ACP does not expose compaction controls.' });
      return;
    case 'compact':
      send({ type: 'compact_result', id: message.id, success: false, errorMessage: 'Mistral Vibe ACP does not expose manual compaction.' });
      return;
    case 'update_runtime_config':
      send({ type: 'update_runtime_config_result', id: message.id, success: true, updated: false });
      return;
    case 'pre_tool_use_response': {
      const resolve = pendingPermissions.get(message.requestId);
      if (resolve) {
        pendingPermissions.delete(message.requestId);
        resolve(message.action);
      }
      return;
    }
    case 'mini_completion':
      send({ type: 'mini_completion_result', id: message.id, text: null });
      return;
    case 'llm_query':
      send({ type: 'llm_query_result', id: message.id, result: null, errorMessage: 'Mistral Vibe does not expose Robb call_llm submodels.' });
      return;
    case 'shutdown':
      acpConnection?.close();
      vibeProcess?.kill();
      clearVibeState();
      process.exit(0);
      return;
    case 'register_tools':
    case 'set_thinking_level':
    case 'steer':
    case 'token_update':
      return;
  }
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
readline.on('line', (line) => {
  try {
    void handle(JSON.parse(line) as InboundMessage).catch(() => {
      reportVibeError('MISTRAL_VIBE_BRIDGE_ERROR', 'Mistral Vibe ACP could not process this request. Confirm its setup, then try again.');
    });
  } catch {
    reportVibeError('MISTRAL_VIBE_INVALID_MESSAGE', 'Robb received an invalid Mistral Vibe bridge message. Start a new session and try again.');
  }
});
