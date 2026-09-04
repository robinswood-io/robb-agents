# Search Payload Contract

Last updated: 2026-09-04

This file documents the **known-good request shape** for provider-native web search calls in `pi-agent-server`.

## ChatGPT backend (openai-codex)

Implementation: [providers/chatgpt.ts](./providers/chatgpt.ts)

Endpoint:
- `POST https://chatgpt.com/backend-api/codex/responses`

Required headers:
- `Authorization: Bearer <oauth-access-token>`
- `chatgpt-account-id: <JWT claim https://api.openai.com/auth.chatgpt_account_id>`
- `OpenAI-Beta: responses=experimental`
- `Content-Type: application/json`

Known-good body fields for search:
- `model: "gpt-5.4-mini"`
- `store: false`
- `stream: true`
- `instructions: string`
- `tools: [{ type: "web_search" }]`
- `tool_choice: "auto"`
- `parallel_tool_calls: true`
- `text: { verbosity: "medium" }`
- `input: [{ role, content: [{ type: "input_text", text }] }]`

### Why `stream: true` here?
The backend may reply with either JSON or SSE-like payloads depending on edge behavior. The provider parses both formats. Do not retry this ChatGPT/Codex backend with `web_search_preview`: staging logs on 2026-09-04 showed that the backend rejects that legacy tool type, and current OpenAI Responses API guidance for new integrations is to use `web_search`.

## Regression Checklist

If search starts failing again (HTTP or parse path):
1. Verify this payload shape in tests (`providers/chatgpt.test.ts`).
2. Compare against current upstream SDK behavior (`@earendil-works/pi-ai` codex responses provider).
3. Confirm model remains codex-compatible (`gpt-5.x-codex` family).
4. Inspect error fingerprint in thrown error (`tool/model/stream/tool_choice/text.verbosity`) and parse metadata (`content-type`, compact response snippet).
