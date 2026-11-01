import type { BrowserPaneFns } from "../browser-tools.ts";
import { isObservationalBrowserCommandParts } from './command-syntax.ts';

const contextualGmailBrowserMutationGuards = new Set<string>();

/** Configure the session-scoped runtime fence used by the pre-tool policy.
 * The fence is intentionally enforced against the actual browser URL so an
 * unrelated CMS/form workflow in the same objective remains autonomous. */
export function setContextualGmailBrowserMutationGuard(
  sessionId: string,
  enabled: boolean,
): void {
  if (enabled) contextualGmailBrowserMutationGuards.add(sessionId);
  else contextualGmailBrowserMutationGuards.delete(sessionId);
}

/** Host bridge helper: propagate the active session fence to the desktop that
 * performs the browser effect. */
export function isContextualGmailBrowserMutationGuardEnabled(sessionId: string): boolean {
  return contextualGmailBrowserMutationGuards.has(sessionId);
}

function isGmailBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === 'mail.google.com' || url.hostname.endsWith('.mail.google.com'));
  } catch {
    return false;
  }
}

/** Re-check the effective target immediately after the host resolves the
 * instance used by a mutating callback. This closes the gap between the
 * command-level preview and a concurrent window rebind. */
export function assertContextualGmailBrowserMutationTargetAllowed(
  sessionId: string,
  targetUrl: string,
): void {
  if (!contextualGmailBrowserMutationGuards.has(sessionId) || !isGmailBrowserUrl(targetUrl)) return;
  throw new Error(
    'Validation failed: browser mutations on Gmail are disabled for this contextual reply. '
      + 'Use only gmail_reply_preflight + gmail_reply_bound or '
      + 'gmail_reply_all_preflight + gmail_reply_all with the signed closed payload.',
  );
}

export async function assertContextualGmailBrowserMutationAllowed(args: {
  commandParts: string[];
  fns: BrowserPaneFns;
  sessionId: string;
}): Promise<void> {
  if (!contextualGmailBrowserMutationGuards.has(args.sessionId)
    || isObservationalBrowserCommandParts(args.commandParts)) return;

  const commandText = args.commandParts.join(' ');
  const explicitlyTargetsGmail = /(?:^|[^a-z0-9])(?:gmail|mail\.google\.com)(?:[^a-z0-9]|$)/iu.test(commandText);
  if (!explicitlyTargetsGmail) {
    // A session may own or even retain bindings to several windows. Inspecting
    // all of them over-blocks an unrelated CMS whenever a historical Gmail
    // window is also present. Resolve through the same manager path used by the
    // command callbacks and fence only the effective target.
    const target = await args.fns.resolveCurrentWindow();
    assertContextualGmailBrowserMutationTargetAllowed(args.sessionId, target.url);
    return;
  }

  throw new Error(
    'Validation failed: browser mutations on Gmail are disabled for this contextual reply. '
      + 'Use only gmail_reply_preflight + gmail_reply_bound or '
      + 'gmail_reply_all_preflight + gmail_reply_all with the signed closed payload.',
  );
}
