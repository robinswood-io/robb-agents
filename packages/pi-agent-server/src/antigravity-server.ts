#!/usr/bin/env node
/**
 * Google Antigravity CLI bridge.
 *
 * Runs the official `agy` headless agent as a child process and translates its
 * documented NDJSON stream into the JSONL subprocess protocol consumed by
 * Robb's PiAgent client. Antigravity owns the Google account credential in the
 * OS keyring; this bridge never reads or forwards it.
 */

import type { ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import {
  resolveAntigravityCommand,
  spawnAntigravitySubprocess,
} from './antigravity-subprocess.ts';

interface InitMessage {
  type: 'init';
  cwd: string;
  workingDirectory?: string;
  sdkSessionId?: string;
  model?: string;
  thinkingLevel?: string;
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

interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface ActiveTurn {
  text: string;
  sdkMessageId?: string;
  toolStarts: Set<string>;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

const SETUP_GUIDANCE = 'Install the official Antigravity CLI, run `agy`, and sign in with your Google account.';

let initConfig: InitMessage | null = null;
let antigravityProcess: ChildProcess | null = null;
let antigravityReadline: ReadlineInterface | null = null;
let bridgeSessionId: string | null = null;
let activeTurn: ActiveTurn | null = null;
let promptQueue: Promise<void> = Promise.resolve();
let sentSystemPrompt = false;
let expectedExit = false;
let runtimeRestartPending = false;
let lastCumulativeUsage: Required<AntigravityUsage> = emptyUsage();

function emptyUsage(): Required<AntigravityUsage> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  };
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function debug(message: string): void {
  process.stderr.write(`[antigravity-server] ${message}\n`);
}

function emitEvent(event: Record<string, unknown>): void {
  send({ type: 'event', event });
}

function reportError(code: string, message: string): void {
  send({ type: 'error', code, message });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numericValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeUsage(value: unknown): Required<AntigravityUsage> {
  const usage = asRecord(value);
  return {
    input_tokens: numericValue(usage?.input_tokens),
    output_tokens: numericValue(usage?.output_tokens),
    thinking_tokens: numericValue(usage?.thinking_tokens),
    cache_read_tokens: numericValue(usage?.cache_read_tokens),
    total_tokens: numericValue(usage?.total_tokens),
  };
}

function perTurnUsage(cumulativeValue: unknown): Required<AntigravityUsage> {
  const cumulative = normalizeUsage(cumulativeValue);
  const previous = lastCumulativeUsage;
  lastCumulativeUsage = cumulative;
  return {
    input_tokens: Math.max(0, cumulative.input_tokens - previous.input_tokens),
    output_tokens: Math.max(0, cumulative.output_tokens - previous.output_tokens),
    thinking_tokens: Math.max(0, cumulative.thinking_tokens - previous.thinking_tokens),
    cache_read_tokens: Math.max(0, cumulative.cache_read_tokens - previous.cache_read_tokens),
    total_tokens: Math.max(0, cumulative.total_tokens - previous.total_tokens),
  };
}

function captureSessionId(value: unknown): void {
  const sessionId = stringValue(value);
  if (!sessionId || sessionId === bridgeSessionId) return;
  bridgeSessionId = sessionId;
  if (initConfig) initConfig.sdkSessionId = sessionId;
  send({ type: 'session_id_update', sessionId });
}

function toolCallId(update: Record<string, unknown>): string {
  const index = typeof update.step_index === 'number' ? update.step_index : Date.now();
  return `antigravity-${bridgeSessionId ?? 'pending'}-${index}`;
}

function toolOutput(toolInfo: Record<string, unknown> | undefined): unknown {
  return toolInfo?.output ?? toolInfo?.result ?? '';
}

function emitToolUpdate(update: Record<string, unknown>, turn: ActiveTurn): void {
  const toolInfo = asRecord(update.tool_info);
  const id = toolCallId(update);
  const toolName = stringValue(update.tool_name)
    ?? stringValue(toolInfo?.name)
    ?? 'Google Antigravity tool';
  const state = String(update.state ?? '').toUpperCase();

  if (!turn.toolStarts.has(id)) {
    turn.toolStarts.add(id);
    emitEvent({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName,
      args: asRecord(toolInfo?.parameters) ?? {},
    });
  }

  if (state === 'DONE' || state === 'FAILED' || state === 'ERROR' || state === 'CANCELED') {
    const output = toolOutput(toolInfo);
    emitEvent({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName,
      result: {
        content: [{
          type: 'text',
          text: typeof output === 'string' ? output : JSON.stringify(output),
        }],
      },
      isError: state !== 'DONE',
    });
  }
}

function handleAntigravityEvent(message: Record<string, unknown>): void {
  if (message.event === 'init') {
    captureSessionId(message.conversation_id ?? asRecord(message.init)?.conversation_id);
    return;
  }

  const turn = activeTurn;
  if (!turn) return;

  if (message.event === 'step_update') {
    const update = asRecord(message.step_update);
    if (!update) return;
    captureSessionId(update.conversation_id);
    const stepType = stringValue(update.step_type);
    const delta = stringValue(update.text_delta);
    if (stepType === 'agent_response' && delta) {
      turn.text += delta;
      emitEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
    } else if ((stepType === 'agent_thought' || stepType === 'thinking') && delta) {
      emitEvent({ type: 'thinking_delta', delta });
    } else if (stepType === 'tool') {
      emitToolUpdate(update, turn);
    }
    return;
  }

  if (message.event === 'result') {
    const result = asRecord(message.result) ?? {};
    captureSessionId(result.conversation_id);
    turn.resolve(result);
  }
}

function classifyResultError(result: Record<string, unknown>): { code: string; message: string } {
  const detail = String(result.error ?? '').toLowerCase();
  if (detail.includes('authentication required') || detail.includes('sign in')) {
    return {
      code: 'GOOGLE_ANTIGRAVITY_AUTH_REQUIRED',
      message: `Google Antigravity is not signed in. ${SETUP_GUIDANCE}`,
    };
  }
  if (detail.includes('quota') || detail.includes('license') || detail.includes('subscription')) {
    return {
      code: 'GOOGLE_ANTIGRAVITY_ENTITLEMENT_REQUIRED',
      message: 'This Google account does not currently have usable Antigravity quota. Check the account plan or organization assignment in Antigravity.',
    };
  }
  return {
    code: 'GOOGLE_ANTIGRAVITY_PROMPT_FAILED',
    message: 'Google Antigravity could not complete this turn. Check the Antigravity CLI status, then try again.',
  };
}

function mapEffort(level: string | undefined): string | undefined {
  if (!level || level === 'off') return undefined;
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  return 'high';
}

function selectedModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const bare = model.replace(/^pi\//, '');
  return bare === 'google-antigravity' ? undefined : bare;
}

async function startAntigravity(init: InitMessage): Promise<void> {
  if (antigravityProcess?.stdin?.writable) return;

  const cwd = init.workingDirectory || init.cwd || process.cwd();
  const command = resolveAntigravityCommand(process.env);
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--sandbox',
    '--disable-slash-commands',
  ];
  if (init.sdkSessionId) {
    args.push('--conversation', init.sdkSessionId);
  } else {
    // Antigravity otherwise reuses its last/default CLI project. That project
    // can point at a different directory, causing ordinary workspace reads to
    // be treated as out-of-scope and soft-denied in headless mode.
    args.push('--new-project');
  }
  const model = selectedModel(init.model);
  if (model) args.push('--model', model);
  // Current Antigravity model slugs already encode their supported effort
  // (for example gemini-3.7-flash-low). Only add the generic effort flag for
  // future/default model selectors that do not carry an explicit suffix.
  const modelHasEffort = /-(?:low|medium|high)$/.test(model ?? '');
  const effort = modelHasEffort ? undefined : mapEffort(init.thinkingLevel);
  if (effort) args.push('--effort', effort);

  debug('Launching the official Google Antigravity CLI in sandboxed headless mode.');
  const child = spawnAntigravitySubprocess(command, cwd, { args });
  antigravityProcess = child;
  expectedExit = false;

  const launched = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  child.once('error', () => {
    if (!expectedExit) {
      reportError('GOOGLE_ANTIGRAVITY_UNAVAILABLE', `Google Antigravity CLI could not launch. ${SETUP_GUIDANCE}`);
    }
  });
  child.stderr?.on('data', () => {
    // Antigravity-owned diagnostics can contain account or workspace context.
    // Drain them without forwarding their contents into Robb logs.
    debug('The official Antigravity CLI emitted a private diagnostic.');
  });
  child.on('exit', () => {
    const pending = activeTurn;
    activeTurn = null;
    antigravityReadline?.close();
    antigravityReadline = null;
    antigravityProcess = null;
    sentSystemPrompt = false;
    lastCumulativeUsage = emptyUsage();
    if (pending) {
      pending.reject(new Error('Antigravity exited before returning a result'));
    }
  });

  if (!await launched) {
    antigravityProcess = null;
    throw new Error('Antigravity CLI is unavailable');
  }
  if (!child.stdout || !child.stdin) throw new Error('Antigravity CLI streams are unavailable');

  antigravityReadline = createInterface({ input: child.stdout, crlfDelay: Infinity });
  antigravityReadline.on('line', (line) => {
    try {
      const message = JSON.parse(line) as unknown;
      const record = asRecord(message);
      if (record) handleAntigravityEvent(record);
    } catch {
      debug('Ignored an invalid line from the Antigravity NDJSON stream.');
    }
  });
}

async function stopAntigravity(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const child = antigravityProcess;
  if (!child) return;
  expectedExit = true;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    timeout.unref?.();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill(signal);
  });
}

