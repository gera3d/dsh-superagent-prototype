/** Strict external observation input; recording evidence does not accept a finding or delivery. */
import { z } from 'zod'
export const FindingEvidenceRequest = z.object({
  revision: z.number().int().positive(),
  reference: z.string().trim().min(1).max(16384),
  evidence: z.string().trim().min(1).max(16384),
  nextDecision: z.string().trim().min(1).max(16384),
  verified: z.boolean().default(false),
}).strict()
export type FindingEvidenceInput = z.infer<typeof FindingEvidenceRequest>
