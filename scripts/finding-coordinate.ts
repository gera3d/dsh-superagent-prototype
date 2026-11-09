#!/usr/bin/env -S node --experimental-strip-types
/**
 * Headless operator CLI for advancing already-approved bounded findings.
 * Does not impersonate browser approval headers or accept work.
 */
import { writeFileSync, unlinkSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { observationBase } from './finding-observe.ts'
import { FindingCoordinationInstructionSchema, type FindingCoordinationInstruction } from '../src/app/finding-coordination.ts'

export async function coordinateFindingCli(args: string[]): Promise<unknown> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Usage: finding-coordinate.ts --url http://127.0.0.1:PORT --finding-id UUID --revision REV --action retry_scope|confirm|defer [--choice fix_now|queue_next|defer] --actor ACTOR --reference REF --reason REASON',
    )
    return { usage: true }
  }

  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (!key.startsWith('--')) throw new Error(`Unexpected non-flag argument: ${key}`)
    if (options.has(key)) throw new Error(`Duplicate flag: ${key}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for flag: ${key}`)
    options.set(key, value)
  }

  const url = options.get('--url')
  const findingId = options.get('--finding-id')
  const revisionStr = options.get('--revision')
  const action = options.get('--action')
  const choice = options.get('--choice')
  const actor = options.get('--actor')
  const reference = options.get('--reference')
  const reason = options.get('--reason')

  if (!url || !findingId || !revisionStr || !action || !actor || !reference || !reason) {
    throw new Error('Required flags: --url, --finding-id, --revision, --action, --actor, --reference, --reason')
  }

  const origin = observationBase(url)
  const revision = Number(revisionStr)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('--revision must be a positive integer')

  const now = new Date()
  const instruction: FindingCoordinationInstruction = FindingCoordinationInstructionSchema.parse({
    version: 1,
    authority: 'explicit_operator_coordination',
    findingId,
    revision,
    action,
    ...(choice ? { choiceId: choice } : {}),
    actorId: actor,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    source: { reference, reason },
  })

  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'finding-coord-')))
  const instructionFile = join(tempDir, 'instruction.json')
  writeFileSync(instructionFile, JSON.stringify(instruction), { mode: 0o600 })

  try {
    const response = await fetch(new URL(`/orchestrator/api/findings/${encodeURIComponent(findingId)}/coordinate`, origin), {
      method: 'POST',
      headers: {
        'x-orchestrator-request': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ instructionFile }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })

    const body: unknown = await response.json()
    if (!response.ok) {
      throw new Error(`Coordination transport rejected (${response.status}): ${JSON.stringify(body)}`)
    }
    return body
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

export async function main(args: string[]): Promise<void> {
  const result = await coordinateFindingCli(args)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
