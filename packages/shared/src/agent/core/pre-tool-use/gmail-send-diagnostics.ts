import { isUnknownArray } from '../../../utils/json.ts';
import { resolve } from "node:path";
import { parseStructuredGmailSendResumeSegment } from "../sensitive-external-action.ts";
import { PORTABLE_SESSION_PATH_TOKEN } from './portable-scope.ts';

/**
 * Pi expands portable session-path tokens immediately before PreToolUse. Keep
 * the connector's executable input untouched, but compare that one host-owned
 * expansion against the authenticated symbolic Gmail contract. No other
 * absolute path, alias, sibling session, or multi-attachment payload is made
 * equivalent by this normalization.
 */
export function structuredGmailSendDiagnosticInput(
  input: Record<string, unknown>,
  objectiveSegments: readonly string[],
  dataFolderPath: string | undefined,
): Record<string, unknown> {
  if (!dataFolderPath
    || !isUnknownArray(input["attachmentPaths"])
    || input["attachmentPaths"].length !== 1
    || typeof input["attachmentPaths"][0] !== 'string') return input;

  let expectedAttachmentPath: string | undefined;
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const segment = objectiveSegments[index] ?? '';
    if (!/\[robb-resume(?::|\])/iu.test(segment)) continue;
    const payload = parseStructuredGmailSendResumeSegment(segment);
    if (payload?.attachmentPaths.length === 1) {
      expectedAttachmentPath = payload.attachmentPaths[0];
    }
    break;
  }
  if (!expectedAttachmentPath?.startsWith(`${PORTABLE_SESSION_PATH_TOKEN}/`)) {
    return input;
  }

  const sessionPath = resolve(dataFolderPath, '..');
  const directlyExpandedPath = sessionPath + expectedAttachmentPath.slice(
    PORTABLE_SESSION_PATH_TOKEN.length,
  );
  const actualAttachmentPath = input["attachmentPaths"][0];
  if (actualAttachmentPath !== directlyExpandedPath) return input;

  return { ...input, attachmentPaths: [expectedAttachmentPath] };
}
