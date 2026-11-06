/** Explicit management intake; browser suggestions and generic inbox writes cannot create authority. */
import { z } from 'zod'

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
const sha = z.string().regex(/^[a-f0-9]{40}$/i)
export const DeliveryIntakeRequest = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), title: z.string().trim().min(1).max(500), owner: z.string().trim().min(1).max(200),
  bindings: z.object({ repository, sourceIssue: z.number().int().positive(), baseSha: sha, headSha: sha,
    artifact: z.string().min(1).max(200).optional(), environment: z.string().min(1).max(500),
    refs: z.array(z.object({ repository, pr: z.number().int().positive(), headSha: sha, baseSha: sha, diffSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict()).min(1).max(20).refine(refs => new Set(refs.map(ref => `${ref.repository}:${ref.pr}`)).size === refs.length, 'Duplicate repository/PR identity'),
  }).strict(),
  requirements: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  workers: z.array(z.string().min(1).max(100)).min(1).max(20),
  // Publication/acceptance grants are never inferred from feature intake.
  delegatedActions: z.array(z.enum(['implement', 'review', 'fix', 'verify'])).max(4).default([]),
  followFixHeads: z.boolean().default(false),
}).strict()
export type DeliveryIntake = z.infer<typeof DeliveryIntakeRequest>
