import { z } from 'zod';
import { getUnstableProviderContract, redactProviderDiagnostic } from '@craft-agent/core';

const contract = getUnstableProviderContract('google-code-assist-v1internal');
export const CODE_ASSIST_BASE = contract.endpoint.origin!;
const CODE_ASSIST_LICENSE_REQUIRED = 'Google Gemini Code Assist did not confirm an active Standard or Enterprise license for this organization account. Ask your Google Cloud administrator to assign the license to the signed-in account, then sign in again. GOOGLE_CLOUD_PROJECT must identify a project in that organization. Individual accounts should use a Google AI Studio API key in Robb Agents.';

const tierSchema = z.object({
  id: z.string().optional(), isDefault: z.boolean().optional(),
  userDefinedCloudaicompanionProject: z.boolean().optional(),
  reasonMessage: z.string().optional(), validationUrl: z.string().optional(),
});
export const codeAssistLoadSchema = z.object({
  currentTier: tierSchema.nullish(), allowedTiers: z.array(tierSchema).optional(),
  ineligibleTiers: z.array(tierSchema).optional(), cloudaicompanionProject: z.string().nullish(),
});
export type CodeAssistTier = z.infer<typeof tierSchema>;
export type CodeAssistLoadResponse = z.infer<typeof codeAssistLoadSchema>;
export const codeAssistOperationSchema = z.object({
  done: z.boolean().optional(), name: z.string().optional(), error: z.unknown().optional(),
  response: z.object({ cloudaicompanionProject: z.object({ id: z.string().optional() }).optional() }).optional(),
});
const streamChunkSchema = z.object({
  traceId: z.string().optional(),
  response: z.object({
    candidates: z.array(z.object({
      finishReason: z.string().optional(),
      content: z.object({ parts: z.array(z.object({
        text: z.string().optional(), thought: z.boolean().optional(), thoughtSignature: z.string().optional(),
        functionCall: z.object({ id: z.string().optional(), name: z.string(),
          args: z.record(z.string(), z.json()).optional() }).optional(),
      })) }).optional(),
    })).optional(),
    usageMetadata: z.object({
      promptTokenCount: z.number().optional(), cachedContentTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(), thoughtsTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    }).optional(),
  }).optional(),
});

export async function codeAssistFetch(method: string, accessToken: string, body: unknown, signal?: AbortSignal, sse = false): Promise<Response> {
  const res = await fetch(`${CODE_ASSIST_BASE}:${method}${sse ? '?alt=sse' : ''}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...contract.staticHeaders,
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (res.status === 403 && /SUBSCRIPTION_REQUIRED|do not have a valid license|#3501/i.test(text)) {
      throw new Error(CODE_ASSIST_LICENSE_REQUIRED);
    }
    throw new Error(
      `Google Gemini Code Assist ${method} failed (${res.status}): ${redactProviderDiagnostic(text, [accessToken]).slice(0, 800)}`,
    );
  }

  return res;
}

export async function codeAssistGet(operationName: string, accessToken: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${CODE_ASSIST_BASE}/${operationName}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...contract.staticHeaders,
    },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Google Gemini Code Assist operation failed (${res.status}): ${redactProviderDiagnostic(text, [accessToken]).slice(0, 800)}`,
    );
  }
  return await res.json();
}

export async function codeAssistJson(method: string, token: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return (await codeAssistFetch(method, token, body, signal)).json();
}

/** Decode complete SSE frames, including a final frame without a blank line. */
export async function* parseSse(res: Response): AsyncGenerator<z.infer<typeof streamChunkSchema>> {
  if (!res.body) throw new Error('Google Code Assist returned an empty stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function parseFrame(raw: string) {
    const data = raw.split('\n').filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim()).join('\n');
    return data && data !== '[DONE]' ? streamChunkSchema.parse(JSON.parse(data)) : undefined;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const chunk = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (chunk) yield chunk;
      }
      if (done) {
        const chunk = parseFrame(buffer);
        if (chunk) yield chunk;
        break;
      }
    }
  } finally { reader.releaseLock(); }
}
