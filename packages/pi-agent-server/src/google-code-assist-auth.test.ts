import { expect, it, spyOn } from 'bun:test';
import { ensureCodeAssistUser } from './google-code-assist-auth.ts';

it('keeps accounts with a shared token prefix in separate project caches', async () => {
  const prefix = 'fixture-shared-prefix-24-characters';
  const tokens = [`${prefix}-account-one`, `${prefix}-account-two`];
  let requests = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    requests += 1;
    const authorization = new Headers(init?.headers).get('Authorization');
    return Response.json({ currentTier: { id: 'STANDARD' },
      cloudaicompanionProject: authorization === `Bearer ${tokens[0]}` ? 'project-one' : 'project-two' });
  });
  try {
    expect((await ensureCodeAssistUser(tokens[0]!)).projectId).toBe('project-one');
    expect((await ensureCodeAssistUser(tokens[1]!)).projectId).toBe('project-two');
    expect((await ensureCodeAssistUser(tokens[0]!)).projectId).toBe('project-one');
    expect(requests).toBe(2);
  } finally { fetchSpy.mockRestore(); }
});
