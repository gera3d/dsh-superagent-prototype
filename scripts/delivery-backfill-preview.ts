#!/usr/bin/env -S node --experimental-transform-types
/** Offline preview by default contract; apply requires explicit exact-hash operator arguments. */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'
import type { DeliveryBackfillRecord } from '../src/app/feature-delivery.ts'

function fail(message: string): never { throw new Error(message) }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const requirement = (issue: number) => issue === 159 ? 'native-browser-one-click' : 'ordinary-conversation-native-pilot'

function recordsFrom(document: unknown): DeliveryBackfillRecord[] {
  if (!object(document) || document.schemaVersion !== 1 || !Array.isArray(document.records) || document.records.length !== 2) fail('Expected schemaVersion 1 and exactly two records')
  const records = document.records as unknown[]
  const ids = new Set<string>()
  const issues = new Set<number>()
  for (const record of records) {
    if (!object(record) || ![159, 160].includes(Number(record.sourceIssue)) || typeof record.sourceIssue !== 'number' || !text(record.id) || !text(record.title) || !text(record.owner)) fail('Invalid sandbox intake')
    if (ids.has(record.id) || issues.has(record.sourceIssue)) fail('Duplicate backfill intake')
    ids.add(record.id); issues.add(record.sourceIssue)
    const bindings = record.bindings
    if (!object(bindings) || bindings.repository !== 'gera3d/superagent-sandbox' || bindings.sourceIssue !== record.sourceIssue || !sha(bindings.baseSha) || !sha(bindings.headSha) || !Array.isArray(bindings.refs) || !bindings.refs.length) fail('Invalid immutable bindings')
    if (bindings.refs.some(ref => !object(ref) || !['gera3d/dsh-superagent-prototype', 'gera3d/dsh-plugins'].includes(String(ref.repository)) || !Number.isInteger(ref.pr) || Number(ref.pr) < 1 || !sha(ref.headSha))) fail('Invalid code PR head binding')
    if (!Array.isArray(record.requirements) || record.requirements.length !== 1 || record.requirements[0] !== requirement(record.sourceIssue)) fail('Unexpected intake requirement')
    if (!Array.isArray(record.workers) || !record.workers.length || record.workers.some(worker => !object(worker) || !text(worker.id) || !/^[a-f0-9]{32}$/.test(worker.id) || worker.ended !== true || worker.merged !== true)) fail('Workers must be bare ended/merged ticket IDs, not worker-prefixed session IDs')
    if (!Array.isArray(record.evidence) || !record.evidence.length) fail('Missing evidence')
    const evidenceIds = new Set<string>()
    for (const evidence of record.evidence) {
      if (!object(evidence) || !text(evidence.id) || evidenceIds.has(evidence.id) || !['implementation', 'review', 'publication', 'verification', 'rollback'].includes(String(evidence.kind)) || !['passed', 'failed', 'uncertain'].includes(String(evidence.outcome)) || !text(evidence.recordedAt) || !Number.isFinite(Date.parse(evidence.recordedAt)) || !text(evidence.reference)) fail('Invalid or duplicate evidence')
      const url = new URL(evidence.reference)
      if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || !/^\/gera3d\/(superagent-sandbox|dsh-superagent-prototype|dsh-plugins)\//.test(url.pathname)) fail('Expected public GitHub evidence reference')
      if (evidence.kind === 'verification' && evidence.outcome === 'passed') fail('Native acceptance requirements remain pending')
      evidenceIds.add(evidence.id)
    }
  }
  return records as unknown as DeliveryBackfillRecord[]
}

try {
  const args = process.argv.slice(2)
  const usage = 'Usage: node --experimental-transform-types scripts/delivery-backfill-preview.ts --preview INPUT.json | --apply INPUT.json --database ABS_EXISTING_DB --review-hash RECORDS_SHA256 --actor OPERATOR --reference INSTRUCTION_REF'
  if (!['--preview', '--apply'].includes(args[0] ?? '') || !args[1] || args[1].startsWith('-')) fail(usage)
  const mode = args[0] === '--apply' ? 'apply' : 'preview'
  const options = new Map<string, string>()
  if (mode === 'preview' && args.length !== 2) fail(usage)
  if (mode === 'apply') {
    if (args.length !== 10) fail(usage)
    for (let i = 2; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1]!
      if (!['--database', '--review-hash', '--actor', '--reference'].includes(key) || options.has(key) || !text(value) || value.startsWith('--')) fail(usage)
      options.set(key, value)
    }
    if (options.size !== 4 || !isAbsolute(options.get('--database')!) || !/^[a-f0-9]{64}$/.test(options.get('--review-hash')!)) fail('Apply requires an absolute existing database and exact reviewed records hash')
  }
  const document: unknown = JSON.parse(readFileSync(args[1], 'utf8'))
  const records = recordsFrom(document)
  const recordsFingerprint = deliveryFingerprint(records)
  if (mode === 'apply' && options.get('--review-hash') !== recordsFingerprint) fail('Reviewed records hash does not match; database not opened')
  // Always validate via the pure store preview before opening an apply target.
  const memory = new DeliveryStore(':memory:')
  let preview: ReturnType<DeliveryStore['previewBackfill']>
  try {
    preview = memory.previewBackfill(records)
    if (memory.list().length || memory.db.prepare('SELECT count(*) AS n FROM feature_delivery_outbox').get()?.n !== 0) fail('Preview unexpectedly mutated in-memory state')
  } finally { memory.close() }
  const hashes = { documentFingerprint: deliveryFingerprint(document), recordsFingerprint }
  if (mode === 'preview') {
    process.stdout.write(`${JSON.stringify({ mode, readOnly: true, ...hashes, preview }, null, 2)}\n`)
  } else {
    const database = options.get('--database')!
    if (!statSync(database).isFile()) fail('Apply database must be an existing regular file')
    const store = new DeliveryStore(database)
    try {
      const deliveries = store.applyBackfill(records, recordsFingerprint, { source: 'local_operator', actor: options.get('--actor')!, reference: options.get('--reference')!, scope: recordsFingerprint })
      process.stdout.write(`${JSON.stringify({ mode, readOnly: false, ...hashes, deliveries }, null, 2)}\n`)
    } finally { store.close() }
  }
} catch (error) {
  process.stderr.write(`Backfill preview rejected: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
