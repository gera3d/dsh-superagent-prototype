/** Trusted-local Codex/operator CLI entry. Never registered as an agent/Autopilot tool or an HTTP route. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPublicationRunner, type PublicationRunnerConfig } from '../infra/publication-runner.ts'
import { PublicationError, PublicationService } from './publication.ts'
import { FilePublicationPersistence } from './publication-persistence.ts'
import { PublicationCoordinator } from './publication-worker.ts'
import { enqueuePublicationOperator, parsePublicationOperatorArgs, reconcilePublicationOperator } from './publication-operator.ts'
import { capturePublicationTicket, validatePublicationTicket, type PublicationTicketFence } from './publication-ticket.ts'

async function main(): Promise<void> {
  const args = parsePublicationOperatorArgs(process.argv.slice(2))
  const stateDir = realpathSync(args.stateDir)
  const manifestBytes = args.reconciliation ? undefined : readFileSync(join(stateDir, 'publication-runner.json'))
  const manifestSha256 = manifestBytes ? createHash('sha256').update(manifestBytes).digest('hex') : undefined
  const noEffects = async (): Promise<never> => { throw new Error('Reconciliation cannot run evidence or publication commands') }
  const adapter = manifestBytes ? createPublicationRunner(JSON.parse(manifestBytes.toString('utf8')) as PublicationRunnerConfig) : { evidence: noEffects, perform: noEffects }
  const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))
  const initial = store.peek().publications[args.publicationId]
  if (!initial) throw new PublicationError(404, 'Reviewed publication not found; prepare it before approving')
  const service = new PublicationService({ store, adapter })
  const coordinator = new PublicationCoordinator({
    stateDir, store, service, manifestSha256,
    entryPath: join(dirname(fileURLToPath(import.meta.url)), 'publication-worker.js'),
    captureBinding: publication => {
      const previous = Object.values(store.peek().workerGrants ?? {}).reverse().find(grant => grant.publicationId === publication.id && grant.ticketBinding
        && validatePublicationTicket(join(stateDir, 'orchestrator.sqlite'), publication, grant.ticketBinding as PublicationTicketFence))
      return previous?.ticketBinding ?? capturePublicationTicket(join(stateDir, 'orchestrator.sqlite'), publication)
    },
  })
  const current = await coordinator.snapshot(initial.ticketId)
  // Effect-free ownership reconciliation may target an archived immutable publication; effects still require current ticket binding.
  const publication = args.reconciliation ? store.peek().publications[args.publicationId] : current
  if (!publication || publication.id !== args.publicationId) throw new PublicationError(409, 'Reviewed publication is no longer current')
  if (args.reconciliation) {
    await reconcilePublicationOperator(args, publication, coordinator)
    process.stdout.write(`${JSON.stringify({ publicationId: publication.id, grantId: args.reconciliation.grantId, reconciled: true, effects: 'none', rollbackExecuted: false })}\n`)
    return
  }
  const result = await enqueuePublicationOperator(args, publication, coordinator)
  process.stdout.write(`${JSON.stringify({ ticketId: result.ticketId, publicationId: result.id, status: result.status, coordination: result.coordination })}\n`)
}

void main().catch(error => {
  process.stderr.write(`Publication operator command rejected: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
