export type PlaybookHumanGate =
  | 'oauth_or_mfa'
  | 'credential_required'
  | 'business_decision_required'
  | 'external_authorization_required'

export interface PlaybookProof {
  id: string
  description: string
  required: boolean
}

export interface PlaybookManifest {
  version: 1
  slug: string
  name: string
  description: string
  requiredSources?: string[]
  allowedTools: string[]
  humanGates?: PlaybookHumanGate[]
  proofs: PlaybookProof[]
  outputSchema?: Record<string, unknown>
}

export interface LoadedPlaybook {
  manifest: PlaybookManifest
  instructions: string
  path: string
}
