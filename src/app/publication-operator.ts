/** Trusted-local operator CLI validation. Not an agent tool, HTTP authority parser, or remote-human authenticator. */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { PublicationError, type PublicationAuthority, type PublicationSnapshot } from './publication.ts'
import type { PublicationCoordinator } from './publication-worker.ts'

export interface PublicationOperatorArgs {
  action: 'publish' | 'rollback'; stateDir: string; publicationId: string; headSha: string; patchSha256: string; actorId: string; instructionFile: string
  reconciliation?: { grantId: string; processesSettled: true; detail: string }
}
const instructionSchema = z.object({
  version: z.literal(1), authority: z.literal('explicit_operator_instruction'), approved: z.literal(true),
  action: z.enum(['publish', 'rollback']), actorId: z.string().min(1).max(200), publicationId: z.string().uuid(),
  ticketId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  prNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/), patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  source: z.object({ reference: z.string().min(1).max(2048), instruction: z.string().min(10).max(8192) }).strict(),
  reconciliation: z.object({ grantId: z.string().uuid(), processesSettled: z.literal(true), detail: z.string().min(10).max(4096) }).strict().optional(),
}).strict()
export type PublicationOperatorInstruction = z.infer<typeof instructionSchema>

/** Fixed verbs and exact target flags only; there are no executable/script/shell options. */
export function parsePublicationOperatorArgs(argv: string[]): PublicationOperatorArgs {
  const [verb, ...rest] = argv
  const reconcile = verb === 'reconcile-interruption'
  if (!['approve-publish', 'rollback', 'reconcile-interruption'].includes(verb ?? '') || rest.length !== (reconcile ? 17 : 12)) throw new PublicationError(400, 'Usage: publication-operator approve-publish|rollback|reconcile-interruption --state-dir PATH --publication-id UUID --head SHA --patch SHA256 --actor ACTOR --instruction-file PATH [--grant-id UUID --processes-settled --settlement-detail EVIDENCE]')
  const allowed = new Set(['--state-dir', '--publication-id', '--head', '--patch', '--actor', '--instruction-file', ...(reconcile ? ['--grant-id', '--processes-settled', '--settlement-detail'] : [])])
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!
    if (!allowed.has(key) || values.has(key)) throw new PublicationError(400, 'Unknown, missing or duplicate operator flag')
    if (key === '--processes-settled') { values.set(key, 'true'); continue }
    const value = rest[++i]
    if (!value || value.startsWith('--')) throw new PublicationError(400, 'Missing operator flag value')
    values.set(key, value)
  }
  if (values.size !== allowed.size || !isAbsolute(values.get('--state-dir')!) || !isAbsolute(values.get('--instruction-file')!)
    || !z.string().uuid().safeParse(values.get('--publication-id')).success || !/^[a-f0-9]{40}$/.test(values.get('--head')!) || !/^[a-f0-9]{64}$/.test(values.get('--patch')!) || values.get('--actor')!.length > 200) throw new PublicationError(400, 'Operator flags must bind an exact publication, head and patch')
  if (reconcile && (!z.string().uuid().safeParse(values.get('--grant-id')).success || values.get('--processes-settled') !== 'true'
    || values.get('--settlement-detail')!.trim().length < 10 || values.get('--settlement-detail')!.length > 4096)) throw new PublicationError(400, 'Reconciliation requires exact grant and meaningful process-settlement confirmation')
  return { action: verb === 'approve-publish' ? 'publish' : 'rollback', stateDir: values.get('--state-dir')!, publicationId: values.get('--publication-id')!, headSha: values.get('--head')!, patchSha256: values.get('--patch')!, actorId: values.get('--actor')!, instructionFile: values.get('--instruction-file')!,
    ...(reconcile ? { reconciliation: { grantId: values.get('--grant-id')!, processesSettled: true as const, detail: values.get('--settlement-detail')! } } : {}) }
}

