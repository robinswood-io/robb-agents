import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core';

// No tools execute: exercise the same SDK argument validation used by Pi.
const samples: Record<string, Record<string, unknown>> = {
  SubmitPlan: { planPath: '/fixture/plan.md' },
  update_plan: { explanation: 'The document is ready for review.', plan: [{ step: 'Create document', status: 'completed' }, { step: 'Review document', status: 'in_progress' }] },
  config_validate: { target: 'config' },
  skill_validate: { skillSlug: 'fixture' },
  mermaid_validate: { code: 'graph TD; A-->B', render: false },
  source_test: { sourceSlug: 'fixture', autoEnable: false },
  source_oauth_trigger: { sourceSlug: 'fixture' },
  source_google_oauth_trigger: { sourceSlug: 'fixture' },
  source_slack_oauth_trigger: { sourceSlug: 'fixture' },
  source_microsoft_oauth_trigger: { sourceSlug: 'fixture' },
  source_credential_prompt: { sourceSlug: 'fixture', mode: 'basic', passwordRequired: false },
  update_user_preferences: { name: 'Fixture', includeCoAuthoredBy: false },
  transform_data: { recipe: { name: 'json-records-v1', filter: { field: 'ready', equals: false } }, inputFiles: ['input.json'], outputFile: 'out.json' },
  script_sandbox: { language: 'python3', script: 'print(1)', timeoutMs: 1000, inputFiles: [] },
  render_template: { source: 'fixture', template: 'note', data: { ready: true, n: 1, empty: null } },
  send_developer_feedback: { message: 'Fixture only' },
  call_llm: { prompt: 'Fixture only', attachments: ['/fixture/a.txt', { path: '/fixture/b.txt', startLine: 1, endLine: 2 }], maxTokens: 64, thinking: false },
  spawn_session: { prompt: 'Review fixture', role: 'reviewer', permissionMode: 'safe', labels: ['reviewer'], attachments: [{ path: '/fixture/a.txt' }] },
  browser_tool: { command: ['screenshot-region', '#canvas', '--canvas'] },
  request_user_input: { questions: [{ id: 'q', question: 'Colour?', options: [{ id: 'blue', label: 'Blue', recommended: true }], multiSelect: false }] },
  project_learning: { action: 'list', tags: ['fixture'], ttlDays: 1 },
  set_completion_criteria: { criteria: [{ id: 'ready', description: 'Ready', toolName: 'Read', input: { file_path: '/fixture/a.json', force_refresh: false }, checks: [{ path: '$.ready', equals: true }] }] },
  set_session_labels: { labels: ['fixture'] },
  set_session_status: { status: 'needs-review' },
  get_session_info: { sessionId: 'fixture' },
  list_sessions: { sortBy: 'recent', limit: 2, offset: 0 },
  wait_sessions: { sessionIds: ['fixture'], timeoutMs: 0, afterCursors: { fixture: 'a'.repeat(64) } },
  list_background_tasks: { sessionId: 'fixture' },
  send_agent_message: { sessionId: 'fixture', message: 'Read-only fixture', messageType: 'result', attachments: [{ path: '/fixture/a.txt', name: 'A' }] },
  list_messaging_channels: { sessionId: 'fixture' },
  unbind_messaging_channel: { platform: 'telegram' },
};
const definitions = getToolDefsAsJsonSchema({ includeDeveloperFeedback: true });
function validate(name: string, args: Record<string, unknown>) {
  const definition = definitions.find(tool => tool.name === name)!;
  return validateToolArguments({ name, description: definition.description, parameters: definition.inputSchema as never },
    { id: 'fixture', type: 'toolCall', name, arguments: args });
}

describe('Pi session tool argument contracts', () => {
  it('covers every tool exposed by the canonical registry', () => {
    expect(Object.keys(samples).sort()).toEqual(definitions.map(tool => tool.name).sort());
  });
  it.each(Object.entries(samples))('%s preserves valid argument types and required fields', (name, input) => {
    expect(validate(name, input)).toEqual(input);
    const required = definitions.find(tool => tool.name === name)!.inputSchema.required as string[] | undefined;
    for (const key of required ?? []) {
      const missing = { ...input };
      delete missing[key];
      expect(() => validate(name, missing)).toThrow();
    }
  });
  it.each([true, false, 0, 1, 1.5, null, '', '1', 'true'])('preserves exact filter scalar %j', value => {
    const input = { recipe: { name: 'json-records-v1', filter: { field: 'value', equals: value } }, inputFiles: ['input.json'], outputFile: 'out.json' };
    expect(validate('transform_data', input)).toEqual(input);
  });
  it('keeps arrays and strings distinct in browser commands', () => {
    for (const command of [['screenshot'], ['type-keys', 'Ctrl+C'], 'screenshot']) {
      expect(validate('browser_tool', { command })).toEqual({ command });
    }
  });
  it('rejects invalid enums and collection bounds before dispatch', () => {
    for (const input of [
      { prompt: 'Review', permissionMode: 'execute' }, { prompt: 'Review', role: 'administrator' },
    ]) expect(() => validate('spawn_session', input)).toThrow();
    expect(() => validate('send_agent_message', { sessionId: 'fixture', message: 'note', messageType: 'human' })).toThrow();
    expect(() => validate('wait_sessions', { sessionIds: [], timeoutMs: 0 })).toThrow();
    expect(() => validate('wait_sessions', { sessionIds: ['fixture'], timeoutMs: -1 })).toThrow();
  });
});