function buildPrompt(message: string, systemPrompt?: string): string {
  if (sentSystemPrompt || !systemPrompt?.trim()) return message;
  sentSystemPrompt = true;
  return [
    '<robb_system_instructions>',
    systemPrompt.trim(),
    '</robb_system_instructions>',
    '<user_request>',
    message,
    '</user_request>',
  ].join('\n');
}

async function runPrompt(message: string, systemPrompt?: string): Promise<void> {
  if (!initConfig) throw new Error('Google Antigravity bridge is not initialized');
  if (runtimeRestartPending) {
    await stopAntigravity();
    runtimeRestartPending = false;
  }
  await startAntigravity(initConfig);
  const child = antigravityProcess;
  if (!child?.stdin?.writable) throw new Error('Google Antigravity stdin is unavailable');

  emitEvent({ type: 'agent_start' });
  emitEvent({ type: 'turn_start' });

  let resolveResult!: (result: Record<string, unknown>) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  activeTurn = {
    text: '',
    toolStarts: new Set(),
    resolve: resolveResult,
    reject: rejectResult,
  };

  child.stdin.write(`${JSON.stringify({
    event: 'user',
    message: { content: buildPrompt(message, systemPrompt) },
  })}\n`);

  try {
    const result = await resultPromise;
    const status = String(result.status ?? '').toUpperCase();
    if (status !== 'SUCCESS') {
      const classified = classifyResultError(result);
      reportError(classified.code, classified.message);
      emitEvent({ type: 'agent_end' });
      return;
    }

    const turn = activeTurn;
    const text = stringValue(result.response) ?? turn?.text ?? '';
    const usage = perTurnUsage(result.usage);
    const sdkMessageId = `antigravity-message-${Date.now()}`;
    emitEvent({
      type: 'message_end',
      sdkMessageId,
      message: {
        id: sdkMessageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        usage: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_tokens,
          cacheWrite: 0,
          totalTokens: usage.total_tokens,
          // Antigravity account/subscription usage has no API price exposed by
          // the official CLI. Pi's adapter still requires the complete cost
          // object when aggregating a finished turn.
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        provider: 'google-antigravity',
      },
    });
    emitEvent({ type: 'turn_end' });
    emitEvent({ type: 'agent_end' });
  } finally {
    activeTurn = null;
  }
}

