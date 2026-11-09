#!/usr/bin/env -S node --experimental-transform-types
/** Local operator only. Reconciles exact legacy deliveries as completed history; never sends, publishes, or accepts. */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DeliveryStore, deliveryFingerprint, LEGACY_RECONCILIATION_MAP } from '../src/app/feature-delivery.ts'
import type { LegacyHistoricalReconciliationRecord } from '../src/app/feature-delivery.ts'

function fail(message: string): never { throw new Error(message) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function recordsFrom(document: unknown): LegacyHistoricalReconciliationRecord[] {
  if (!object(document) || document.schemaVersion !== 1 || !Array.isArray(document.records) || !document.records.length) {
    fail('Expected schemaVersion 1 and nonempty records array')
  }
  const records = document.records as unknown[]
  if (records.length > 3) fail('At most 3 legacy records can be reconciled')
  const ids = new Set<string>()
  for (const record of records) {
    if (!object(record) || !text(record.deliveryId) || typeof record.revision !== 'number' || typeof record.sourceIssue !== 'number' || !text(record.originalWorkerId) || typeof record.releasePr !== 'number' || !text(record.releaseMergedSha) || !text(record.evidenceReference) || !text(record.attestation)) {
      fail('Invalid legacy reconciliation record structure')
    }
    if (ids.has(record.deliveryId)) fail(`Duplicate delivery ID: ${record.deliveryId}`)
    ids.add(record.deliveryId)
    const expected = LEGACY_RECONCILIATION_MAP[record.deliveryId]
    if (!expected) fail(`Unsupported delivery ID: ${record.deliveryId}`)
    if (record.sourceIssue !== expected.sourceIssue) fail(`Mismatched source issue for ${record.deliveryId}`)
    if (record.originalWorkerId !== expected.originalWorkerId) fail(`Mismatched worker ID for ${record.deliveryId}`)
    if (record.revision !== 3) fail(`Expected legacy revision 3 for ${record.deliveryId}`)
    if (record.releasePr !== 33) fail('Expected verified release PR #33')
    if (record.releaseMergedSha !== 'fb591843c3f9ff19965a49e45a4157ed195fc890') fail('Expected release merged SHA fb591843c3f9ff19965a49e45a4157ed195fc890')
    if (record.evidenceReference !== 'https://github.com/gera3d/dsh-superagent-prototype/pull/33') fail('Expected evidence reference https://github.com/gera3d/dsh-superagent-prototype/pull/33')
  }
  return records as unknown as LegacyHistoricalReconciliationRecord[]
}

try {
  const args = process.argv.slice(2)
  const usage = 'Usage: node --experimental-transform-types scripts/delivery-legacy-reconcile.ts --preview INPUT.json | --apply INPUT.json --database ABS_EXISTING_DB --expected-hash RECORDS_SHA256 --actor OPERATOR --reference INSTRUCTION_REF'
  if (!['--preview', '--apply'].includes(args[0] ?? '') || !args[1] || args[1].startsWith('-')) fail(usage)
  const mode = args[0] === '--apply' ? 'apply' : 'preview'
  const options = new Map<string, string>()
  if (mode === 'preview' && args.length !== 2) fail(usage)
  if (mode === 'apply') {
    if (args.length !== 10) fail(usage)
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1]!
      if (!['--database', '--expected-hash', '--review-hash', '--actor', '--reference'].includes(key) || options.has(key) || !text(value) || value.startsWith('--')) fail(usage)
      options.set(key, value)
    }
    const hash = options.get('--expected-hash') ?? options.get('--review-hash')
    if (!options.get('--database') || !hash || !options.get('--actor') || !options.get('--reference')) fail(usage)
    if (!isAbsolute(options.get('--database')!) || !/^[a-f0-9]{64}$/.test(hash)) fail('Apply requires an absolute existing database and exact reviewed records hash')
  }
  const document: unknown = JSON.parse(readFileSync(args[1], 'utf8'))
  const records = recordsFrom(document)
  const recordsFingerprint = deliveryFingerprint(records)
  const hash = options.get('--expected-hash') ?? options.get('--review-hash')
  if (mode === 'apply' && hash !== recordsFingerprint) fail('Reviewed records hash does not match; database not opened')
  // Pure store preview: memory store checks logic without opening target database.
  const memory = new DeliveryStore(':memory:')
  let preview: ReturnType<DeliveryStore['previewLegacyHistoricalReconciliation']>
  try {
    preview = memory.previewLegacyHistoricalReconciliation(records)
  } finally { memory.close() }
  const hashes = { documentFingerprint: deliveryFingerprint(document), recordsFingerprint }
  if (mode === 'preview') {
    process.stdout.write(`${JSON.stringify({ mode, readOnly: true, ...hashes, preview }, null, 2)}\n`)
  } else {
    const database = options.get('--database')!
    if (!statSync(database).isFile()) fail('Apply database must be an existing regular file')
    const store = new DeliveryStore(database)
    try {
      const deliveries = store.reconcileLegacyHistoricalCompletion(records, recordsFingerprint, {
        source: 'local_operator',
        actor: options.get('--actor')!,
        reference: options.get('--reference')!,
        scope: recordsFingerprint
      })
      process.stdout.write(`${JSON.stringify({ mode, readOnly: false, ...hashes, deliveries }, null, 2)}\n`)
    } finally { store.close() }
  }
} catch (error) {
  process.stderr.write(`Legacy reconciliation rejected: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
