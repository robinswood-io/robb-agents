import type { Api, Context, JsonObject, Model, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai';

import { normalizeContext, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';

type ImagePart = { inlineData: { mimeType: string; data: string } };
type CodeAssistPart =
  | { text: string }
  | ImagePart
  | { functionCall: { name: string; args: JsonObject } }
  | { functionResponse: { name: string; response: { error: string } | { output: string }; parts?: ImagePart[] } };
type CodeAssistContent = { role: 'user' | 'model'; parts: CodeAssistPart[] };

function sanitizeText(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function convertTools(tools?: Tool[]) {
  if (!tools?.length) return undefined;
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.parameters,
    })),
  }];
}

function convertMessages(model: Model<Api>, context: Context): CodeAssistContent[] {
  const contents: CodeAssistContent[] = [];

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
      const parts: CodeAssistPart[] = [];
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
      if (last?.role === 'user' && last.parts?.some(p => 'functionResponse' in p)) {
        last.parts.push(functionResponsePart);
      } else {
        contents.push({ role: 'user', parts: [functionResponsePart] });
      }
    }
  }

  return contents;
}

export function buildRequest(model: Model<Api>, context: Context, projectId: string | undefined, options?: SimpleStreamOptions) {
  const transcript = normalizeContext(context);
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const tools = getCurrentTools(transcript.messages);
  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig["temperature"] = options.temperature;
  if (options?.maxTokens !== undefined) generationConfig["maxOutputTokens"] = options.maxTokens;
  if (model.reasoning && options?.reasoning) {
    generationConfig["thinkingConfig"] = { includeThoughts: true };
  }

  return {
    model: model.id,
    project: projectId,
    user_prompt_id: `robinswood-${Date.now()}`,
    request: {
      contents: convertMessages(model, transcript),
      ...(systemPrompt ? { systemInstruction: { role: 'user', parts: [{ text: sanitizeText(systemPrompt) }] } } : {}),
      ...(tools.length ? { tools: convertTools(tools) } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(options?.sessionId ? { session_id: options.sessionId } : {}),
    },
  };
}
