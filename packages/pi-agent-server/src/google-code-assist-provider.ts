import type { Context, Model, SimpleStreamOptions, Tool, AssistantMessage, Usage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  assertUnstableProviderContractEnabled,
  getUnstableProviderContract,
  redactProviderDiagnostic,
} from '@craft-agent/core';

const PROVIDER = 'google-gemini-code-assist';
const API = 'google-code-assist';
const CODE_ASSIST_PROVIDER_CONTRACT = getUnstableProviderContract('google-code-assist-v1internal');
const CODE_ASSIST_BASE = CODE_ASSIST_PROVIDER_CONTRACT.endpoint.origin!;
const METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
};

interface CodeAssistUserData {
  projectId?: string;
  expiresAt: number;
}

const userDataCache = new Map<string, CodeAssistUserData>();

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function codeAssistFetch<T>(method: string, accessToken: string, body: unknown, signal?: AbortSignal, sse = false): Promise<T> {
  const res = await fetch(`${CODE_ASSIST_BASE}:${method}${sse ? '?alt=sse' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...CODE_ASSIST_PROVIDER_CONTRACT.staticHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Google Gemini Code Assist ${method} failed (${res.status}): ${redactProviderDiagnostic(text, [accessToken]).slice(0, 800)}`,
    );
  }

  return (sse ? res as T : await res.json() as T);
}

