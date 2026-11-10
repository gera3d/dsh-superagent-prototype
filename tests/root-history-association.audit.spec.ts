import { expect, it } from 'vitest'
import { activeDeliveryForSession } from '../src/client/finding-association.ts'
it('real reconciled blocked historical delivery does not suppress later ordinary thread advice', () => {
 const item:any={
  "id": "delivery-auto-1aa9568a8df574db0cef146a58004c4b",
  "status": "stale",
  "sessionId": "worker-1aa9568a8df574db0cef146a58004c4b",
  "delivery": {
    "id": "auto-1aa9568a8df574db0cef146a58004c4b",
    "state": "blocked",
    "workers": [
      "1aa9568a8df574db0cef146a58004c4b"
    ],
    "historicalCompletion": {
      "reconciledAt": "2026-11-09T23:28:39.073Z",
      "operator": "codex-coordinator",
      "attestation": "User explicitly requested reconciliation of these exact three legacy records. Codex independently confirmed original ended worker identity, closed-completed GitHub issue and later PR33 merged release; original artifact is historical/superseded, not another release. Current installed feature verified: Saved conservation controls present; current normal hierarchy and provider marks retained; seven routing policy cases included in60tests. Detailed current and historical proof: https://github.com/gera3d/dsh-superagent-prototype/blob/superagent-core/docs/evidence/legacy-delivery-reconciliation-proof.json . No original missing pins, acceptance, new authority, new dispatch or publication inferred. Preserve original history; only reconcile this obsolete pending record as delivered by later release.",
      "evidenceReference": "https://github.com/gera3d/dsh-superagent-prototype/pull/33",
      "sourceIssue": 184,
      "releasePr": 33,
      "releaseMergedSha": "fb591843c3f9ff19965a49e45a4157ed195fc890",
      "caption": "Delivered by later release PR #33 (fb59184); source issue #184 closed. Retained as completed/superseded history; not typed delivery acceptance.",
      "fingerprint": "581a152cd6d2a2277380f7a11b54e24bc74e08e5c9920443fec5c7a653a73866"
    }
  }
}
 expect(activeDeliveryForSession(item,"worker-1aa9568a8df574db0cef146a58004c4b")).toBe(false)
})
