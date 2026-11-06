/** Explicit ticket lifecycle actions. Review links never apply, deploy, restart the app or merge via CLI. */
import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import type { PendingDecisionItem } from '../core/decision.ts'
import type { Commands } from '../infra/commands.ts'
import { InboxError, ticketDecisions } from './decision-inbox.ts'
import type { DecisionChoice } from '../core/decision.ts'
import type { PublicationSnapshot } from './publication.ts'
import { publicationAction, publicationChoices, publicationConversation, type LifecyclePublication, type PublicationApproval } from './lifecycle-publication.ts'

export const LifecycleRequest = z.object({ action: z.enum(['retry', 'open_issue', 'try_it', 'changes_needed', 'merge', 'prepare_publication', 'publish', 'rollback']),
  approval: z.object({ publicationId: z.string().uuid(), requestId: z.string().uuid() }).strict().optional() }).strict()
export type LifecycleAction = z.infer<typeof LifecycleRequest>['action']
export interface LifecycleResult { execution: 'retried' | 'not_executed' | 'publication'; url?: string; ticketId: string; message: string; publication?: PublicationSnapshot; choices?: DecisionChoice[] }
export type LifecycleCommands = Pick<Commands, 'api'>
const Pull = z.object({ state: z.string(), draft: z.boolean(), head: z.object({ sha: z.string().min(1) }), changed_files: z.number().int().positive() })
const File = z.object({ filename: z.string().min(1), previous_filename: z.string().optional() })
/** Conservative allowlist: unknown, executable documentation formats and renamed code fail closed. */
export function documentationPath(path: string): boolean {
  if (path.split('/').some(part => !part || part === '..' || part.startsWith('.'))) return false
  return /\.(?:md|rst)$/i.test(path) || /^(?:docs\/.*|README|LICENSE|COPYING)\.txt$/i.test(path)
}
export async function verifiedDocsOnly(commands: LifecycleCommands | undefined, number: number): Promise<boolean> {
  if (!commands || !Number.isSafeInteger(number) || number < 1) return false
  try {
    const before = await commands.api(Pull, `pulls/${number}`)
    if (before.state !== 'open' || before.draft || before.changed_files > 3000) return false
    // Validate every entry; never use Commands.pages, whose tolerant ingestion skips malformed rows.
    const pages = await commands.api(z.array(z.array(File)), `pulls/${number}/files?per_page=100`, '--paginate', '--slurp')
    const files = pages.flat()
    if (files.length !== before.changed_files || new Set(files.map(file => file.filename)).size !== files.length
      || files.some(file => !documentationPath(file.filename) || file.previous_filename && !documentationPath(file.previous_filename))) return false
    const after = await commands.api(Pull, `pulls/${number}`)
    return after.state === 'open' && !after.draft && after.head.sha === before.head.sha && after.changed_files === before.changed_files
  } catch { return false }
}
const displayCache = new WeakMap<LifecycleCommands, Map<number, { expires: number; value: Promise<boolean> }>>()
function displayDocsOnly(commands: LifecycleCommands | undefined, number: number): Promise<boolean> {
  if (!commands) return Promise.resolve(false)
  let cache = displayCache.get(commands)
  if (!cache) displayCache.set(commands, cache = new Map())
  const existing = cache.get(number)
  if (existing && existing.expires > Date.now()) return existing.value
  if (cache.size >= 100) cache.delete(cache.keys().next().value!)
  const value = verifiedDocsOnly(commands, number)
  cache.set(number, { expires: Date.now() + 30_000, value })
  return value
}
/** Display verification is bounded/cached for 30s; merge actions always revalidate without this cache. */
export async function enrichLifecycle(items: PendingDecisionItem[], commands?: LifecycleCommands, repository?: string, publication?: LifecyclePublication): Promise<PendingDecisionItem[]> {
  return Promise.all(items.map(async item => {
    if (item.lifecycle?.kind === 'stuck' && item.lifecycle.issueNumber && repository && /^[\w.-]+\/[\w.-]+$/.test(repository)) {
      return { ...item, lifecycle: { ...item.lifecycle, issueUrl: `https://github.com/${repository}/issues/${item.lifecycle.issueNumber}` } }
    }
    if (item.status !== 'pending' || item.lifecycle?.kind !== 'done' || !item.lifecycle.prNumber) return item
    const candidate = publication && item.ticketId ? await publication.service.snapshot(item.ticketId) : undefined
    const snapshot = candidate && candidate.repository === repository && candidate.prNumber === item.lifecycle.prNumber
      && candidate.conversationId === publicationConversation(item) ? candidate : undefined
    const docsOnly = await displayDocsOnly(commands, item.lifecycle.prNumber)
    return { ...item, lifecycle: { ...item.lifecycle, docsOnly, ...(snapshot ? { publication: snapshot } : {}) }, choices: [
      ...(publication ? publicationChoices(snapshot) : []),
      ...(docsOnly ? [{ id: 'merge', label: 'Merge', actionKind: 'merge' as const, description: 'Documentation-only files verified by the server. Review and merge on GitHub.' }] : []),
      { id: 'try_it', label: 'Try it' }, { id: 'changes_needed', label: 'Changes needed' },
    ] }
  }))
}
export async function lifecycleAction(host: {
  getTicket(id: string): Ticket | undefined; retryTicket(id: string): unknown; repository: string; commands?: LifecycleCommands; busy?(ticket: Ticket): boolean
  publication?: LifecyclePublication; approvalActor?: string
}, item: PendingDecisionItem | undefined, action: LifecycleAction, approval?: PublicationApproval): Promise<LifecycleResult> {
  if (!item?.ticketId || !item.lifecycle) throw new InboxError(404, 'Lifecycle decision not found')
  if (action === 'rollback' && item.lifecycle.kind === 'done' && host.publication) {
    const publication = await publicationAction(host.publication, item, host.repository, action, approval, host.approvalActor, () => true)
    return { execution: 'publication', ticketId: item.ticketId, publication, choices: publicationChoices(publication),
      message: `Publication ${publication.status}. Inspect the recorded rollback outcome.` }
  }
  const current = host.getTicket(item.ticketId)
  const canonical = current && ticketDecisions([current]).find(candidate => candidate.id === item.id && candidate.lifecycle)
  const previous = !canonical && host.publication && (action === 'prepare_publication' || action === 'publish')
    ? await host.publication.service.snapshot(item.ticketId) : undefined
  const continuation = previous && host.publication?.canContinue?.(item, previous)
  const projected = canonical ?? (continuation ? item : undefined)
  if (!projected || !continuation && (item.status !== 'pending' || item.invalidation)) throw new InboxError(409, 'Ticket state changed; refresh this decision')
  if (host.busy?.(current!)) throw new InboxError(409, 'Worker is active; wait for it to become idle')
  const { ticketId, lifecycle } = projected
  const result = (message: string, url?: string): LifecycleResult => ({ execution: 'not_executed', ticketId: ticketId!, message, ...(url ? { url } : {}) })
  if (action === 'retry') {
    if (lifecycle!.kind !== 'stuck') throw new InboxError(409, 'Only a stuck ticket can be retried here')
    host.retryTicket(ticketId!)
    return { execution: 'retried', ticketId: ticketId!, message: 'Fresh assignment requested with the original task.' }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(host.repository)) throw new InboxError(409, 'Repository link is unavailable')
  const base = `https://github.com/${host.repository}`
  if (action === 'open_issue' && lifecycle!.kind === 'stuck') {
    const number = current!.channels.find(channel => channel.source === 'github' && /^[1-9]\d*$/.test(channel.address.number ?? ''))?.address.number
    if (!number) throw new InboxError(409, 'No GitHub issue is bound to this ticket; open the ticket instead')
    return result('Open the original issue.', `${base}/issues/${number}`)
  }
  if (lifecycle!.kind !== 'done' || !lifecycle!.prNumber) throw new InboxError(409, 'Action is not available for this lifecycle state')
  const pr = `${base}/pull/${lifecycle!.prNumber}`
  if (action === 'prepare_publication' || action === 'publish' || action === 'rollback') {
    if (!host.publication) throw new InboxError(409, 'Publication runner is not configured. Nothing was merged or deployed.')
    const stillCurrent = () => {
      const latest = host.getTicket(ticketId!)
      return !!latest && !host.busy?.(latest) && (ticketDecisions([latest]).some(candidate => candidate.id === item.id)
        || !!previous && !!host.publication?.canContinue?.(item, previous))
    }
    const publication = await publicationAction(host.publication, projected, host.repository, action, approval, host.approvalActor, stillCurrent)
    return { execution: 'publication', ticketId: ticketId!, publication, choices: publicationChoices(publication),
      message: publication.status === 'published' ? 'Configured release verification succeeded; browser acceptance is recorded separately.' : `Publication ${publication.status}. Inspect the recorded stage outcomes.` }
  }
  if (action === 'merge') {
    if (!await verifiedDocsOnly(host.commands, lifecycle!.prNumber)) throw new InboxError(409, 'Try it first: documentation-only changes could not be verified')
    // Network verification may race progress, stop or reassignment. Check current aggregate again before returning a link.
    const latest = host.getTicket(ticketId!)
    if (!latest || host.busy?.(latest) || !ticketDecisions([latest]).some(candidate => candidate.id === item.id)) throw new InboxError(409, 'Ticket changed during verification')
    return result('Review and merge on GitHub. No merge was executed.', `${pr}#partial-pull-merging`)
  }
  if (action === 'try_it') return result('Inspect and try the PR in an isolated checkout. Nothing was applied or restarted.', `${pr}/files`)
  if (action === 'changes_needed') return result('Open the ticket and describe the changes needed. No message has been sent.')
  throw new InboxError(400, 'Action is not available for this lifecycle state')
}