async function codeAssistGet<T>(operationName: string, accessToken: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${CODE_ASSIST_BASE}/${operationName}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...CODE_ASSIST_PROVIDER_CONTRACT.staticHeaders,
    },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Google Gemini Code Assist operation failed (${res.status}): ${redactProviderDiagnostic(text, [accessToken]).slice(0, 800)}`,
    );
  }
  return await res.json() as T;
}

function pickDefaultTier(loadRes: any): any | undefined {
  return loadRes?.allowedTiers?.find((tier: any) => tier?.isDefault) ?? loadRes?.allowedTiers?.[0];
}

async function ensureCodeAssistUser(accessToken: string, signal?: AbortSignal): Promise<CodeAssistUserData> {
  const cacheKey = accessToken.slice(0, 24);
  const cached = userDataCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
  if (envProject && /^\d+$/.test(envProject)) {
    throw new Error('GOOGLE_CLOUD_PROJECT must be the string project ID, not a numeric project number.');
  }

  const loadReq = {
    cloudaicompanionProject: envProject,
    metadata: { ...METADATA, duetProject: envProject },
  };
  let loadRes = await codeAssistFetch<any>('loadCodeAssist', accessToken, loadReq, signal);

  if (!loadRes?.currentTier) {
    const validationTier = loadRes?.ineligibleTiers?.find((tier: any) => tier?.validationUrl);
    if (validationTier?.validationUrl) {
      throw new Error(`Google account validation required before using Gemini Code Assist: ${validationTier.reasonMessage ?? validationTier.validationUrl}`);
    }

    const tier = pickDefaultTier(loadRes);
    if (!tier?.id) {
      const reasons = loadRes?.ineligibleTiers?.map((tier: any) => tier.reasonMessage).filter(Boolean).join(', ');
      throw new Error(reasons || 'Google Gemini Code Assist account is not eligible or no tier is available.');
    }

    const onboardReq = tier.id === 'FREE'
      ? { tierId: tier.id, cloudaicompanionProject: undefined, metadata: METADATA }
      : { tierId: tier.id, cloudaicompanionProject: envProject, metadata: { ...METADATA, duetProject: envProject } };

    let operation = await codeAssistFetch<any>('onboardUser', accessToken, onboardReq, signal);
    while (operation && !operation.done && operation.name) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      operation = await codeAssistGet<any>(operation.name, accessToken, signal);
    }

    const projectId = operation?.response?.cloudaicompanionProject?.id ?? envProject;
    loadRes = { currentTier: tier, cloudaicompanionProject: projectId };
  }

  const projectId = loadRes.cloudaicompanionProject || envProject;
  const data = { projectId, expiresAt: Date.now() + 30_000 };
  userDataCache.set(cacheKey, data);
  return data;
}

function sanitizeText(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function convertTools(tools?: Tool[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

function convertMessages(model: Model<any>, context: Context): any[] {
  const contents: any[] = [];

  for (const msg of context.messages) {
    if (msg.role === 'user') {
      const parts = typeof msg.content === 'string'
        ? [{ text: sanitizeText(msg.content) }]
        : msg.content.map(item => item.type === 'text'
          ? { text: sanitizeText(item.text) }
          : { inlineData: { mimeType: item.mimeType, data: item.data } });
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.trim()) {
          parts.push({ text: sanitizeText(block.text) });
        } else if (block.type === 'thinking' && block.thinking.trim()) {
          parts.push({ text: sanitizeText(block.thinking) });
        } else if (block.type === 'toolCall') {
          parts.push({ functionCall: { name: block.name, args: block.arguments ?? {} } });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    if (msg.role === 'toolResult') {
      const text = msg.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');
      const imageParts = model.input.includes('image')
        ? msg.content.filter(item => item.type === 'image').map(item => ({ inlineData: { mimeType: item.mimeType, data: item.data } }))
        : [];
      const responseValue = text || (imageParts.length ? '(see attached image)' : '');
      const functionResponsePart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: sanitizeText(responseValue) } : { output: sanitizeText(responseValue) },
          ...(imageParts.length ? { parts: imageParts } : {}),
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts?.some((p: any) => p.functionResponse)) {
        last.parts.push(functionResponsePart);
      } else {
        contents.push({ role: 'user', parts: [functionResponsePart] });
      }
    }
  }

  return contents;
}

function buildRequest(model: Model<any>, context: Context, projectId: string | undefined, options?: SimpleStreamOptions): any {
  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options?.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
  if (model.reasoning && options?.reasoning) {
    generationConfig.thinkingConfig = { includeThoughts: true };
  }

  return {
    model: model.id,
    project: projectId,
    user_prompt_id: `robinswood-${Date.now()}`,
    request: {
      contents: convertMessages(model, context),
      ...(context.systemPrompt ? { systemInstruction: { role: 'user', parts: [{ text: sanitizeText(context.systemPrompt) }] } } : {}),
      ...(context.tools?.length ? { tools: convertTools(context.tools) } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(options?.sessionId ? { session_id: options.sessionId } : {}),
    },
  };
}

function mapFinishReason(reason?: string): 'stop' | 'length' | 'toolUse' | 'error' {
  if (reason === 'MAX_TOKENS') return 'length';
  if (!reason || reason === 'STOP') return 'stop';
  return 'error';
}

async function* parseSse(res: Response): AsyncGenerator<any> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
      if (!data) continue;
      yield JSON.parse(data);
    }
  }
}

let toolCallCounter = 0;

export function streamGoogleCodeAssist(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: API,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      assertUnstableProviderContractEnabled('google-code-assist-v1internal', process.env);
      const accessToken = options?.apiKey;
      if (!accessToken) throw new Error('No Google OAuth access token for Gemini subscription connection.');
      const { projectId } = await ensureCodeAssistUser(accessToken, options?.signal);
      const request = buildRequest(model, context, projectId, options);
      const nextRequest = await options?.onPayload?.(request, model);
      const res = await codeAssistFetch<Response>('streamGenerateContent', accessToken, nextRequest ?? request, options?.signal, true);

      stream.push({ type: 'start', partial: output });
      let currentTextIndex: number | null = null;
      let currentText = '';
      const endText = () => {
        if (currentTextIndex !== null) {
          stream.push({ type: 'text_end', contentIndex: currentTextIndex, content: currentText, partial: output });
          currentTextIndex = null;
          currentText = '';
        }
      };

      for await (const chunk of parseSse(res)) {
        output.responseId ||= chunk.traceId;
        const response = chunk.response;
        const candidate = response?.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text !== undefined) {
            if (currentTextIndex === null) {
              output.content.push({ type: 'text', text: '' });
              currentTextIndex = output.content.length - 1;
              stream.push({ type: 'text_start', contentIndex: currentTextIndex, partial: output });
            }
            const textBlock = output.content[currentTextIndex] as { type: 'text'; text: string };
            textBlock.text += part.text;
            currentText += part.text;
            stream.push({ type: 'text_delta', contentIndex: currentTextIndex, delta: part.text, partial: output });
          }

          if (part.functionCall) {
            endText();
            const toolCall = {
              type: 'toolCall' as const,
              id: part.functionCall.id || `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`,
              name: part.functionCall.name || '',
              arguments: part.functionCall.args ?? {},
            };
            output.content.push(toolCall);
            const idx = output.content.length - 1;
            stream.push({ type: 'toolcall_start', contentIndex: idx, partial: output });
            stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: JSON.stringify(toolCall.arguments), partial: output });
            stream.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial: output });
          }
        }

        if (candidate?.finishReason) {
          output.stopReason = mapFinishReason(candidate.finishReason);
        }
        if (output.content.some(block => block.type === 'toolCall')) {
          output.stopReason = 'toolUse';
        }
        if (response?.usageMetadata) {
          const usage = response.usageMetadata;
          output.usage = {
            input: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
            output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
            cacheRead: usage.cachedContentTokenCount || 0,
            cacheWrite: 0,
            totalTokens: usage.totalTokenCount || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
      }

      endText();
      if (options?.signal?.aborted) throw new Error('Request was aborted');
      if (output.stopReason === 'error' || output.stopReason === 'aborted') throw new Error('Google Gemini Code Assist returned an error finish reason.');
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export function registerGoogleCodeAssistProvider(modelRegistry: ModelRegistry): void {
  modelRegistry.registerProvider(PROVIDER, {
    name: 'Google Gemini',
    baseUrl: CODE_ASSIST_BASE,
    apiKey: '$GOOGLE_GEMINI_CODE_ASSIST_ACCESS_TOKEN',
    api: API,
    streamSimple: streamGoogleCodeAssist,
    models: [
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        api: API,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        api: API,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        api: API,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
  });
}
