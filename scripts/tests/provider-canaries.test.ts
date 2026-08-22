import { describe, expect, it } from 'bun:test';
import { runProviderCanaries } from '../robb-provider-canaries.ts';

function makeChatGptJwt(accountId: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${encode({ alg: 'RS256' })}.${encode({
    exp,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

describe('provider contract canaries', () => {
  it('reports every contract/check without network when credentials are absent', async () => {
    const report = await runProviderCanaries({
      environment: {},
      fetchImpl: async () => { throw new Error('fetch must not run'); },
      exchangeCopilotToken: async () => { throw new Error('exchange must not run'); },
      now: () => Date.parse('2026-08-20T12:00:00.000Z'),
    });

    expect(report.results).toHaveLength(12);
    expect(report.summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 8,
      'not-applicable': 4,
      ok: true,
    });
    expect(new Set(report.results.map(item => item.check))).toEqual(
      new Set(['auth', 'list-models', 'search', 'tool-call']),
    );
  });

  it('exercises ChatGPT auth, search and tool-call without serializing the token', async () => {
    const token = makeChatGptJwt('acc_canary');
    const report = await runProviderCanaries({
      environment: { ROBB_CANARY_CHATGPT_ACCESS_TOKEN: token },
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, any>;
        if (body.tools?.[0]?.type === 'web_search') {
          return new Response(JSON.stringify({
            output: [{ type: 'message', content: [{
              type: 'output_text',
              text: 'https://platform.openai.com/docs',
              annotations: [{ type: 'url_citation', url: 'https://platform.openai.com/docs' }],
            }] }],
          }));
        }
        return new Response(JSON.stringify({
          output: [{ type: 'function_call', name: 'provider_contract_healthcheck', arguments: '{}' }],
        }));
      },
      now: () => Date.now(),
    });

    const chatGpt = report.results.filter(item => item.provider === 'chatgpt-codex-backend');
    expect(chatGpt.map(item => item.status)).toEqual([
      'passed',
      'not-applicable',
      'passed',
      'passed',
    ]);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it('redacts provider response bodies that echo credentials', async () => {
    const token = makeChatGptJwt('acc_redaction');
    const report = await runProviderCanaries({
      environment: { ROBB_CANARY_CHATGPT_ACCESS_TOKEN: token },
      fetchImpl: async () => new Response(`Authorization: Bearer ${token}`, { status: 401 }),
      now: () => Date.now(),
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain('[REDACTED]');
    expect(report.summary.failed).toBe(2);
    expect(report.summary.ok).toBe(false);
  });

  it('covers Copilot SDK exchange/list/tool and Google auth/tool contracts', async () => {
    const githubToken = 'github-secret-token';
    const copilotToken = 'tid=1;proxy-ep=proxy.individual.githubcopilot.com;sig=copilot-secret';
    const googleToken = 'google-secret-token';
    const report = await runProviderCanaries({
      environment: {
        ROBB_CANARY_GITHUB_TOKEN: githubToken,
        ROBB_CANARY_GOOGLE_CODE_ASSIST_ACCESS_TOKEN: googleToken,
      },
      exchangeCopilotToken: async token => {
        expect(token).toBe(githubToken);
        return { access: copilotToken };
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'gpt-5-mini' }] }));
        }
        if (url.endsWith('/responses')) {
          return new Response(JSON.stringify({
            output: [{ type: 'function_call', name: 'provider_contract_healthcheck' }],
          }));
        }
        if (url.includes(':loadCodeAssist')) {
          return new Response(JSON.stringify({
            currentTier: { id: 'STANDARD' },
            cloudaicompanionProject: 'canary-project',
          }));
        }
        if (url.includes(':streamGenerateContent')) {
          const body = JSON.parse(String(init?.body));
          expect(body.project).toBe('canary-project');
          return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"provider_contract_healthcheck","args":{}}}]}}]}}\n\n');
        }
        throw new Error(`unexpected canary URL: ${url}`);
      },
      now: () => Date.now(),
    });

    const selected = report.results.filter(item =>
      item.provider !== 'chatgpt-codex-backend' && item.required,
    );
    expect(selected.every(item => item.status === 'passed')).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(copilotToken);
    expect(serialized).not.toContain(googleToken);
  });

  it('keeps every runtime on the exact Pi SDK contract', async () => {
    const root = await Bun.file('package.json').json() as any;
    const shared = await Bun.file('packages/shared/package.json').json() as any;
    const piServer = await Bun.file('packages/pi-agent-server/package.json').json() as any;

    expect(root.dependencies['@earendil-works/pi-ai']).toBe('0.80.3');
    expect(root.dependencies['@earendil-works/pi-coding-agent']).toBe('0.80.3');
    expect(shared.dependencies['@earendil-works/pi-ai']).toBe('0.80.3');
    expect(shared.dependencies['@earendil-works/pi-coding-agent']).toBe('0.80.3');
    expect(piServer.dependencies['@earendil-works/pi-agent-core']).toBe('0.80.3');
    expect(piServer.dependencies['@earendil-works/pi-ai']).toBe('0.80.3');
    expect(piServer.dependencies['@earendil-works/pi-coding-agent']).toBe('0.80.3');
    expect(piServer.dependencies['@craft-agent/core']).toBe('workspace:*');
  });
});
