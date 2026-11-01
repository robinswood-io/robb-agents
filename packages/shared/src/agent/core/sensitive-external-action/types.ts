
export type SensitiveExternalActionCategory =
  | 'git_push'
  | 'deployment'
  | 'service_restart'
  | 'secret_transfer'
  | 'external_send'
  | 'external_publication'
  | 'external_mutation'
  | 'payment';

export type SensitiveConditionalTargetKind = 'contract' | 'document' | 'envelope';

export interface SensitiveConditionalTarget {
  kind: SensitiveConditionalTargetKind;
  value: string;
}

export interface SensitiveExternalAction {
  category: SensitiveExternalActionCategory;
  promptType: 'bash' | 'mcp_mutation' | 'api_mutation';
  description: string;
  commandPreview: string;
  reason: string;
  impact: string;
  targetCandidates: string[];
  /**
   * Internal object identifiers that bind authority only when the objective
   * explicitly names the same kind of object. They are deliberately separate
   * from the always-required external audience.
   */
  conditionalTargetCandidates?: SensitiveConditionalTarget[];
  /** Operation-specific verbs for generic connector/API mutations. */
  authorizationTermGroups?: string[][];
  /** Host-owned marker for a shell command transported by a remote executor. */
  remoteCommand?: true;
  /** Only the audited rbw-servers executors may use the bounded Orion prompt. */
  boundedRemoteHostPrompt?: true;
  /** Literal rbw-servers endpoint/cwd retained out of band from the lossy
   * target display classifier. These fields are emitted only for the two
   * audited executors and never inferred from objective prose. */
  boundedRemoteEndpoint?: string;
  boundedRemoteWorkingDirectory?: string;
  /** Every shell leaf belongs to the closed source/test/deploy lifecycle
   * grammar. Opaque wrappers/interpreters and unrelated clients are excluded. */
  boundedRemoteImplementationLifecycle?: true;
  /** A read-shaped remote command contains an option that writes a file,
   * loads executable configuration, or launches a secondary command. */
  boundedRemoteReadSideEffect?: true;
  /** One PDF resolved from the current session may accompany this canonical
   * Gmail send, but only when the authenticated objective names that PDF. */
  boundedSessionPdfAttachment?: true;
  /** Exact atomic OSS source write admitted only by a signed resume contract.
   * The connector, literal canonical path and input shape are all closed. */
  boundedOssAtomicWrite?: true;
  /** Mixed sensitive operations whose redacted preview cannot support informed consent. */
  requiresInspectableSplit?: true;
}

export interface AstNode {
  type: string;
  async?: boolean;
  op?: string | { text?: string };
  commands?: AstNode[];
  left?: AstNode;
  right?: AstNode;
  list?: AstNode;
  name?: { type: string; text: string };
  suffix?: Array<{
    type: string;
    text?: string;
    expansion?: unknown[];
    file?: { type?: string; text?: string; expansion?: unknown[] };
    op?: { text?: string };
  }>;
}
