#!/usr/bin/env -S node --experimental-transform-types
/** Local operator only. Records external observations; never sends, publishes or runs workers. */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DeliveryStore, deliveryFingerprint } from '../src/app/feature-delivery.ts'
import { recordOperatorEvidence } from '../src/app/delivery-evidence.ts'
import type { OperatorEvidenceRequest } from '../src/app/delivery-evidence.ts'

try {
  const args = process.argv.slice(2), options = new Map<string, string>()
  let accept = false, preview = false
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (key === '--accept') { if (accept) throw new Error('Duplicate --accept'); accept = true; continue }
    if (key === '--preview') { if (preview) throw new Error('Duplicate --preview'); preview = true; continue }
    if (!['--database', '--delivery', '--revision', '--actor', '--reference', '--input', '--expected-hash'].includes(key) || options.has(key)) throw new Error('Unknown or duplicate argument')
    const value = args[++i]
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options.set(key, value)
  }
  const deliveryId = options.get('--delivery'), revisionText = options.get('--revision'), input = options.get('--input')
  if (!deliveryId || !revisionText || !/^[1-9][0-9]*$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText)) || !input) throw new Error('Required: --delivery ID --revision CURRENT_REVISION --input EVIDENCE_ARRAY.json')
  const evidence: unknown = JSON.parse(readFileSync(input, 'utf8'))
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('Input must be a nonempty JSON array of exact-bound evidence records')
  const request: OperatorEvidenceRequest = { deliveryId, revision: Number(revisionText), evidence, ...(accept ? { accept: true } : {}) }
  const requestFingerprint = deliveryFingerprint(request)
  if (preview) {
    if (options.has('--database') || options.has('--actor') || options.has('--reference') || options.has('--expected-hash')) throw new Error('Preview accepts only delivery, revision, input and optional accept; no database is opened')
    process.stdout.write(`${JSON.stringify({ mode: 'request-preview', requestFingerprint, request }, null, 2)}\n`)
  } else {
    const database = options.get('--database'), actor = options.get('--actor'), reference = options.get('--reference'), hash = options.get('--expected-hash')
    if (!database || !isAbsolute(database) || !actor || !reference || hash !== requestFingerprint) throw new Error('Requires existing absolute --database, recorded --actor, explicit --reference and exact reviewed --expected-hash; database not opened')
    if (!statSync(database).isFile()) throw new Error('Database must be an existing regular file')
    const store = new DeliveryStore(database)
    try {
      const delivery = recordOperatorEvidence(store, request, hash, { source: 'local_operator', actor, reference, scope: hash })
      process.stdout.write(`${JSON.stringify({ mode: 'record-operator-evidence', requestFingerprint, delivery }, null, 2)}\n`)
    } finally { store.close() }
  }
} catch (error) {
  process.stderr.write(`Operator evidence rejected: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