async function handle(message: InboundMessage): Promise<void> {
  switch (message.type) {
    case 'init':
      initConfig = message;
      bridgeSessionId = message.sdkSessionId ?? null;
      await startAntigravity(message);
      send({ type: 'ready', sessionId: bridgeSessionId, callbackPort: 0 });
      return;
    case 'prompt':
      promptQueue = promptQueue.then(
        () => runPrompt(message.message, message.systemPrompt),
        () => runPrompt(message.message, message.systemPrompt),
      ).catch(() => {
        reportError('GOOGLE_ANTIGRAVITY_PROMPT_FAILED', 'Google Antigravity stopped before the turn completed. Confirm that `agy` is signed in, then try again.');
        emitEvent({ type: 'agent_end' });
      });
      return;
    case 'abort':
      await stopAntigravity('SIGINT');
      return;
    case 'set_model':
      if (initConfig && initConfig.model !== message.model) {
        initConfig.model = message.model;
        runtimeRestartPending = true;
        if (!activeTurn) {
          await stopAntigravity();
          runtimeRestartPending = false;
        }
      }
      return;
    case 'set_thinking_level':
      if (initConfig && initConfig.thinkingLevel !== message.level) {
        initConfig.thinkingLevel = message.level;
        runtimeRestartPending = true;
        if (!activeTurn) {
          await stopAntigravity();
          runtimeRestartPending = false;
        }
      }
      return;
    case 'ensure_session_ready':
      send({ type: 'ensure_session_ready_result', id: message.id, sessionId: bridgeSessionId });
      return;
    case 'set_auto_compaction':
      send({ type: 'set_auto_compaction_result', id: message.id, success: false, enabled: false, errorMessage: 'Google Antigravity manages its own context.' });
      return;
    case 'compact':
      send({ type: 'compact_result', id: message.id, success: false, errorMessage: 'Google Antigravity manages its own context.' });
      return;
    case 'update_runtime_config':
      send({ type: 'update_runtime_config_result', id: message.id, success: true, updated: false });
      return;
    case 'mini_completion':
      send({ type: 'mini_completion_result', id: message.id, text: null });
      return;
    case 'llm_query':
      send({ type: 'llm_query_result', id: message.id, result: null, errorMessage: 'Google Antigravity does not expose Robb call_llm submodels.' });
      return;
    case 'shutdown':
      await stopAntigravity();
      process.exit(0);
      return;
    case 'register_tools':
    case 'pre_tool_use_response':
    case 'steer':
    case 'token_update':
      return;
  }
}

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
readline.on('line', (line) => {
  try {
    void handle(JSON.parse(line) as InboundMessage).catch(() => {
      reportError('GOOGLE_ANTIGRAVITY_BRIDGE_ERROR', 'Google Antigravity could not process this request. Confirm its setup, then try again.');
    });
  } catch {
    reportError('GOOGLE_ANTIGRAVITY_INVALID_MESSAGE', 'Robb received an invalid Google Antigravity bridge message. Start a new session and try again.');
  }
});
