import { describe, it, expect } from 'vitest'
import { deriveOptionQualityContext, filterQualityOptions } from '../src/app/option-quality.ts'
import { adviceContext } from '../src/app/advice-context.ts'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'

const id = 'auto-1aa9568a8df574db0cef146a58004c4b'
const worker = '1aa9568a8df574db0cef146a58004c4b'
const record = { deliveryId: id, revision: 3, sourceIssue: 184, originalWorkerId: worker, releasePr: 33, releaseMergedSha: 'fb591843c3f9ff19965a49e45a4157ed195fc890', evidenceReference: 'https://github.com/gera3d/dsh-superagent-prototype/pull/33', attestation: 'Operator independently checked source issue closure, later release and current live feature evidence.' }
function fixture(repository = 'gera3d/superagent-sandbox') {
  const store = new DeliveryStore(':memory:')
  const d = store.trackUnbound({ ticketId: worker, title: 'Legacy delivery', owner: `worker:${worker}`, repository, sourceIssue: 184, triggerId: '94e8322655e0271463212f4999519ab9' })
  store.compareAndSwap(d.id, 1, v => { v.stage = 'review'; v.state = 'blocked' })
  store.compareAndSwap(d.id, 2, () => {})
  store.db.exec('CREATE TABLE ticket(id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  store.db.prepare('INSERT INTO ticket VALUES (?, ?)').run(worker, JSON.stringify({ id: worker, ended: { by: 'executor', outcome: 'closed', at: '2026-11-07T02:22:10Z' }, origin: { triggerId: '94e8322655e0271463212f4999519ab9', triggerIds: ['94e8322655e0271463212f4999519ab9'] }, mandate: { strength: 'explicit', basis: { source: 'github', scope: { number: 184, isPr: false, kind: 'issue' }, row: 'issues' } }, assignments: [{ state: 'done' }] }))
  return store
}
const reconcile = (store: DeliveryStore) => {
  const hash = deliveryFingerprint([record])
  return store.reconcileLegacyHistoricalCompletion([record], hash, { source: 'local_operator', actor: 'codex-coordinator', scope: hash, reference: 'user-approved-legacy-reconciliation' })
}
describe('independent historical advisor pipeline', () => {
  it('shared option-quality filtering cannot regenerate release actions for reconciled historical scope', () => {
    const s = fixture()
    try {
      const d = reconcile(s)[0]!
      const context = deriveOptionQualityContext(adviceContext(undefined, d))
      expect(context.isDeliveryAccepted).toBe(false)
      const options = [
        { id: 'review', label: 'Review patch and test evidence', prompt: 'Have Codex review the patch and rerun tests.', why: 'Repeat old review', recommended: true },
        { id: 'publish', label: 'Prepare deployment', prompt: 'Prepare and deploy the feature after review.', why: 'Repeat old deployment', recommended: false },
      ]
      expect(filterQualityOptions(options, context)).toEqual([])
    } finally { s.close() }
  })

  it('preserves read-only history inspection and explicit prohibitions', () => {
    const s = fixture()
    try {
      const context = deriveOptionQualityContext(adviceContext(undefined, reconcile(s)[0]!))
      const options = [
        { id: 'history', label: 'Inspect recorded results', prompt: 'Read the saved reconciliation evidence.', why: 'Read history', recommended: true },
        { id: 'stop', label: 'Stop here', prompt: 'Do not rerun tests or deploy this completed release.', why: 'No repeated work', recommended: false },
      ]
      expect(filterQualityOptions(options, context)).toEqual(options)
    } finally { s.close() }
  })
  it('does not suppress a separate ordinary new-request scope', () => {
    const options = [{ id: 'new', label: 'Review new patch', prompt: 'Review the newly requested patch.', why: 'New requested work', recommended: true }]
    const context = deriveOptionQualityContext(undefined, { taskScope: 'Review a new patch requested now' })
    expect(filterQualityOptions(options, context).some(o => o.id === 'new')).toBe(true)
  })

})
