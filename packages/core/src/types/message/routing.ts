
/**
 * Provider/model routing audit metadata.
 *
 * Robinswood fork: this is the foundation for manual provider handoff and the
 * future policy-first router. It is intentionally persisted per assistant
 * message so audits can answer which provider/model produced each response.
 */
export type RoutingCostSource = 'sdk' | 'provider' | 'estimated' | 'unavailable' | string;

export interface RoutingCostProvenance {
  /** Version of this provenance envelope for backward-compatible exports. */
  schemaVersion: 1;
  /** Origin of the cost value before any display-currency conversion. */
  source: RoutingCostSource;
  /** Currency reported by the source, normally USD for SDK estimates. */
  sourceCurrency?: string;
  /** Version/date of the provider pricing catalog used by the source. */
  pricingCatalogVersion?: string;
  /** Currency used for the optional converted display value. */
  displayCurrency?: string;
  /** Explicit conversion rate applied from sourceCurrency to displayCurrency. */
  exchangeRate?: number;
  /** ISO date associated with the exchange rate. */
  exchangeRateAsOf?: string;
  /** Human-readable or URL source for the exchange rate. */
  exchangeRateSource?: string;
}

export interface RoutingMeta {
  /** App version that produced this assistant response. */
  appVersion?: string;
  /** Source revision baked into the app build, when available. */
  buildCommit?: string;
  /** Distribution/runtime channel that produced the response. */
  buildChannel?: string;
  /** Whether the producing build came from a dirty working tree. */
  buildDirty?: boolean;
  /** Whether the producing runtime was a packaged application. */
  isPackaged?: boolean;
  /** LLM connection slug selected for this turn, when known. */
  connectionSlug?: string;
  /** Backend/provider type, e.g. anthropic, pi, pi_compat, router. */
  providerType?: string;
  /** Effective model ID used by the backend for this turn. */
  model?: string;
  /** Model ID requested before any provider-side aliasing or dynamic routing. */
  requestedModel?: string;
  /** Provider ID reported by the model backend (distinct from the Craft providerType). */
  provider?: string;
  /** Provider API/transport reported by the model backend. */
  api?: string;
  /** Context-window size associated with the model call, when known. */
  contextWindow?: number;
  /** Why this route was selected. MVP values are intentionally simple. */
  reason?: 'session-connection' | 'manual-handoff' | 'router' | string;
  /** Sensitivity tier used by a policy-first router, when available. */
  sensitivity?: string;
  /** IDs of routingPolicy rules that matched the turn, when available. */
  policyRuleIds?: string[];
  /** Local-only difficulty label used by the policy router. */
  routingDifficulty?: 'simple' | 'standard' | 'complex' | string;
  /** Capabilities required by the turn without retaining prompt content. */
  requiredCapabilities?: string[];
  /** Reader-facing explanation of the selected route. */
  routingExplanation?: string;
  /** Queryable local cost-controller decision for this model response. */
  costControl?: {
    turnKind: string;
    budgetState: string;
    thinkingLevel: string;
    contextTokensBefore: number;
    contextWindow?: number;
    compactAtTokens?: number;
    hardLimitTokens?: number;
    compacted?: boolean;
    compactionOutcome?: 'succeeded' | 'ineffective' | 'unverified' | 'failed' | 'skipped-cooldown' | 'skipped-not-needed';
    compactionModel?: string;
    compactionDurationMs?: number;
    contextTokensAfter?: number;
    reclaimedTokens?: number;
    reductionRatio?: number;
    compactionIssueCodes?: string[];
    hardContextLimitReached?: boolean;
  };
  /** Exact hard-policy reasons why configured alternatives were rejected. */
  rejectedConnections?: Array<{ slug: string; reasons: string[] }>;
  /** Cost guardrail result evaluated before route selection. */
  budgetDecision?: {
    status: 'within-budget' | 'blocked' | 'approval-required' | string;
    exceededScopes: string[];
    projectedUsd: {
      session?: number;
      mission?: number;
      workspace?: number;
    };
  };
  /** Primary connection that failed before streaming, when a policy-authorized fallback was used. */
  fallbackFromConnectionSlug?: string;
  /** Classified reason for using a policy-authorized fallback. */
  fallbackReason?: 'connection-unavailable' | 'backend-create-failed' | 'auth-failed' | 'provider-error' | 'model-unavailable' | string;
  /** Estimated cost in the source currency reported by the SDK, when available. */
  estimatedCostUsd?: number;
  /** Actual provider-reported cost in USD for this assistant turn, when available. */
  actualCostUsd?: number;
  /** Estimated cost in EUR for this assistant turn, when sourced. */
  estimatedCostEur?: number;
  /** Actual provider-reported cost in EUR for this assistant turn, when available. */
  actualCostEur?: number;
  /** Versioned provenance for source values and optional currency conversion. */
  costProvenance?: RoutingCostProvenance;
  /** @deprecated Read costProvenance.source when present. Kept for stored-session compatibility. */
  tokenUsageSource?: RoutingCostSource;
}
