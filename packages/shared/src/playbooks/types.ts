import type { z } from 'zod'
import type { PlaybookManifestSchema } from './validation.ts'

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

export type PlaybookManifest = z.infer<typeof PlaybookManifestSchema>


export interface LoadedPlaybook {
  manifest: PlaybookManifest
  instructions: string
  path: string
}
