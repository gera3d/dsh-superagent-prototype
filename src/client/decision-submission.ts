/** Shared choice-to-native-Send linkage. Never sends, replaces a draft, or resolves by text alone. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { decisionResponse: unknown }
}
export interface ChoiceStage { attemptId: string; choiceId: string; draftFingerprint: string; stagedAt: number; submissionId?: string }
export interface StageRequest { decisionId: string; choiceId: string; sessionId: string; prompt: string; input: InputState; inputActions: InputActions; signal?: AbortSignal }
export interface DecisionSubmissionBridge {
  /** Explicit presentation ownership for companion clients sharing this bridge. */
  readonly dockOwner?: 'agent-mini'
  watch(sessionId: string): () => void
  stage(request: StageRequest): Promise<{ item: any; staging: ChoiceStage; execution: 'not_executed' }>
  discard(decisionId: string, attemptId: string): Promise<{ item: any }>
}
export interface NativeInputSubmission { readonly timestamp: number; readonly source?: 'click' | 'enter'; readonly input: InputState }
interface NativeInput {
  state: { getSnapshot(): InputState; subscribe(listener: () => void): () => void }
  /** Native session-scoped observer, invoked before optimistic clear and reference serialization. */
  observeSubmissions?(listener: (occurrence: NativeInputSubmission) => void): () => void
  notify(level: 'info' | 'error', text: string): void
}
export interface SubmissionContext {
  sessions: Pick<ISessions, 'retain'>
  conversation: { input: { for(ctx: any): NativeInput } }
  get?: (name: string) => unknown
  inputTriggers?: { sessionOf(ctx: any): { serializeReference(source: string | undefined, ref: string, signal: AbortSignal): Promise<string> } }
}
interface Journal {
  version: 1; sessionId: string; decisionId: string; choiceId: string; attemptId: string
  rawFingerprint: string; draftFingerprint: string; stagedAt: number
  state: 'preparing' | 'staged' | 'awaiting_confirmation' | 'invalidated'
  submissionId?: string; retryOf?: string; submissionIds?: string[]
}
interface NativeEcho { requestId: string; text: string; time?: number; attachments?: readonly unknown[] }
interface Armed {
  attemptId: string; draftRev: number; text: string; submittedText: string; attachments: readonly string[]
  before: Set<string>; at: number
}
interface Watching {
  ref: SessionReference; count: number; ready: Promise<NativeInput>; native?: NativeInput
  armed?: Armed; intent?: Armed & { before: Set<string>; at: number }
  unsubscribers: (() => void)[]; disposed: boolean; checking?: number; matching?: boolean; linking?: Promise<void>; clearing?: Promise<void>
}
const OWNER_KEY = 'dsh:decision-submission:owner:v1'
const PREFIX = 'dsh:decision-submission:v1:'
const sameAttachments = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])
/** The exact server fingerprint format; native plain-text Send trims its document before admission. */
export async function decisionDraftFingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(text))
  return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')}`
}
/** Uses public input state + native submission identities; no private Send monkey-patching or text-only completion. */
export function createDecisionSubmission(ctx: SubmissionContext, options: { storage?: Storage; tabStorage?: Storage; now?: () => number } = {}): DecisionSubmissionBridge & { dispose(): void } {
  const storage = options.storage ?? localStorage
  const tabStorage = options.tabStorage ?? sessionStorage
  const now = options.now ?? Date.now
  const watches = new Map<string, Watching>()
  const documentFingerprint = (state: InputState, text = state.draft) => decisionDraftFingerprint(JSON.stringify({ text,
    references: state.occurrences.map((o: any) => ({ offset: o.offset, length: o.length, source: o.source, ref: o.ref, clipboardText: o.clipboardText })) }))
  const serializedDraft = async (watch: Watching, state: InputState, text: string) => {
    if (!state.occurrences.length) return text.trim()
    const triggers = (ctx.get?.('inputTriggers') ?? ctx.inputTriggers) as SubmissionContext['inputTriggers']
    if (!triggers) throw new Error('This draft contains reference chips whose submitted text cannot be linked reliably. The draft is unchanged and the decision remains pending.')
    const controller = triggers.sessionOf(watch.ref.binding.ctx)
    const parts = await Promise.all(state.occurrences.map(async (o: any) => ({ offset: o.offset, length: o.length,
      text: await controller.serializeReference(o.source, o.ref, AbortSignal.timeout(5000)) })))
    let out = '', cursor = 0
    for (const part of parts) { out += text.slice(cursor, part.offset) + part.text; cursor = part.offset + part.length }
    return (out + text.slice(cursor)).trim()
  }
  let stopped = false
  const owner = () => {
    let id = tabStorage.getItem(OWNER_KEY)
    if (!id) { id = crypto.randomUUID(); tabStorage.setItem(OWNER_KEY, id) }
    return id
  }
  const key = (sessionId: string) => `${PREFIX}${owner()}:${sessionId}`
  const read = (sessionId: string): Journal | undefined => {
    try {
      const value = JSON.parse(storage.getItem(key(sessionId)) || 'null')
      return value?.version === 1 && value.sessionId === sessionId && typeof value.attemptId === 'string' && typeof value.rawFingerprint === 'string' ? value : undefined
    } catch { return undefined }
  }
  const write = (value: Journal) => {
    storage.setItem(key(value.sessionId), JSON.stringify(value))
    if (read(value.sessionId)?.attemptId !== value.attemptId) throw new Error('Linked-choice recovery could not be persisted. Your draft has not been sent.')
  }
  const forget = (value: Journal) => { if (read(value.sessionId)?.attemptId === value.attemptId) storage.removeItem(key(value.sessionId)) }
  const post = async (id: string, action: string, body: unknown) => {
    const response = await fetch(`/orchestrator/api/decisions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' }, body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || `Linked choice could not be synchronized (${response.status}). The decision is not confirmed resolved.`)
    return result
  }
  const warn = (watch: Watching, error: unknown) => { if (!watch.disposed) watch.native?.notify('error', error instanceof Error ? error.message : String(error)) }
  const clear = async (journal: Journal, watch?: Watching) => {
    write({ ...journal, state: 'invalidated' }) // Fail closed locally even if the network is unavailable.
    if (watch) { watch.armed = undefined; watch.intent = undefined }
    const result = await post(journal.decisionId, 'discard-staging', { attemptId: journal.attemptId })
    forget(journal)
    return result
  }
  const link = (watch: Watching, journal: Journal): void => {
    if (!journal.submissionId || watch.linking) return
    watch.linking = (async () => {
      try {
        const ids = journal.submissionIds ?? (journal.retryOf ? [journal.retryOf, journal.submissionId!] : [journal.submissionId!])
        for (let index = 0; index < ids.length; index++) {
          const result = await post(journal.decisionId, 'submission', { attemptId: journal.attemptId, submissionId: ids[index], ...(index ? { retryOf: ids[index - 1] } : {}) })
          if (result.item?.status === 'resolved' || result.item?.status === 'stale') { forget(journal); break }
        }
        // Pending (including a queued echo) is NOT confirmation. The host waits for the durable matching rpcId.
      } catch (error) { warn(watch, error) }
      finally {
        watch.linking = undefined
        const latest = read(journal.sessionId)
        if (!watch.disposed && latest?.submissionId && latest.submissionId !== journal.submissionId) link(watch, latest)
      }
    })()
  }
  /** Journal and start the identity link synchronously: native plain Send clears its editor next. */
  const bindEcho = (watch: Watching, journal: Journal, echo: NativeEcho) => {
    const current = read(journal.sessionId)
    if (watch.disposed || current?.attemptId !== journal.attemptId || !['staged', 'awaiting_confirmation'].includes(current.state)) return
    const previousIds = current.submissionIds ?? (current.submissionId ? [current.submissionId] : [])
    const linked: Journal = { ...current, state: 'awaiting_confirmation', submissionId: echo.requestId,
      submissionIds: [...new Set([...previousIds, echo.requestId])],
      ...(current.submissionId && current.submissionId !== echo.requestId ? { retryOf: current.submissionId } : {}) }
    write(linked)
    watch.intent = undefined; watch.armed = undefined
    link(watch, linked)
  }
  const onSession = (sessionId: string, watch: Watching) => {
    if (watch.disposed || watch.matching) return
    const journal = read(sessionId)
    if (!journal || journal.state === 'invalidated') return
    const pending = watch.ref.binding.session.getSnapshot().pendingSubmissions as readonly NativeEcho[]
    // A new echo or identical text alone is not proof that this composer was submitted.
    // Only the native facade's before-clear observer establishes that scoped intent.
    const intent = watch.intent
    if (intent && intent.attemptId === journal.attemptId && now() - intent.at <= 60_000) {
      const candidates = pending.filter(echo => !intent.before.has(echo.requestId))
      if (candidates.length === 1) {
        const echo = candidates[0]!
        if (echo.text !== intent.submittedText) {
          void clear(journal, watch).catch(error => warn(watch, error))
          warn(watch, new Error('The submitted content differs from the linked draft snapshot. No decision was resolved from it.'))
          return
        }
        // The full serialized text was fingerprinted when this owned draft was armed.
        // Bind its explicit native requestId synchronously, before any optimistic clear.
        try { bindEcho(watch, journal, echo) } catch (error) { warn(watch, error) }
        return
      }
      if (candidates.length > 1) {
        watch.intent = undefined; watch.armed = undefined
        warn(watch, new Error('Submission linkage is ambiguous. The decision remains pending; no message was inferred as its response.'))
        return
      }
    }
    // Replay an explicit, journalled identity after reload, network loss, or durable admission.
    if (journal.submissionId) link(watch, journal)
  }
  const onNativeSubmit = (sessionId: string, watch: Watching, occurrence: NativeInputSubmission) => {
    if (watch.disposed || watch.matching || !['click', 'enter'].includes(occurrence.source ?? '')) return
    const journal = read(sessionId), armed = watch.armed, state = occurrence.input
    if (!journal || journal.state === 'invalidated' || journal.state === 'preparing' || !armed || armed.attemptId !== journal.attemptId) return
    if (state.claim || state.phase !== 'plain' || state.draftRev !== armed.draftRev || state.draft !== armed.text
      || !sameAttachments(state.attachmentIds, armed.attachments)) return
    watch.intent = { ...armed, before: new Set((watch.ref.binding.session.getSnapshot().pendingSubmissions as readonly NativeEcho[]).map(echo => echo.requestId)), at: now() }
  }
  const onInput = (sessionId: string, watch: Watching) => {
    if (watch.disposed || !watch.native) return
    const journal = read(sessionId)
    if (!journal) { watch.armed = undefined; watch.intent = undefined; return }
    if (journal.state === 'invalidated') {
      if (!watch.clearing) watch.clearing = clear(journal, watch).catch(error => warn(watch, error)).finally(() => { watch.clearing = undefined })
      return
    }
    const state = watch.native.state.getSnapshot()
    if (journal.state === 'preparing' || watch.matching) return
    if (state.claim) { watch.intent = undefined; watch.armed = undefined; return }
    const armed = watch.armed
    if (armed && armed.attemptId === journal.attemptId && state.draftRev === armed.draftRev && sameAttachments(state.attachmentIds, armed.attachments)) return
    if (watch.intent) {
      // Native optimistic clear is not a discard. Failed native sends restore the captured document.
      if (state.phase === 'plain' && state.draftRev > watch.intent.draftRev && state.draft === watch.intent.text
        && sameAttachments(state.attachmentIds, watch.intent.attachments)) {
        watch.intent = undefined; watch.armed = undefined
        onInput(sessionId, watch) // Re-prove the restored document/references instead of treating failed Send as discard.
      }
      return
    }
    if (state.phase !== 'plain') return
    if (armed && journal.state !== 'awaiting_confirmation') {
      watch.armed = undefined
      if (!watch.clearing) watch.clearing = clear(journal, watch).catch(error => warn(watch, error)).finally(() => { watch.clearing = undefined })
      return
    }
    // On a newly mounted/restored editor, prove the persisted complete draft first. Never arm an empty/unrelated draft.
    if (!state.draft || watch.checking === state.draftRev) return
    const revision = state.draftRev
    watch.checking = revision
    void Promise.all([documentFingerprint(state), serializedDraft(watch, state, state.draft)]).then(async ([fingerprint, submittedText]) => {
      const submittedFingerprint = await decisionDraftFingerprint(submittedText)
      if (watch.disposed || !watch.native) return
      const current = watch.native.state.getSnapshot()
      const latest = read(sessionId)
      if (current.draftRev !== revision || current.phase !== 'plain' || latest?.attemptId !== journal.attemptId || latest.state === 'invalidated') return
      if (fingerprint === journal.rawFingerprint && submittedFingerprint === journal.draftFingerprint) {
        watch.armed = { attemptId: journal.attemptId, draftRev: revision, text: current.draft, submittedText, attachments: [...current.attachmentIds],
          before: new Set((watch.ref.binding.session.getSnapshot().pendingSubmissions as readonly NativeEcho[]).map(echo => echo.requestId)), at: now() }
      }
    }).catch(error => warn(watch, error)).finally(() => { if (watch.checking === revision) watch.checking = undefined })
  }
  const watchSession = (sessionId: string): (() => void) => {
    if (stopped) throw new Error('Decision submission tracking is unavailable. Nothing was sent.')
    let watch = watches.get(sessionId)
    if (!watch) {
      const ref = ctx.sessions.retain(sessionId as SessionId, { source: 'decisionResponse' })
      watch = { ref, count: 0, ready: undefined as never, unsubscribers: [], disposed: false }
      const current = watch
      current.ready = ref.ready.then(binding => {
        if (current.disposed) throw new Error('Source conversation was closed before its choice could be linked.')
        const native = ctx.conversation.input.for(binding.ctx)
        current.native = native
        if (native.observeSubmissions) current.unsubscribers.push(native.observeSubmissions(occurrence => onNativeSubmit(sessionId, current, occurrence)))
        current.unsubscribers.push(native.state.subscribe(() => onInput(sessionId, current)), binding.session.subscribe(() => onSession(sessionId, current)))
        onInput(sessionId, current); onSession(sessionId, current)
        return native
      })
      void current.ready.catch(error => { if (!current.disposed) warn(current, error) })
      watches.set(sessionId, current)
    }
    watch.count++
    let released = false
    return () => {
      if (released) return
      released = true
      if (--watch!.count > 0) return
      watch!.disposed = true
      watch!.unsubscribers.forEach(dispose => dispose())
      watch!.ref.release(); watches.delete(sessionId)
    }
  }
  return {
    dockOwner: 'agent-mini',
    watch(sessionId) {
      try { return watchSession(sessionId) } catch { return () => {} } // Removed/unavailable views may still mount a dock; explicit staging reports the failure.
    },
    async stage(request) {
      const release = watchSession(request.sessionId)
      const watch = watches.get(request.sessionId)!
      let journal: Journal | undefined
      const checkCurrent = () => { if (request.signal?.aborted || stopped || watch.disposed) throw new Error('The source conversation changed before staging completed. No message was sent.') }
      try {
        checkCurrent()
        const native = await watch.ready
        checkCurrent()
        if (!native.observeSubmissions) throw new Error('The native composer Send observer is unavailable. Refresh the app after applying the composer update; your draft was not changed or sent.')
        const state = native.state.getSnapshot()
        if (state.phase !== 'plain' || state.claim) throw new Error('The composer is busy. Your draft was not changed.')
        let prior = read(request.sessionId)
        if (prior && prior.decisionId !== request.decisionId) {
          if (prior.submissionId) { link(watch, prior); await watch.linking }
          const response = await fetch('/orchestrator/api/decisions/inbox', { headers: { 'x-orchestrator-request': '1' } })
          if (!response.ok) throw new Error('The previous staged choice could not be revalidated. Your draft was preserved.')
          const data = await response.json()
          const previous = data.items.find((item: any) => item.id === prior!.decisionId)
          if (!previous || previous.status !== 'pending' || previous.staging?.attemptId !== prior.attemptId) {
            forget(prior); watch.armed = undefined; watch.intent = undefined; prior = undefined
          }
          checkCurrent()
        }
        if (prior && prior.state !== 'invalidated') {
          if (prior.decisionId !== request.decisionId || prior.choiceId !== request.choiceId) throw new Error('Another choice is already linked to this draft. Discard its staging link before choosing differently.')
          const submittedText = await serializedDraft(watch, state, state.draft)
          if (await documentFingerprint(state) === prior.rawFingerprint && await decisionDraftFingerprint(submittedText) === prior.draftFingerprint) {
            checkCurrent()
            const result = await post(prior.decisionId, 'stage', { choiceId: prior.choiceId, attemptId: prior.attemptId, draftText: submittedText })
            onInput(request.sessionId, watch)
            return result
          }
          await clear(prior, watch)
        } else if (prior) await clear(prior, watch)
        const span = request.inputActions.captureInsertion()
        if (span.draftRev !== state.draftRev) throw new Error('The draft changed. Try choosing again.')
        const alreadyPresent = state.draft === request.prompt || state.draft.endsWith(`\n\n${request.prompt}`)
          || !!prior && prior.decisionId === request.decisionId && prior.choiceId === request.choiceId && state.draft.includes(request.prompt)
        const suffix = alreadyPresent ? '' : `${state.draft ? '\n\n' : ''}${request.prompt}`
        const draft = state.draft + suffix
        const submittedText = await serializedDraft(watch, state, draft)
        journal = { version: 1, sessionId: request.sessionId, decisionId: request.decisionId, choiceId: request.choiceId,
          attemptId: crypto.randomUUID(), rawFingerprint: await documentFingerprint(state, draft), draftFingerprint: await decisionDraftFingerprint(submittedText), stagedAt: now(), state: 'preparing' }
        checkCurrent()
        write(journal) // Verify recoverability before changing either the composer or the shared record.
        const result = await post(request.decisionId, 'stage', { choiceId: request.choiceId, attemptId: journal.attemptId, draftText: submittedText })
        if (result.item?.id !== request.decisionId || result.item?.sessionId !== request.sessionId || result.item?.status !== 'pending' || result.staging?.attemptId !== journal.attemptId || result.staging?.choiceId !== request.choiceId) throw new Error('The staged decision does not match this source conversation. Its draft was not changed.')
        checkCurrent()
        const current = native.state.getSnapshot()
        if (current.draftRev !== state.draftRev || current.phase !== 'plain' || !sameAttachments(current.attachmentIds, state.attachmentIds)) throw new Error('The draft changed while linking the choice. It was not replaced; choose again.')
        if (suffix && !request.inputActions.insertText(suffix, { ...span, start: state.draft.length, end: state.draft.length })) throw new Error('The draft changed or is locked. Your existing draft was preserved.')
        if (native.state.getSnapshot().draft !== draft) await new Promise<void>((resolve, reject) => {
          let unsubscribe = () => {}
          const timer = setTimeout(() => { unsubscribe(); reject(new Error('The inserted draft could not be verified. Its decision remains pending.')) }, 3000)
          const check = () => {
            const observed = native.state.getSnapshot()
            if (observed.draft === draft && observed.phase === 'plain') { clearTimeout(timer); unsubscribe(); resolve() }
          }
          unsubscribe = native.state.subscribe(check)
          check()
        })
        checkCurrent()
        request.inputActions.persistDraft()
        journal = { ...journal, state: 'staged' }
        write(journal)
        const stagedState = native.state.getSnapshot()
        watch.armed = { attemptId: journal.attemptId, draftRev: stagedState.draftRev, text: stagedState.draft, submittedText, attachments: [...stagedState.attachmentIds],
          before: new Set((watch.ref.binding.session.getSnapshot().pendingSubmissions as readonly NativeEcho[]).map(echo => echo.requestId)), at: now() }
        return result
      } catch (error) {
        if (journal?.state === 'preparing') {
          try { await clear(journal, watch) } catch { /* Fail closed; native notification/error leaves pending recovery visible. */ }
        }
        throw error
      } finally { release() }
    },
    async discard(decisionId, attemptId) {
      for (const [sessionId, watch] of watches) {
        const journal = read(sessionId)
        if (journal?.decisionId === decisionId && journal.attemptId === attemptId) return clear(journal, watch)
      }
      // Explicit user discard may clear a staging link owned by another browser, never its draft.
      return post(decisionId, 'discard-staging', { attemptId })
    },
    dispose() {
      stopped = true
      for (const watch of watches.values()) { watch.disposed = true; watch.unsubscribers.forEach(dispose => dispose()); watch.ref.release() }
      watches.clear()
    },
  }
}
