#!/usr/bin/env -S node --experimental-transform-types
/** Trusted local operator receipt only. No execution, publication, acceptance or network effects. */
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ProgressObservationSchema, ProgressStore } from '../src/app/progress.ts'

try {
  const args = process.argv.slice(2), options = new Map<string, string>()
  const preview = args.includes('--preview')
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!
    if (name === '--preview') { if (args.indexOf(name) !== i) throw new Error('Duplicate preview'); continue }
    if (!['--database', '--input', '--expected-hash', '--reference'].includes(name) || options.has(name)) throw new Error('Unknown or duplicate argument')
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error('Missing argument value')
    options.set(name, value)
  }
  const input = options.get('--input'); if (!input) throw new Error('Required: --input RECEIPT.json')
  const receipt = ProgressObservationSchema.parse(JSON.parse(readFileSync(input, 'utf8')))
  const fingerprint = createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
  if (preview) {
    if (options.size !== 1) throw new Error('Preview accepts only --input; no database opened')
    console.log(JSON.stringify({ fingerprint, receipt, execution_authorized: false }))
  } else {
    const path = options.get('--database'), reference = options.get('--reference')
    if (!path || !isAbsolute(path) || !statSync(path).isFile() || !reference?.trim() || reference.length > 1000 || options.get('--expected-hash') !== fingerprint)
      throw new Error('Require existing absolute database, reference and exact reviewed expected-hash')
    const db = new DatabaseSync(path)
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
      const row = db.prepare('SELECT value FROM ticket WHERE id=?').get(receipt.ticketId)
      if (!row) throw new Error('Receipt must reference an existing ticket')
      const ticket = JSON.parse(String(row.value))
      const jobId = ticket.mandate?.basis?.scope?.jobId
      if (receipt.jobId && receipt.jobId !== jobId) throw new Error('Receipt job association does not match ticket')
      const store = new ProgressStore(db)
      const result = store.observe(receipt, { source: 'operator', reference, actor: 'local-operator' })
      db.exec('COMMIT')
      console.log(JSON.stringify({ ...result, current: store.current(receipt.ticketId), execution_authorized: false }))
    } finally { db.close() }
  }
} catch (error) {
  console.error(`Progress receipt rejected: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
