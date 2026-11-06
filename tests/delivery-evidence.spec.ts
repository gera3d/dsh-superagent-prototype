import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'
import type { DeliveryBackfillRecord, DeliveryEvidence, DeliveryConfirmationAuthority } from '../src/app/feature-delivery.ts'
import { recordOperatorEvidence } from '../src/app/delivery-evidence.ts'
import type { OperatorEvidenceRequest } from '../src/app/delivery-evidence.ts'
import { deliveryDecision, reconcileDeliveryAdvice } from '../src/app/delivery-runtime.ts'
import type { PendingDecisionItem } from '../src/core/decision.ts'

let dir: string, path: string, store: DeliveryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operator-evidence-')); path = join(dir, 'isolated.sqlite'); store = new DeliveryStore(path)
  const records = JSON.parse(readFileSync(new URL('../docs/018-delivery-backfill.json', import.meta.url), 'utf8')).records as DeliveryBackfillRecord[]
  const hash = deliveryFingerprint(records)
  store.applyBackfill(records, hash, { source: 'local_operator', actor: 'alice', reference: 'isolated-backfill-review', scope: hash })
})
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
function observation(kind: DeliveryEvidence['kind'], issue = 159, extra: Partial<DeliveryEvidence> = {}): DeliveryEvidence {
  const d = store.get(`sandbox-${issue}`)!
  return { id: `fixture-${issue}-${kind}`, kind, outcome: 'passed', bindings: d.bindings, recordedAt: '2026-11-06T15:00:00Z', reference: `https://evidence.example/isolated/${issue}/${kind}`, ...(['verification', 'acceptance'].includes(kind) ? { requirements: d.requirements } : {}), ...extra }
}
function request(issue = 159, accept = false): OperatorEvidenceRequest {
  const d = store.get(`sandbox-${issue}`)!
  const supersedes = d.evidence.filter(e => e.kind === 'rollback' || e.kind === 'publication' && e.outcome !== 'passed').map(e => e.id)
  return { deliveryId: d.id, revision: d.revision, evidence: [observation('publication', issue, { supersedes }), observation('verification', issue)], ...(accept ? { accept: true } : {}) }
}
function authority(r: OperatorEvidenceRequest): DeliveryConfirmationAuthority { return { source: 'local_operator', actor: 'alice', reference: 'explicit-isolated-observation', scope: deliveryFingerprint(r) } }
function record(r: OperatorEvidenceRequest) { return recordOperatorEvidence(store, r, deliveryFingerprint(r), authority(r), '2026-11-06T15:01:00Z') }

