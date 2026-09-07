/** A declarative check, never executable code or an authorization grant. */
export interface ObjectiveAcceptanceCriterion {
  id: string;
  description: string;
  /** Exact verification tool, including its source namespace. */
  toolName: string;
  /** Exact input selectors binding the observation to its target/version. */
  input: Record<string, string | number | boolean | null>;
  /** Dot-separated JSON paths, or $text for exact whole-output comparison. All checks must pass. */
  checks: Array<{ path: string; equals: string | number | boolean | null }>;
}
