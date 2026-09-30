/** A declarative check, never executable code or an authorization grant. */
export interface ObjectiveAcceptanceCriterion {
  id: string;
  /**
   * Exact previous criterion versioned after a host-observed negative result.
   * The successor ID must advance the `_vN` suffix by one (for example
   * `service-ready` -> `service-ready_v2`) while preserving the description,
   * requirement, tool, target input and checks exactly. The host retains the
   * predecessor in acceptance history.
   */
  supersedes?: string;
  /** Business requirement covered by this check, when a procedure is selected. */
  requirementId?: string;
  description: string;
  /** Exact verification tool, including its source namespace. */
  toolName: string;
  /** Exact input selectors binding the observation to its target/version. */
  input: Record<string, string | number | boolean | null>;
  /** Simple property/index selectors (foo.0, $.foo, $[0]), or $text for exact whole-output comparison. No wildcards, filters or expressions. All checks must pass. */
  checks: Array<{ path: string; equals: string | number | boolean | null }>;
}

/** Versioned outcome procedures. They describe quality, never grant authority. */
export type ObjectiveProcedureId = 'document-package' | 'document-delivery' | 'campaign-preparation' | 'software-change' | 'software-deployment' | 'technical-handover';
