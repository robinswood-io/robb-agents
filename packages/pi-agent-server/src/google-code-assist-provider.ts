import type { Api, Context, Model, SimpleStreamOptions, AssistantMessage, Usage, AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { assertUnstableProviderContractEnabled } from '@craft-agent/core';
import { ensureCodeAssistUser } from './google-code-assist-auth.ts';
import { buildRequest } from './google-code-assist-request.ts';
import { CODE_ASSIST_BASE, codeAssistFetch, parseSse } from './google-code-assist-wire.ts';

const PROVIDER = 'google-gemini-code-assist';
const API = 'google-code-assist';

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

function mapFinishReason(reason?: string): 'stop' | 'length' | 'toolUse' | 'error' {
  if (reason === 'MAX_TOKENS') return 'length';
  if (!reason || reason === 'STOP') return 'stop';
  return 'error';
}

let toolCallCounter = 0;

export function streamGoogleCodeAssist(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: API,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'pending',
      timestamp: Date.now(),
    };

    try {
      assertUnstableProviderContractEnabled('google-code-assist-v1internal', process.env);
      const accessToken = options?.apiKey;
      if (!accessToken) throw new Error('No Google OAuth access token for Gemini subscription connection.');
      const { projectId } = await ensureCodeAssistUser(accessToken, options?.signal);
      const request = buildRequest(model, context, projectId, options);
      const nextRequest = await options?.onPayload?.(request, model);
      const res = await codeAssistFetch('streamGenerateContent', accessToken, nextRequest ?? request, options?.signal, true);

      stream.push({ type: 'start', partial: output });
      let currentTextIndex: number | null = null;
      let currentText = '';
      let currentThinkingIndex: number | null = null;
      let currentThinking = '';
      const endText = () => {
        if (currentTextIndex !== null) {
          stream.push({ type: 'text_end', contentIndex: currentTextIndex, content: currentText, partial: output });
          currentTextIndex = null;
          currentText = '';
        }
      };
      const endThinking = () => {
        if (currentThinkingIndex !== null) {
          stream.push({ type: 'thinking_end', contentIndex: currentThinkingIndex, content: currentThinking, partial: output });
          currentThinkingIndex = null;
          currentThinking = '';
        }
      };

      for await (const chunk of parseSse(res)) {
        output.responseId ||= chunk.traceId;
        const response = chunk.response;
        const candidate = response?.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (part.thought === true && typeof part.text === 'string') {
            endText();
            if (currentThinkingIndex === null) {
              output.content.push({
                type: 'thinking',
                thinking: '',
                ...(part.thoughtSignature ? { thinkingSignature: part.thoughtSignature } : {}),
              });
              currentThinkingIndex = output.content.length - 1;
              stream.push({ type: 'thinking_start', contentIndex: currentThinkingIndex, partial: output });
            }
            const thinkingBlock = output.content[currentThinkingIndex] as { type: 'thinking'; thinking: string; thinkingSignature?: string };
            thinkingBlock.thinking += part.text;
            if (part.thoughtSignature) thinkingBlock.thinkingSignature = part.thoughtSignature;
            currentThinking += part.text;
            stream.push({ type: 'thinking_delta', contentIndex: currentThinkingIndex, delta: part.text, partial: output });
            continue;
          }

          if (part.text !== undefined) {
            endThinking();
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
            endThinking();
            endText();
            const toolCall = {
              type: 'toolCall' as const,
              id: part.functionCall.id || `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`,
              name: part.functionCall.name || '',
              arguments: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
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

      endThinking();
      endText();
      if (options?.signal?.aborted) throw new Error('Request was aborted');
      if (output.stopReason === 'error' || output.stopReason === 'aborted' || output.stopReason === 'pending') throw new Error('Google Gemini Code Assist returned an error finish reason.');
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
        id: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash',
        api: API,
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview',
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
      {
        id: 'gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash Lite',
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
