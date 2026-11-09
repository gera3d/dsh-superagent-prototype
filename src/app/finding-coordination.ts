/**
 * Narrow supported headless coordination path for existing explicitly approved bounded work.
 * Validates mode 0600 private current-uid instructions; never accepts evidence, broadens scope or impersonates browser headers.
 */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { FindingError, type Finding, findingDecision, getOperatorExecutionApproval, isReservedActor } from './finding.ts'
import type { FindingRuntime } from './finding-runtime.ts'
import type { PendingDecisionItem } from '../core/decision.ts'

export const FindingCoordinationInstructionSchema = z.object({
  version: z.literal(1),
  authority: z.literal('explicit_operator_coordination'),
  findingId: z.string().uuid(),
  revision: z.number().int().positive(),
  action: z.enum(['retry_scope', 'confirm', 'defer']),
  choiceId: z.enum(['fix_now', 'queue_next', 'defer']).optional(),
  actorId: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  source: z.object({
    reference: z.string().trim().min(1).max(2048),
    reason: z.string().trim().min(5).max(8192),
  }).strict(),
}).strict()
export type FindingCoordinationInstruction = z.infer<typeof FindingCoordinationInstructionSchema>

export const FindingCoordinationRequestSchema = z.object({
  instructionFile: z.string().trim().min(1).max(4096),
}).strict()
export type FindingCoordinationRequest = z.infer<typeof FindingCoordinationRequestSchema>

/**
 * Validates a canonical private current-uid mode 0600 instruction record binding an exact finding revision.
 * Rejects loose permissions, symlinks, expired tokens, unapproved findings and unsupported acceptance delegation.
 * Reads and verifies the file snapshot in a single open to prevent TOCTOU mutation races.
 */
export function readFindingCoordinationInstruction(
  instructionFile: string,
  finding: Finding,
  now = Date.now(),
): FindingCoordinationInstruction {
  if (!process.getuid || !isAbsolute(instructionFile) || realpathSync(instructionFile) !== instructionFile) {
    throw new FindingError(403, 'Instruction record must be a canonical private local file')
  }
  const fd = openSync(instructionFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = fstatSync(fd)
    if (!process.getuid || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 65536 || stat.size < 2) {
      throw new FindingError(403, 'Instruction record must be current-uid owned mode0600 regular file <=64KiB')
    }
    bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new FindingError(409, 'Instruction record changed while reading')
    }
  } finally {
    closeSync(fd)
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new FindingError(400, 'Instruction record is not valid JSON')
  }

  const instruction = FindingCoordinationInstructionSchema.parse(rawJson)

  if (isReservedActor(instruction.actorId)) {
    throw new FindingError(403, 'Headless instruction cannot claim reserved local-operator or native actor origin')
  }

  if (instruction.findingId !== finding.id) {
    throw new FindingError(403, 'Explicit instruction finding ID does not match target finding')
  }
  if (instruction.revision !== finding.revision) {
    throw new FindingError(409, 'Finding coordination is stale; instruction revision does not match current finding revision')
  }

  const created = Date.parse(instruction.createdAt)
  const expires = Date.parse(instruction.expiresAt)
  if (created > now + 1000 || expires <= now || expires <= created || expires - created > 900000 || now - created > 900000) {
    throw new FindingError(403, 'Explicit instruction is expired, future-dated or exceeds 15-minute validity')
  }

  // Headless coordination is strictly bounded to work previously authorized by the local operator in the audit log.
  const approval = getOperatorExecutionApproval(finding)
  if (!approval.approved) {
    throw new FindingError(403, 'Headless coordination is only supported for existing explicitly approved bounded work; prior deferral or unapproved scope requires native local operator approval')
  }

  if (instruction.action === 'confirm') {
    if (!instruction.choiceId || !finding.choices.some(c => c.id === instruction.choiceId)) {
      throw new FindingError(400, 'Confirmation action requires an eligible choiceId (fix_now, queue_next, or defer)')
    }
    const isReplay = finding.confirmation?.revision === instruction.revision && finding.confirmation.choiceId === instruction.choiceId
    if (finding.state !== 'awaiting_decision' && !isReplay) {
      throw new FindingError(409, 'Only findings awaiting decision may be confirmed')
    }
    if (instruction.choiceId !== 'defer') {
      if (instruction.choiceId !== approval.choiceId) {
        throw new FindingError(403, `Headless confirmation must match the exact prior approved action (${approval.choiceId})`)
      }
      if (!finding.priorJobs || finding.priorJobs.length === 0) {
        throw new FindingError(403, 'Headless confirmation is only supported for retrying existing bounded work with approved execution lineage')
      }
    }
  } else if (instruction.action === 'retry_scope') {
    if (finding.state !== 'blocked') {
      throw new FindingError(409, 'Only blocked findings awaiting evidence review may be retried')
    }
    if (!finding.job && (!finding.priorJobs || finding.priorJobs.length === 0)) {
      throw new FindingError(403, 'Headless retry is only supported for existing bounded work with approved execution lineage')
    }
  } else if (instruction.action === 'defer') {
    if (finding.state !== 'awaiting_decision' && finding.state !== 'blocked') {
      throw new FindingError(409, 'Only findings awaiting decision or blocked may be deferred')
    }
  }

  return instruction
}

/**
 * Executes a headless coordination action on an existing explicitly approved finding using verified operator instruction proof.
 * Explicitly binds to the target finding ID and validates the instruction in a single file descriptor read without TOCTOU double-open.
 */
export async function coordinateFinding(
  runtime: FindingRuntime,
  targetFindingId: string,
  instructionFile: string,
  now = Date.now(),
): Promise<{ finding: Finding; item: PendingDecisionItem }> {
  if (!z.string().uuid().safeParse(targetFindingId).success) {
    throw new FindingError(400, 'Target finding ID must be a valid UUID')
  }
  if (!isAbsolute(instructionFile)) throw new FindingError(400, 'Instruction file path must be absolute')

  runtime.reconcile()
  const finding = runtime.store.get(targetFindingId)
  if (!finding) throw new FindingError(404, 'Finding not found')

  const instruction = readFindingCoordinationInstruction(instructionFile, finding, now)

  if (instruction.action === 'retry_scope') {
    const reviewed = runtime.review(finding.id, { revision: instruction.revision, decision: 'retry_scope' }, instruction.actorId)
    void runtime.request()
    return { finding: reviewed, item: findingDecision(reviewed) }
  }

  if (instruction.action === 'confirm') {
    const confirmed = runtime.store.confirm(
      finding.id,
      { revision: instruction.revision, choiceId: instruction.choiceId! },
      instruction.actorId,
      true,
    )
    void runtime.request()
    return { finding: confirmed, item: findingDecision(confirmed) }
  }

  if (instruction.action === 'defer') {
    let deferred: Finding
    if (finding.state === 'blocked') {
      deferred = runtime.review(finding.id, { revision: instruction.revision, decision: 'defer' }, instruction.actorId)
    } else {
      deferred = runtime.store.confirm(finding.id, { revision: instruction.revision, choiceId: 'defer' }, instruction.actorId, true)
    }
    return { finding: deferred, item: findingDecision(deferred) }
  }

  throw new FindingError(400, 'Unsupported coordination action')
}
