/** Dedicated tsdown entry. Launched detached by the trusted coordinator; never imported by the hosting runtime. */
import { isAbsolute, join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPublicationRunner, type PublicationRunnerConfig } from '../infra/publication-runner.ts'
import { FilePublicationPersistence } from './publication-persistence.ts'
import { runPublicationWorker } from './publication-worker.ts'
import { validatePublicationTicket, type PublicationTicketFence } from './publication-ticket.ts'

async function main(): Promise<void> {
  const [stateDir, grantId, ...extra] = process.argv.slice(2)
  if (!stateDir || !isAbsolute(stateDir) || realpathSync(stateDir) !== stateDir || !grantId || !/^[a-f0-9-]{36}$/.test(grantId) || extra.length) throw new Error('Invalid detached publication worker arguments')
  // Bind the exact manifest bytes before loading any adapter. Never interpret argv as commands/configuration.
  const manifestBytes = readFileSync(join(stateDir, 'publication-runner.json'))
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const adapter = createPublicationRunner(JSON.parse(manifestBytes.toString('utf8')) as PublicationRunnerConfig) // parse exactly the hashed bytes; no ABA reread race
  await runPublicationWorker({
    stateDir, grantId, store: new FilePublicationPersistence(join(stateDir, 'publication-state.json')), adapter, manifestSha256,
    isCurrent: (grant, publication) => validatePublicationTicket(join(stateDir, 'orchestrator.sqlite'), publication, grant.ticketBinding as PublicationTicketFence),
  })
}

void main().catch(error => {
  // No host lifecycle hooks or servers are started here. Durable stage/grant state remains the source of truth.
  process.stderr.write(`Publication coordinator stopped: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
