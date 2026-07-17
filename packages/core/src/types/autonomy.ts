export type AutonomyPhase = 'attempt' | 'diagnosis' | 'fallback' | 'verified' | 'escalated'

export type HumanEscalationReason =
  | 'oauth_or_mfa'
  | 'credential_required'
  | 'business_decision_required'
  | 'external_authorization_required'
  | 'access_unavailable_after_fallback'

export interface AutonomyEvent {
  id: string
  timestamp: number
  phase: AutonomyPhase
  message: string
  toolName?: string
  evidence?: string
  escalationReason?: HumanEscalationReason
}