/** Reads a preexisting private current-uid record; the explicit local invocation is the authority boundary. */
export function readPublicationOperatorInstruction(args: PublicationOperatorArgs, publication: PublicationSnapshot, now = Date.now()): { instruction: PublicationOperatorInstruction; authority: PublicationAuthority } {
  if (!process.getuid || !isAbsolute(args.instructionFile) || realpathSync(args.instructionFile) !== args.instructionFile) throw new PublicationError(403, 'Instruction record must be a canonical private local file')
  const fd = openSync(args.instructionFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536 || stat.size < 2) throw new PublicationError(403, 'Instruction record must be current-uid owned mode0600 regular file <=64KiB')
    bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new PublicationError(409, 'Instruction record changed while reading')
  } finally { closeSync(fd) }
  const instruction = instructionSchema.parse(JSON.parse(bytes.toString('utf8')))
  const p = publication, i = instruction
  if (i.action !== args.action || i.actorId !== args.actorId || i.publicationId !== args.publicationId || i.headSha !== args.headSha || i.patchSha256 !== args.patchSha256
    || p.id !== i.publicationId || p.headSha !== i.headSha || p.patchSha256 !== i.patchSha256 || p.ticketId !== i.ticketId || p.conversationId !== i.conversationId || p.repository !== i.repository || p.prNumber !== i.prNumber) throw new PublicationError(403, 'Explicit instruction does not match the exact reviewed publication binding')
  if (args.reconciliation ? (!i.reconciliation || i.reconciliation.grantId !== args.reconciliation.grantId || i.reconciliation.processesSettled !== true || i.reconciliation.detail !== args.reconciliation.detail)
    : !!i.reconciliation) throw new PublicationError(403, 'Instruction must explicitly bind the reconciliation grant and settlement, and cannot authorize automatic rollback')
  const created = Date.parse(i.createdAt), expires = Date.parse(i.expiresAt)
  if (created > now + 1000 || expires <= now || expires <= created || expires - created > 900000 || now - created > 900000) throw new PublicationError(403, 'Explicit instruction is expired, future-dated or exceeds 15-minute validity')
  return { instruction, authority: {
    kind: 'operator_instruction', actorId: i.actorId, authorized: true, ticketId: i.ticketId, conversationId: i.conversationId, publicationId: i.publicationId, action: i.action,
    sourceProof: { recordPath: args.instructionFile, recordSha256: createHash('sha256').update(bytes).digest('hex'), reference: i.source.reference, instruction: i.source.instruction },
  } }
}

/** Enqueues a one-use protected local instruction; never performs merge/apply/restart in this process. */
export async function enqueuePublicationOperator(args: PublicationOperatorArgs, publication: PublicationSnapshot, coordinator: Pick<PublicationCoordinator, 'enqueue'>, now = Date.now()): Promise<PublicationSnapshot> {
  if (args.reconciliation) throw new PublicationError(400, 'Reconciliation never enqueues effects; use reconcilePublicationOperator')
  const { instruction, authority } = readPublicationOperatorInstruction(args, publication, now)
  return coordinator.enqueue({ ticketId: publication.ticketId, conversationId: publication.conversationId, publicationId: publication.id, requestId: instruction.requestId, action: args.action }, authority)
}

/** Effect-free acknowledgement only; a separate newly bound explicit rollback command is still required. */
export async function reconcilePublicationOperator(args: PublicationOperatorArgs, publication: PublicationSnapshot, coordinator: Pick<PublicationCoordinator, 'acknowledgeInterruption'>, now = Date.now()): Promise<void> {
  if (!args.reconciliation || args.action !== 'rollback') throw new PublicationError(400, 'Explicit reconciliation flags and rollback-scoped instruction are required')
  const { authority } = readPublicationOperatorInstruction(args, publication, now)
  await coordinator.acknowledgeInterruption(args.reconciliation.grantId, authority, { processesSettled: true, detail: args.reconciliation.detail })
}
