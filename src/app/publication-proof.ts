/**
 * Compact, bounded descriptors of the evidence the trusted publication adapter already verified for the exact prepared pins.
 * They are server-derived facts for advice/review context, never an approval or a substitute for the protected publication gate.
 */
import type { Delivery } from './feature-delivery.ts'
import type { LifecyclePublication } from './lifecycle-publication.ts'
import type { PublicationEvidence } from './publication.ts'

export interface PublicationProof {
  observedAt: string
  status: { checks: PublicationEvidence['checks']; review: PublicationEvidence['review'] }
  /** True only when the adapter recorded passed checks and an approved review for the same pins as the prepared publication. */
  verified: boolean
  reviewer?: string
  reportSha256?: string
  reviewExcerpt?: string
  checks: { name: string; completedAt: string; reportSha256: string; excerpt?: string }[]
  limitations: string[]
  /** Recorded totals before the bounded lists were shortened, so advice can name what it omitted. */
  counts: { checks: number; limitations: number }
}
const clip = (value: string | undefined, limit: number) => value?.slice(0, limit)
const PROOF_CHECKS = 5
const REVIEW_EXCERPT = 600
const CHECK_EXCERPT = 200
const LIMITATIONS = 5
const LIMITATION_CHARS = 300

/** Rejects descriptors whose pins differ from the prepared publication; unverified or mismatched evidence is never described as proof. */
export function publicationProof(evidence: PublicationEvidence | undefined,
  pins: { repository: string; pr: number; headSha: string; patchSha256: string }): PublicationProof | undefined {
  if (!evidence || evidence.repository !== pins.repository || evidence.prNumber !== pins.pr
    || evidence.headSha !== pins.headSha || evidence.patchSha256 !== pins.patchSha256) return undefined
  const local = evidence.local
  return { observedAt: evidence.observedAt, status: { checks: evidence.checks, review: evidence.review },
    verified: evidence.checks === 'passed' && evidence.review === 'approved',
    ...(local ? { reviewer: clip(local.reviewer, 120), reportSha256: local.reportSha256, reviewExcerpt: clip(local.reviewExcerpt, REVIEW_EXCERPT) } : {}),
    checks: (local?.checks ?? []).slice(0, PROOF_CHECKS).map(check => ({ name: clip(check.name, 120) ?? '', completedAt: check.completedAt,
      reportSha256: check.reportSha256, ...(check.outputExcerpt ? { excerpt: clip(check.outputExcerpt, CHECK_EXCERPT) } : {}) })),
    limitations: (local?.limitations ?? []).slice(0, LIMITATIONS).map(item => clip(item, LIMITATION_CHARS) ?? ''),
    counts: { checks: local?.checks.length ?? 0, limitations: local?.limitations.length ?? 0 } }
}

/**
 * Reads the last committed publication for a card prepared before proof was recorded through the pure lock-free peek. Only
 * evidence for the exact recorded publication pins becomes proof; unavailable, changed or mismatched state yields no descriptor.
 */
export async function snapshotProof(prepared: Delivery['preparedPublication'],
  publication?: Pick<LifecyclePublication, 'service'>): Promise<PublicationProof | undefined> {
  if (!prepared || prepared.proof || !publication) return undefined
  try {
    const snapshot = publication.service.peek(prepared.ticketId)
    if (!snapshot || snapshot.id !== prepared.id || snapshot.repository !== prepared.repository || snapshot.prNumber !== prepared.pr
      || snapshot.headSha !== prepared.headSha || snapshot.patchSha256 !== prepared.patchSha256) return undefined
    return publicationProof(snapshot.evidence, { repository: prepared.repository, pr: prepared.pr, headSha: prepared.headSha, patchSha256: prepared.patchSha256 })
  } catch { return undefined }
}

/** Bounded projection for model advice; a missing recorded proof stays explicitly unknown instead of being inferred. */
export function preparedPublicationFacts(prepared?: Delivery['preparedPublication']) {
  if (!prepared) return null
  const proof = prepared.proof
  return { repository: clip(prepared.repository, 200), pr: prepared.pr, headSha: clip(prepared.headSha, 80), patchSha256: clip(prepared.patchSha256, 80),
    environment: clip(prepared.environment, 160), preparedAt: clip(prepared.preparedAt, 40),
    components: (prepared.components ?? []).slice(0, 6).map(item => clip(item, 120)),
    effects: (prepared.effects ?? []).slice(0, 6).map(item => clip(item, 160)),
    refs: (prepared.refs ?? []).slice(0, 4).map(ref => ({ repository: clip(ref.repository, 200), pr: ref.pr, headSha: clip(ref.headSha, 80), baseSha: clip(ref.baseSha, 80) })),
    totals: { components: (prepared.components ?? []).length, effects: (prepared.effects ?? []).length, refs: (prepared.refs ?? []).length,
      checks: proof?.counts.checks ?? 0, limitations: proof?.counts.limitations ?? 0 },
    proof: proof ? { verified: proof.verified, observedAt: clip(proof.observedAt, 40), status: proof.status, reviewer: clip(proof.reviewer, 120),
      reportSha256: clip(proof.reportSha256, 80), reviewExcerpt: clip(proof.reviewExcerpt, REVIEW_EXCERPT),
      checks: proof.checks.slice(0, PROOF_CHECKS).map(check => ({ name: clip(check.name, 120), completedAt: clip(check.completedAt, 40),
        reportSha256: clip(check.reportSha256, 80), excerpt: clip(check.excerpt, CHECK_EXCERPT) })),
      limitations: proof.limitations.slice(0, LIMITATIONS).map(item => clip(item, LIMITATION_CHARS)) } : null }
}
