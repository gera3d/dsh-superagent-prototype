import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueuePublicationOperator, parsePublicationOperatorArgs, readPublicationOperatorInstruction, reconcilePublicationOperator, type PublicationOperatorArgs, type PublicationOperatorInstruction } from '../src/app/publication-operator.ts'
import type { PublicationAuthority, PublicationSnapshot } from '../src/app/publication.ts'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const now = Date.parse('2026-11-06T00:00:00Z')
function fixture() {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'publication-operator-'))); directories.push(stateDir)
  const publication: PublicationSnapshot = { id: randomUUID(), ticketId: 'ticket', conversationId: 'conversation:canonical-decision', repository: 'owner/repo', prNumber: 159,
    headSha: 'a'.repeat(40), patchSha256: 'b'.repeat(64), status: 'prepared', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), outcomes: [], audit: [], requests: {} }
  const args: PublicationOperatorArgs = { action: 'publish', stateDir, publicationId: publication.id, headSha: publication.headSha, patchSha256: publication.patchSha256, actorId: 'codex-local-operator', instructionFile: join(stateDir, 'instruction.json') }
  const instruction: PublicationOperatorInstruction = { version: 1, authority: 'explicit_operator_instruction', approved: true, action: 'publish', actorId: args.actorId,
    publicationId: publication.id, ticketId: publication.ticketId, conversationId: publication.conversationId, repository: publication.repository, prNumber: publication.prNumber,
    headSha: publication.headSha, patchSha256: publication.patchSha256, requestId: randomUUID(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
    source: { reference: 'operator-trigger:explicit-159', instruction: 'Publish exactly this reviewed head and patch under the explicit operator instruction.' } }
  const save = (value: unknown = instruction) => writeFileSync(args.instructionFile, JSON.stringify(value), { mode: 0o600 })
  save()
  return { publication, args, instruction, save }
}
describe('trusted-local publication operator command', () => {
  it('requires fixed verb, exact flags and no arbitrary command/shell configuration', () => {
    const f = fixture()
    const argv = ['approve-publish', '--state-dir', f.args.stateDir, '--publication-id', f.publication.id, '--head', f.publication.headSha, '--patch', f.publication.patchSha256, '--actor', f.args.actorId, '--instruction-file', f.args.instructionFile]
    expect(parsePublicationOperatorArgs(argv)).toEqual(f.args)
    expect(() => parsePublicationOperatorArgs([...argv, '--command', 'restart everything'])).toThrow()
    expect(() => parsePublicationOperatorArgs(['autopilot', ...argv.slice(1)])).toThrow()
    expect(() => parsePublicationOperatorArgs(argv.map(v => v === '--patch' ? '--head' : v))).toThrow()
    expect(() => parsePublicationOperatorArgs(argv.slice(0, -2))).toThrow()
  })
  it('binds mode0600 current-uid explicit instruction bytes to every immutable publication field', async () => {
    const f = fixture(), proof = readPublicationOperatorInstruction(f.args, f.publication, now)
    expect(proof.authority.kind).toBe('operator_instruction'); expect(proof.authority.sourceProof?.recordSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(proof.authority.sourceProof?.reference).toBe(f.instruction.source.reference)
    let received: PublicationAuthority | undefined
    const result = await enqueuePublicationOperator(f.args, f.publication, { enqueue: async (input, authority) => {
      received = authority; expect(input.requestId).toBe(f.instruction.requestId); expect(input.action).toBe('publish'); return f.publication
    } }, now)
    expect(result.id).toBe(f.publication.id); expect(received?.sourceProof?.instruction).toBe(f.instruction.source.instruction)
    for (const patch of [{ actorId: 'other' }, { headSha: 'c'.repeat(40) }, { patchSha256: 'd'.repeat(64) }, { ticketId: 'other' }, { conversationId: 'other' }, { repository: 'other/repo' }, { prNumber: 160 }, { action: 'rollback' }, { publicationId: randomUUID() }]) {
      f.save({ ...f.instruction, ...patch })
      expect(() => readPublicationOperatorInstruction(f.args, f.publication, now)).toThrow()
    }
  })
  it('parses reconciliation only with exact grant, boolean confirmation and meaningful settlement evidence', () => {
    const f = fixture(), grantId = randomUUID()
    const argv = ['reconcile-interruption', '--state-dir', f.args.stateDir, '--publication-id', f.publication.id, '--head', f.publication.headSha, '--patch', f.publication.patchSha256, '--actor', f.args.actorId, '--instruction-file', f.args.instructionFile,
      '--grant-id', grantId, '--processes-settled', '--settlement-detail', 'Inspected exact process identities; all original descendants are settled.']
    expect(parsePublicationOperatorArgs(argv).reconciliation?.grantId).toBe(grantId)
    expect(() => parsePublicationOperatorArgs(argv.filter(v => v !== '--processes-settled'))).toThrow()
    expect(() => parsePublicationOperatorArgs(argv.map(v => v === grantId ? 'unbound' : v))).toThrow()
    expect(() => parsePublicationOperatorArgs([...argv.slice(0, -1), 'ok'])).toThrow()
  })
  it('reconciles only a protected explicit grant-bound record and NEVER enqueues rollback', async () => {
    const f = fixture(), confirmation = { grantId: randomUUID(), processesSettled: true as const, detail: 'Inspected exact original process identities and confirmed every descendant settled.' }
    const args: PublicationOperatorArgs = { ...f.args, action: 'rollback', reconciliation: confirmation }
    await expect(reconcilePublicationOperator(args, f.publication, { acknowledgeInterruption: async () => { throw new Error('must not call') } }, now)).rejects.toThrow()
    f.save({ ...f.instruction, action: 'rollback', reconciliation: confirmation })
    let calls = 0
    await reconcilePublicationOperator(args, f.publication, { acknowledgeInterruption: async (grantId, authority, settled) => {
      calls++; expect(grantId).toBe(confirmation.grantId); expect(authority.kind).toBe('operator_instruction'); expect(authority.sourceProof?.recordSha256).toBeTruthy(); expect(settled.processesSettled).toBe(true)
    } }, now)
    expect(calls).toBe(1)
    await expect(enqueuePublicationOperator(args, f.publication, { enqueue: async () => { throw new Error('must not enqueue') } }, now)).rejects.toThrow('never enqueues')
    f.save({ ...f.instruction, action: 'rollback', reconciliation: { ...confirmation, grantId: randomUUID() } })
    await expect(reconcilePublicationOperator(args, f.publication, { acknowledgeInterruption: async () => {} }, now)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects loose permissions, symlinks, implicit authority and invalid validity windows', () => {
    const f = fixture()
    chmodSync(f.args.instructionFile, 0o644)
    expect(() => readPublicationOperatorInstruction(f.args, f.publication, now)).toThrow('mode0600')
    chmodSync(f.args.instructionFile, 0o600)
    const link = join(f.args.stateDir, 'linked.json'); symlinkSync(f.args.instructionFile, link)
    expect(() => readPublicationOperatorInstruction({ ...f.args, instructionFile: link }, f.publication, now)).toThrow('canonical')
    for (const patch of [{ approved: false }, { authority: 'autopilot' }, { expiresAt: new Date(now - 1).toISOString() }, { expiresAt: new Date(now + 900001).toISOString() }, { createdAt: new Date(now + 60000).toISOString() }]) {
      f.save({ ...f.instruction, ...patch })
      expect(() => readPublicationOperatorInstruction(f.args, f.publication, now)).toThrow()
    }
  })
})
