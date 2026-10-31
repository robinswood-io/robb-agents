import { isUnknownArray } from '../../../utils/json.ts';
import { hasSingleMailboxShape } from "../../../utils/string-boundaries.ts";

/**
 * Host-owned connector observations. These exact tools acquire data or start a
 * read-only connection handshake; they do not change remote business records.
 * Their input schemas are checked here because neither a tool name nor
 * untrusted MCP annotations prove the effect of an arbitrary invocation.
 */
export function isHostOwnedConnectorObservation(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const keys = Object.keys(input);
  const displayOnly = (key: string) => key === '_displayName' || key === '_intent';
  if (toolName === 'mcp__session__wait_sessions') {
    return isUnknownArray(input["sessionIds"])
      && input["sessionIds"].length > 0
      && input["sessionIds"].length <= 8
      && input["sessionIds"].every((id: unknown) => typeof id === 'string' && id.length > 0)
      && (input["mode"] === undefined || input["mode"] === 'first' || input["mode"] === 'all')
      && (input["timeoutMs"] === undefined
        || typeof input["timeoutMs"] === 'number' && Number.isInteger(input["timeoutMs"])
          && input["timeoutMs"] >= 0 && input["timeoutMs"] <= 120_000)
      && (input["afterCursors"] === undefined
        || typeof input["afterCursors"] === 'object' && input["afterCursors"] !== null
          && !isUnknownArray(input["afterCursors"])
          && Object.values(input["afterCursors"]).every((cursor: unknown) => typeof cursor === 'string'))
      && keys.every(key => ['sessionIds', 'mode', 'timeoutMs', 'afterCursors'].includes(key)
        || displayOnly(key));
  }
  if (toolName === 'mcp__rbw-agents-oss__oss_list_files') {
    return typeof input["path"] === 'string'
      && (input["path"] === '/srv/rbw-agents-oss'
        || input["path"].startsWith('/srv/rbw-agents-oss/'))
      && !input["path"].split('/').includes('..')
      && (input["maxDepth"] === undefined
        || typeof input["maxDepth"] === 'number' && Number.isInteger(input["maxDepth"])
          && input["maxDepth"] >= 0 && input["maxDepth"] <= 8)
      && keys.every(key => key === 'path' || key === 'maxDepth' || displayOnly(key));
  }
  if (toolName === 'mcp__rbw-servers__ssh_sync') {
    // The verified local mcp-ssh-manager connector maps this exact preview to
    // rsync --dry-run. Actual syncs and ambiguous inputs remain mutations.
    const localSource = typeof input["source"] === 'string'
      && input["source"].startsWith('local:') ? input["source"].slice(6) : '';
    const remoteDestination = typeof input["destination"] === 'string'
      && input["destination"].startsWith('remote:') ? input["destination"].slice(7) : '';
    const localPath = /^\/[A-Za-z0-9._/-]+$/u.test(localSource)
      || /^\{\{SESSION_PATH\}\}\/data\/[A-Za-z0-9._/-]+$/u.test(localSource);
    const remotePath = /^\/[A-Za-z0-9._/-]+$/u.test(remoteDestination);
    const noTraversal = (path: string) => !path.split('/').includes('..');
    return typeof input["server"] === 'string'
      && /^[A-Za-z0-9._-]{1,64}$/u.test(input["server"])
      && input["dryRun"] === true && input["delete"] === false
      && localPath && remotePath
      && localSource.length <= 2_000 && remoteDestination.length <= 2_000
      && noTraversal(localSource) && noTraversal(remoteDestination)
      && (input["exclude"] === undefined || isUnknownArray(input["exclude"])
        && input["exclude"].length <= 32
        && input["exclude"].every((pattern: unknown) => typeof pattern === 'string'
          && pattern.length <= 128 && /^[A-Za-z0-9_*?.-]+$/u.test(pattern)))
      && ['compress', 'verbose', 'checksum'].every(key => input[key] === undefined
        || typeof input[key] === 'boolean')
      && (input["timeout"] === undefined || typeof input["timeout"] === 'number'
        && Number.isInteger(input["timeout"]) && input["timeout"] > 0 && input["timeout"] <= 300_000)
      && keys.every(key => ['server', 'source', 'destination', 'dryRun', 'delete',
        'exclude', 'compress', 'verbose', 'checksum', 'timeout'].includes(key)
        || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__drive_download_file') {
    return typeof input["fileId"] === 'string'
      && /^[A-Za-z0-9_-]{10,}$/.test(input["fileId"])
      && keys.every(key => key === 'fileId' || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__gmail_search_exact') {
    return typeof input["query"] === 'string'
      && input["query"].trim().length > 0 && input["query"].length <= 2_000
      && keys.every(key => key === 'query' || displayOnly(key));
  }
  if (toolName === 'mcp__google-contacts__gmail_reply_preflight'
    || toolName === 'mcp__google-contacts__gmail_reply_all_preflight') {
    const recipientBound = toolName.endsWith('__gmail_reply_preflight');
    return typeof input["messageId"] === 'string'
      && /^[0-9a-f]{12,32}$/iu.test(input["messageId"])
      && typeof input["body"] === 'string'
      && input["body"].trim().length > 0
      && !input["body"].includes('\0')
      && (input["isHtml"] === undefined || typeof input["isHtml"] === 'boolean')
      && (input["expectedSenderEmail"] === undefined
        || typeof input["expectedSenderEmail"] === 'string'
          && hasSingleMailboxShape(input["expectedSenderEmail"]))
      && (recipientBound
        ? typeof input["expectedRecipientEmail"] === 'string'
          && hasSingleMailboxShape(input["expectedRecipientEmail"])
        : input["expectedRecipientEmail"] === undefined)
      && keys.every(key => (
        key === 'messageId' || key === 'body' || key === 'isHtml'
          || key === 'expectedSenderEmail'
          || recipientBound && key === 'expectedRecipientEmail'
          || displayOnly(key)
      ));
  }
  if (toolName === 'mcp__atria-sellsy__atria_sellsy_authenticate') {
    return keys.every(displayOnly);
  }
  if (toolName === 'mcp__orion-mcp__orion_providers_list'
    || toolName === 'mcp__orion-mcp__orion_tool_search'
    || toolName === 'mcp__orion-mcp__orion_tool_schema'
    || toolName === 'mcp__orion-mcp__orion_mcp_read'
    || toolName === 'mcp__orion-mcp__memory_context'
    || toolName === 'mcp__orion-mcp__memory_search'
    || toolName === 'mcp__orion-mcp__memory_list'
    || toolName === 'mcp__orion-mcp__memory_audit') {
    return true;
  }
  if (toolName === 'mcp__atria-sellsy__atria_sellsy_oauth_start') {
    if (typeof input["scopes"] !== 'string'
      || !keys.every(key => key === 'scopes' || displayOnly(key))) return false;
    const scopes = input["scopes"].trim().split(/\s+/u);
    const allowed = new Set([
      'companies.read', 'contacts.read', 'individuals.read',
      'invoices.read', 'subscriptions.read', 'items.read',
      'payments.read', 'credit-notes.read', 'estimates.read',
      'opportunities.read', 'tasks.read', 'activities.read', 'search.read',
    ]);
    return scopes.length > 0 && scopes.length <= allowed.size
      && new Set(scopes).size === scopes.length
      && scopes.every(scope => allowed.has(scope));
  }
  return false;
}
