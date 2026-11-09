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
describe('independent exact legacy identity and missing-worker fences', () => {
  it('does not hide a same-ID issue from another source repository', () => {
    const s = fixture('other/repository')
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('requires the actual original ended worker, not absence of a ticket row', () => {
    const s = fixture(); s.db.prepare('DELETE FROM ticket WHERE id=?').run(worker)
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('fails closed on malformed worker data rather than swallowing it', () => {
    const s = fixture(); s.db.prepare('UPDATE ticket SET value=? WHERE id=?').run('{invalid', worker)
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('cannot hide an additional active linked worker', () => {
    const s = fixture(); const extra='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    s.compareAndSwap(id, 3, d => { d.workers.push(extra) })
    // Preserve the original expected revision to isolate identity fencing, in this disposable fixture only.
    const row = s.db.prepare('SELECT value FROM feature_delivery WHERE id=?').get(id)!
    const value = JSON.parse(String(row.value)); value.revision=3
    s.db.prepare('UPDATE feature_delivery SET revision=3,value=? WHERE id=?').run(JSON.stringify(value), id)
    s.db.prepare('INSERT INTO ticket VALUES (?,?)').run(extra, JSON.stringify({ id: extra, assignments: [{ state: 'running' }] }))
    try { expect(() => reconcile(s)).toThrow(); expect(s.get(id)?.historicalCompletion).toBeUndefined() } finally { s.close() }
  })
  it('preserves original missing bindings and history for a genuine ended legacy record', () => {
    const s = fixture(); const before = s.get(id)!
    try {
      const after = reconcile(s)[0]!
      expect(after.bindings).toEqual(before.bindings)
      expect(after.scopeBinding).toEqual(before.scopeBinding)
      expect(after.requirements).toEqual(before.requirements)
      expect(after.authorities).toEqual(before.authorities)
      expect(after.acceptance).toBeUndefined()
      expect(after.evidence).toEqual(before.evidence)
      expect(after.audit.slice(0,before.audit.length)).toEqual(before.audit)
      expect(after.historicalCompletion).toBeDefined()
      expect(after.nextAction).toBeUndefined()
    } finally { s.close() }
  })
  it('fresh advisor context recognizes historical delivery without reopening an unbound release gate', () => {
    const s = fixture()
    try {
      const d = reconcile(s)[0]!
      const context = adviceContext(undefined, d)
      expect(context).toMatch(/historical|delivered by later release/i)
      expect(context).not.toContain('UNBOUND DELIVERY GATE:')
      expect(context).not.toContain('this delivery is already verified and accepted')
    } finally { s.close() }
  })

  it('shared option-quality filtering cannot regenerate release actions for reconciled historical scope', () => {
    const s = fixture()
    try {
      const d = reconcile(s)[0]!
      const context = deriveOptionQualityContext(adviceContext(undefined, d))
      expect(context.isDeliveryAccepted).toBe(false)
      const options = [
        { id: 'review', label: 'Review patch and test evidence', prompt: 'Have Codex review the patch and rerun tests.', recommended: true },
        { id: 'publish', label: 'Prepare deployment', prompt: 'Prepare and deploy the feature after review.' },
      ]
      expect(filterQualityOptions(options, context)).toEqual([])
    } finally { s.close() }
  })

})
