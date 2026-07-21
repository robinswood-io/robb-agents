import { z } from 'zod'
import type { PlaybookManifest } from './types.ts'

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const gate = z.enum(['oauth_or_mfa', 'credential_required', 'business_decision_required', 'external_authorization_required'])

const schema = z.object({
  version: z.literal(1),
  slug,
  name: z.string().min(1),
  description: z.string().min(1),
  requiredSources: z.array(slug).optional(),
  allowedTools: z.array(z.string().min(1)).min(1),
  humanGates: z.array(gate).optional(),
  proofs: z.array(z.object({ id: slug, description: z.string().min(1), required: z.boolean() })).min(1),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
}).strict()

export function validatePlaybookManifest(value: unknown): PlaybookManifest {
  return schema.parse(value)
}