it('applies the actual checked-in backfill using bare ticket IDs and retires pre-merge #160 generated advice', () => {
  const expected = ['3b4864f597572937fdf1c6b7c019c1d6', 'a8ecebad8bea17f9dc48a704c5f5ed7e']
  const records = JSON.parse(readFileSync(new URL('../docs/018-delivery-backfill.json', import.meta.url), 'utf8')).records as DeliveryBackfillRecord[]
  for (const [index, record] of records.entries()) {
    const d = store.get(record.id)!
    expect(d.workers).toEqual([expected[index]])
    expect(deliveryDecision(d).ticketId).toBe(expected[index])
    expect(deliveryDecision(d).sessionId).toBe(`worker-${expected[index]}`)
    expect(d.state).toBe('blocked'); expect(d.stage).toBe('verifying')
  }
  const d = store.get('sandbox-160')!
  expect(d.evidence[0]!.kind).toBe('implementation')
  expect(d.evidence[0]!.recordedAt).toBe('2026-11-06T09:04:28Z') // Actual PR161 merge, not a review verdict.
  const generated: PendingDecisionItem = {
    ...deliveryDecision(d), id: 'chat-87ea0c47a21b08bcaf36b5858cc94d24',
    actionMode: 'stage_response', createdAt: 1793954129270, context: '',
    question: 'Choose the next step for this thread', choices: [],
    advisor: { key: 'stripped-source-empty-advice', status: 'ready', model: 'Senior Developer' },
  }
  delete generated.delivery
  expect(reconcileDeliveryAdvice([generated], [d])[0]!.status).toBe('stale')
  expect(reconcileDeliveryAdvice([{ ...generated, context: 'Real unresolved user question' }], [d])[0]!.status).toBe('pending')
  expect(reconcileDeliveryAdvice([{ ...generated, createdAt: Date.parse('2026-11-06T09:04:29Z') }], [d])[0]!.status).toBe('pending')
  expect(reconcileDeliveryAdvice([generated], [{ ...d, audit: [] }])[0]!.status).toBe('pending')
})
it.each([159, 160])('records exact-bound native evidence for #%s without acceptance or publication', issue => {
  const r = request(issue), before = store.get(r.deliveryId)!, d = record(r)
  expect(d.state).toBe('awaiting_decision'); expect(d.stage).toBe('verifying'); expect(d.nextAction?.kind).toBe('accept'); expect(d.acceptance).toBeUndefined()
  expect(d.evidence.slice(0, before.evidence.length)).toEqual(before.evidence); expect(d.audit.slice(0, before.audit.length)).toEqual(before.audit)
  expect(d.workers).toEqual(before.workers); expect(d.revision).toBe(before.revision + 1)
  expect(d.audit.at(-1)).toMatchObject({ actor: 'alice', event: expect.stringContaining(`operator-evidence:${deliveryFingerprint(r)}:`) })
  expect(store.db.prepare('SELECT count(*) AS n FROM feature_delivery_outbox').get()!.n).toBe(0)
})
it('idempotently replays the exact stale original request and rejects changed reused IDs', () => {
  const r = request(), first = record(r); expect(record(r)).toEqual(first)
  const changed = structuredClone(r); changed.evidence[0]!.reference = 'https://evidence.example/changed'
  expect(() => record(changed)).toThrow('ID reused'); expect(store.get(r.deliveryId)).toEqual(first)
})
it('uses explicit accept only with the new action fingerprint and local-operator provenance', () => {
  const r = request(159, true), d = record(r)
  expect(d.state).toBe('accepted'); expect(d.acceptance?.actor).toBe('alice'); expect(d.audit.at(-1)?.event).toContain('confirmed:accept:local_operator:')
  expect(record(r)).toEqual(d); expect(d.audit.some(a => a.event.includes('human_click'))).toBe(false)
  expect(store.db.prepare('SELECT count(*) AS n FROM feature_delivery_outbox').get()!.n).toBe(0)
})
it('rolls back evidence and audit if explicit acceptance remains ineligible', () => {
  const r = request(); r.accept = true; r.evidence = [observation('verification')]
  const before = store.get(r.deliveryId)
  expect(() => record(r)).toThrow('full current publication'); expect(store.get(r.deliveryId)).toEqual(before)
})
it('keeps unresolved rollback and failures blocked without explicit supersession', () => {
  const r = request(); delete r.evidence[0]!.supersedes
  const d = record(r); expect(d.state).toBe('blocked'); expect(d.nextAction).toBeUndefined(); expect(d.evidence.some(e => e.kind === 'rollback')).toBe(true)
})
it('can record partial #160 verification without claiming publication or accepting', () => {
  const r = request(160); r.evidence = [observation('verification', 160)]
  const d = record(r); expect(d.state).toBe('awaiting_decision'); expect(d.nextAction?.kind).toBe('verify'); expect(d.acceptance).toBeUndefined()
})
it.each([
  ['wrong head', (r: OperatorEvidenceRequest) => { r.evidence[0]!.bindings = { ...r.evidence[0]!.bindings, headSha: '0'.repeat(40) } }],
  ['wrong requirement', (r: OperatorEvidenceRequest) => { r.evidence[1]!.requirements = ['invented'] }],
  ['missing native requirement', (r: OperatorEvidenceRequest) => { delete r.evidence[1]!.requirements }],
  ['wrong generation', (r: OperatorEvidenceRequest) => { r.evidence[1]!.generation = 100 }],
  ['duplicate evidence ID', (r: OperatorEvidenceRequest) => { r.evidence[1]!.id = r.evidence[0]!.id }],
  ['bad time', (r: OperatorEvidenceRequest) => { r.evidence[0]!.recordedAt = 'not a date' }],
  ['credential reference', (r: OperatorEvidenceRequest) => { r.evidence[0]!.reference = 'https://user:secret@evidence.example/a' }],
  ['wrong kind reconciliation', (r: OperatorEvidenceRequest) => { r.evidence[1]!.supersedes = r.evidence[0]!.supersedes; delete r.evidence[0]!.supersedes }],
  ['unknown superseded ID', (r: OperatorEvidenceRequest) => { r.evidence[0]!.supersedes = ['missing'] }],
  ['self reconciliation', (r: OperatorEvidenceRequest) => { r.evidence[0]!.supersedes = [r.evidence[0]!.id] }],
  ['passed evidence supersession', (r: OperatorEvidenceRequest) => { r.evidence[0]!.supersedes = [store.get(r.deliveryId)!.evidence[0]!.id] }],
  ['unexpected privileged property', (r: OperatorEvidenceRequest) => { Object.assign(r.evidence[0]!, { human_click: true }) }],
] as const)('rejects %s without changing history', (_name, mutate) => {
  const r = request(); const before = store.get(r.deliveryId); mutate(r)
  expect(() => record(r)).toThrow(); expect(store.get(r.deliveryId)).toEqual(before)
})
it.each(['failed', 'uncertain'] as const)('records an honest %s observation and retains blocked state', outcome => {
  const r = request(160); r.evidence = [observation('verification', 160, { outcome })]
  const d = record(r); expect(d.state).toBe('blocked'); expect(d.evidence.at(-1)?.outcome).toBe(outcome); expect(d.nextAction).toBeUndefined()
})
it('records acceptance-kind evidence without substituting for native verification or confirming acceptance', () => {
  const r = request(160); r.evidence = [observation('acceptance', 160)]
  const d = record(r); expect(d.state).toBe('awaiting_decision'); expect(d.nextAction?.kind).toBe('verify'); expect(d.acceptance).toBeUndefined()
})
it('records rollback without discarding the publication history', () => {
  const r = request(160); r.evidence = [observation('rollback', 160)]
  const d = record(r); expect(d.state).toBe('blocked'); expect(d.evidence.at(-1)?.kind).toBe('rollback')
})
it('rejects wrong actor, source, hash and revision', () => {
  const r = request(), hash = deliveryFingerprint(r), a = authority(r), before = store.get(r.deliveryId)
  expect(() => recordOperatorEvidence(store, r, hash, { ...a, actor: 'mallory' })).toThrow('authority')
  expect(() => recordOperatorEvidence(store, r, hash, { ...a, source: 'github' })).toThrow('local operator')
  expect(() => recordOperatorEvidence(store, r, '0'.repeat(64), a)).toThrow('hash')
  r.revision++; expect(() => record(r)).toThrow('Stale'); expect(store.get(r.deliveryId)).toEqual(before)
})
it('rejects unsettled mutation handoffs and leaves the outbox untouched', () => {
  const r = request(), before = store.get(r.deliveryId)
  store.db.prepare('INSERT INTO feature_delivery_outbox(id,delivery_id,value,status) VALUES(?,?,?,?)').run('parked', r.deliveryId, '{}', 'blocked')
  expect(() => record(r)).toThrow('Outstanding handoff'); expect(store.get(r.deliveryId)).toEqual(before)
  expect(store.db.prepare('SELECT status FROM feature_delivery_outbox WHERE id=?').get('parked')!.status).toBe('blocked')
})
it('preserves unrelated worker/publication records and persists exact replay after reopening', () => {
  store.db.exec("CREATE TABLE ticket(id TEXT PRIMARY KEY,value TEXT); INSERT INTO ticket VALUES('old','ended'); CREATE TABLE publication(id TEXT PRIMARY KEY,value TEXT); INSERT INTO publication VALUES('old','rolled_back')")
  const r = request(), first = record(r); store.close(); store = new DeliveryStore(path)
  expect(record(r)).toEqual(first)
  expect(store.db.prepare('SELECT value FROM ticket').get()!.value).toBe('ended'); expect(store.db.prepare('SELECT value FROM publication').get()!.value).toBe('rolled_back')
})
it('CLI explicitly accepts only when --accept is included in the reviewed request', () => {
  const r = request(160, true), input = join(dir, 'synthetic-acceptance.json'); writeFileSync(input, JSON.stringify(r.evidence))
  const command = (args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('../scripts/delivery-evidence.ts', import.meta.url)), ...args], { encoding: 'utf8' })
  const base = ['--delivery', r.deliveryId, '--revision', String(r.revision), '--input', input]
  const preview = command(['--preview', ...base, '--accept']); expect(preview.status, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).requestFingerprint).toBe(deliveryFingerprint(r))
  const authority = ['--database', path, '--actor', 'alice', '--reference', 'isolated-explicit-accept', '--expected-hash', deliveryFingerprint(r)]
  expect(command([...base, ...authority]).status).toBe(1)
  const result = command([...base, ...authority, '--accept']); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).delivery.state).toBe('accepted')
  expect(command([...base, ...authority, '--accept']).status).toBe(0)
})
it('CLI previews a hash offline, records against only isolated DB, and rejects stale/hash/flag misuse', () => {
  const r = request(), input = join(dir, 'synthetic-native-evidence.json'); writeFileSync(input, JSON.stringify(r.evidence))
  const command = (args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('../scripts/delivery-evidence.ts', import.meta.url)), ...args], { encoding: 'utf8' })
  const base = ['--delivery', r.deliveryId, '--revision', String(r.revision), '--input', input]
  const preview = command(['--preview', ...base]); expect(preview.status, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).requestFingerprint).toBe(deliveryFingerprint(r))
  const args = [...base, '--database', path, '--actor', 'alice', '--reference', 'isolated-cli-review', '--expected-hash', deliveryFingerprint(r)]
  expect(command(args.map(v => v === deliveryFingerprint(r) ? '0'.repeat(64) : v)).status).toBe(1)
  expect(command(['--preview', ...base, '--database', path]).status).toBe(1)
  const result = command(args); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).delivery.nextAction.kind).toBe('accept')
  expect(command(args).status).toBe(0)
  expect(command([...base, '--accept']).status).toBe(1)
})
