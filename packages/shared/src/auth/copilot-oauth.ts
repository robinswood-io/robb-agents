import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import type { OAuthCredential } from '@earendil-works/pi-ai';

/** Exchange the stored GitHub token through Pi's current public provider API. */
export async function refreshGitHubCopilotToken(
  githubToken: string,
  signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<OAuthCredential> {
  const oauth = githubCopilotProvider().auth?.oauth;
  if (!oauth) throw new Error('The installed Pi SDK has no GitHub Copilot OAuth provider.');
  return oauth.refresh({
    type: 'oauth',
    access: '',
    refresh: githubToken,
    expires: 0,
  }, signal);
}
