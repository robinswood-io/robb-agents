import type { PermissionMode } from './mode-manager.ts';

/** Existing explicit workspace opt-in + authoritative session mode. */
export function isYoloMode(
  permissionMode: PermissionMode | undefined,
  externalActionPolicy: 'confirm' | 'allow-in-execute' | undefined,
): boolean {
  return permissionMode === 'allow-all' && externalActionPolicy === 'allow-in-execute';
}

export const YOLO_AUTONOMY_GUIDANCE = [
  'YOLO is active: complete the accepted objective without any human input or approval handoff.',
  'Resolve missing details from authenticated context and available tools; make reasonable in-scope decisions and record assumptions.',
  'Do not ask questions in tools or prose, submit a plan for approval, open credential/OAuth/MFA prompts, or wait for a human.',
  'Use update_plan or an ordinary plan file and continue implementation immediately.',
  'Use existing authorized credentials and automatic refresh; finish independent work when an external dependency is unavailable.',
  'Never invent a human answer, credential, authorization, or success. Report a proved unavailable dependency as incomplete, without a question or request for intervention.',
  'Preserve the requested scope, explicit exclusions, Stop, durable recovery budgets, operation identities and verification. Do not replay an uncertain external effect.',
].join(' ');

const HUMAN_HANDOFF_TOOLS = new Set([
  'request_user_input', 'SubmitPlan', 'source_credential_prompt',
  'source_oauth_trigger', 'source_google_oauth_trigger',
  'source_slack_oauth_trigger', 'source_microsoft_oauth_trigger',
]);

export function yoloHumanHandoffBlock(
  toolName: string,
  permissionMode: PermissionMode | undefined,
  externalActionPolicy: 'confirm' | 'allow-in-execute' | undefined,
  humanInputAllowed?: boolean,
): string | undefined {
  if (humanInputAllowed !== false && !isYoloMode(permissionMode, externalActionPolicy)) return undefined;
  // Match native session tools only, never another connector's same leaf name.
  const name = toolName.replace(/^(?:mcp__session__|session__)/, '');
  if (!HUMAN_HANDOFF_TOOLS.has(name)) return undefined;
  return `YOLO_HUMAN_HANDOFF_DISABLED: ${toolName} was not executed and no human request was created. ${YOLO_AUTONOMY_GUIDANCE}`;
}
