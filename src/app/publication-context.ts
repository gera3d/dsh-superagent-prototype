/** Trusted release manifests are re-read for each operation; no card, model or HTTP payload configures commands. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PublicationCoordinator } from './publication-worker.ts'
import { capturePublicationTicket, validatePublicationTicket, type PublicationTicketFence } from './publication-ticket.ts'
import { loadPublicationRunner } from '../infra/publication-runner.ts'
import { PublicationError, PublicationService, type PublicationAdapter } from './publication.ts'
import { FilePublicationPersistence } from './publication-persistence.ts'
import { publicationChoices, publicationConversation, type LifecyclePublication } from './lifecycle-publication.ts'

export function loadLifecyclePublication(stateDir: string): LifecyclePublication {
  const runner = () => loadPublicationRunner(join(stateDir, 'publication-runner.json'))
  const required = () => { const value = runner(); if (!value) throw new PublicationError(409, 'Prepare a reviewed release manifest before publishing. Nothing was merged or deployed.'); return value }
  const adapter: PublicationAdapter = {
    evidence: (pins, signal, onSpawn) => required().evidence(pins, signal, onSpawn),
    perform: (stage, pins, operationId, signal, onSpawn) => required().perform(stage, pins, operationId, signal, onSpawn),
  }
  const store = new FilePublicationPersistence(join(stateDir, 'publication-state.json'))
  const service = new PublicationService({ store, adapter })
  const bindingFor = (p: import('./publication.ts').PublicationSnapshot) => {
    const previous = Object.values(store.peek().workerGrants ?? {}).reverse().find(grant => grant.publicationId === p.id && grant.ticketBinding)
    if (previous && validatePublicationTicket(join(stateDir, 'orchestrator.sqlite'), p, previous.ticketBinding as PublicationTicketFence)) return previous.ticketBinding
    return undefined
  }
  const coordinator = () => new PublicationCoordinator({ stateDir, store, service,
    entryPath: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../lib/publication-worker.js' : './publication-worker.js', import.meta.url)),
    captureBinding: p => bindingFor(p) ?? capturePublicationTicket(join(stateDir, 'orchestrator.sqlite'), p) })
  return { service,
    enqueue: (input, authority) => coordinator().enqueue(input, authority),
    refresh: async () => {
      const ids = Object.keys(store.peek().tickets)
      if (!ids.length) return
      const owner = coordinator()
      for (const ticketId of ids) await owner.snapshot(ticketId)
    },
    pinsFor: (repository, prNumber) => runner()?.pinsFor(repository, prNumber),
    canContinue: (item, p) => p.ticketId === item.ticketId && p.prNumber === item.lifecycle?.prNumber
      && p.conversationId === publicationConversation(item) && !!bindingFor(p),
    project: items => {
      const state = store.peek()
      return items.map(item => {
        if (!item.ticketId || item.lifecycle?.kind !== 'done') return item
        const id = state.tickets[item.ticketId], snapshot = id ? state.publications[id] : undefined
        const bound = snapshot && snapshot.prNumber === item.lifecycle.prNumber && snapshot.conversationId === publicationConversation(item) ? snapshot : undefined
        const recovery = !!bound && (item.status !== 'pending' || !!item.invalidation)
        const continuation = recovery && !!bindingFor(bound!) && !['published', 'rolled_back', 'interrupted', 'failed'].includes(bound!.status)
        const choices = publicationChoices(bound).filter(choice => !recovery || continuation || choice.id === 'rollback')
        return { ...item, lifecycle: { ...item.lifecycle, publication: bound, ...(recovery ? { recovery: true, ...(continuation ? { continuation: true } : {}) } : {}) }, choices: [
          ...choices, ...item.choices.filter(choice => !recovery && !['prepare_publication', 'publish', 'rollback'].includes(choice.id)),
        ] }
      })
    } }
}
