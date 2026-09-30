export { SessionManager, setSessionPlatform, setSessionRuntimeHooks, sanitizeForTitle, AGENT_FLAGS } from './SessionManager'
export type { SessionCompletionEvent } from './SessionManager'
export {
  evaluateAutonomyAcceptance,
  TOTAL_AUTONOMY_ACCEPTANCE_POLICY,
} from './autonomy-acceptance'
export type {
  AutonomyAcceptanceGate,
  AutonomyAcceptanceObservation,
  AutonomyAcceptancePolicy,
  AutonomyAcceptanceReport,
  AutonomyHumanBenchmark,
  AutonomyMutationObservation,
} from './autonomy-acceptance'
