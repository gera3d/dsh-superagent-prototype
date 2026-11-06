/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createDecisionSubmission, decisionDraftFingerprint } from '../src/client/decision-submission.ts'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, set: (next: T, deferred = false) => { value = next; const notify = () => listeners.forEach(fn => fn()); if (deferred) queueMicrotask(notify); else notify() } }
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
let cleanup: (() => void)[] = []
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = []; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(draft = 'Existing user text', attachmentIds = ['image-one'], choicePrompt = 'Choose A.') {
  const input = store<any>({ draft, draftRev: 1, phase: 'plain', occurrences: [], attachmentIds, queue: [] })
  const session = store<any>({ pendingSubmissions: [], running: false })
  const submissionObservers = new Set<(occurrence: any) => void>()
  const native = { state: input, notify: vi.fn(), observeSubmissions: (listener: (occurrence: any) => void) => { submissionObservers.add(listener); return () => { submissionObservers.delete(listener) } } }, release = vi.fn()
  const submitNative = (...args: [source?: 'click' | 'enter']) => { const source = args.length ? args[0] : 'click'; for (const listener of submissionObservers) listener({ timestamp: Date.now(), source, input: input.getSnapshot() }) }
  const binding = { ctx: {}, session }
  const context = { sessions: { retain: vi.fn(() => ({ ready: Promise.resolve(binding), binding, release })) }, conversation: { input: { for: () => native } } }
  const calls: { action: string; body: any }[] = []
  let item: any = { id: 'decision', sessionId: 'session', status: 'pending', choices: [{ id: 'a', prompt: choicePrompt }],
    canonical: { phase: 'scored' }, recommendation: { recommendedValue: 'a', distribution: [{ id: 'a', probability: 1 }] } }, admitted: string | undefined, stageFailure = false, gate: Promise<void> | undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.body) return { ok: true, json: async () => ({ items: [item] }) }
    const action = url.split('/').at(-1)!, body = JSON.parse(init.body as string)
    calls.push({ action, body })
    if (action === 'stage') {
      if (gate) await gate
      if (stageFailure) return { ok: false, status: 409, json: async () => ({ error: 'Decision is stale' }) }
      const id = decodeURIComponent(url.split('/').at(-2)!)
      if (item.id !== id) item = { id, sessionId: 'session', status: 'pending' }
      item = { ...item, staging: { attemptId: body.attemptId, choiceId: body.choiceId, stagedAt: 1, draftFingerprint: await decisionDraftFingerprint(body.draftText) } }
    } else if (action === 'discard-staging') item = { ...item, staging: undefined }
    else if (action === 'submission') {
      item = { ...item, staging: { ...item.staging, submissionId: body.submissionId } }
      if (body.submissionId === admitted) item = { ...item, status: 'resolved', resolvedChoice: 'a', submissionId: admitted,
        resolutionBasis: 'submitted', submittedMessageId: 'native-message', submittedSeq: 3, sourceSeq: 1, resolvedAt: Date.now() }
    } else throw new Error('Unexpected action: ' + action)
    return { ok: true, json: async () => ({ item, staging: item.staging, execution: 'not_executed' }) }
  }))
  const bridge = createDecisionSubmission(context as any), unwatch = bridge.watch('session')
  cleanup.push(unwatch, () => bridge.dispose())
  const actions = { captureInsertion: vi.fn(() => ({ start: 0, end: draft.length, draftRev: input.getSnapshot().draftRev })), insertText: vi.fn((text: string, span: any) => {
    const s = input.getSnapshot(); if (s.phase !== 'plain' || span.draftRev !== s.draftRev) return false
    input.set({ ...s, draft: s.draft.slice(0, span.start) + text + s.draft.slice(span.end), draftRev: s.draftRev + 1 }); return true
  }), persistDraft: vi.fn() }
  const stage = (signal?: AbortSignal) => bridge.stage({ decisionId: 'decision', choiceId: 'a', sessionId: 'session', prompt: choicePrompt, input: input.getSnapshot(), inputActions: actions as any, signal })
  const begin = (id: string, submittedText?: string) => {
    const s = input.getSnapshot(); submitNative() // Ordinary Send remains plain; the scoped native observer proves intent.
    input.set({ ...s, draft: '', attachmentIds: [], draftRev: s.draftRev + 1, phase: 'plain' })
    session.set({ pendingSubmissions: [{ requestId: id, text: submittedText ?? s.draft.trim(), attachments: [] }] })
  }
  const beginPlain = (id: string, beforeClear?: () => void, deferred = false) => {
    const s = input.getSnapshot(); submitNative()
    session.set({ ...session.getSnapshot(), pendingSubmissions: [...session.getSnapshot().pendingSubmissions, {
      requestId: id, time: Date.now(), text: s.draft.trim(), attachments: s.attachmentIds.map((id: string) => ({ type: 'image', value: { previewUrl: id } })),
    }] }, deferred)
    beforeClear?.()
    input.set({ ...s, draft: '', attachmentIds: [], occurrences: [], draftRev: s.draftRev + 1, phase: 'plain' })
  }
  return { bridge, context, input, session, native, submitNative, release, actions, stage, begin, beginPlain, calls, get item() { return item }, admit: (id: string) => { admitted = id; session.set({ pendingSubmissions: [] }) }, closeWithoutNotify: () => { item = { ...item, status: 'resolved' } }, failStage: () => { stageFailure = true }, gateStage: (p: Promise<void>) => { gate = p } }
}
it('stages pending and appends without replacing selected text or attachments; never sends or resolves', async () => {
  const f = fixture(), result = await f.stage()
  expect(result.item.status).toBe('pending')
  expect(f.input.getSnapshot().draft).toBe('Existing user text\n\nChoose A.')
  expect(f.input.getSnapshot().attachmentIds).toEqual(['image-one'])
  expect(f.actions.insertText.mock.calls[0]![1]).toMatchObject({ start: 18, end: 18 })
  expect(f.actions.persistDraft).toHaveBeenCalledOnce()
  expect(f.calls.map(c => c.action)).toEqual(['stage'])
})
it('binds exact native Send identity and stays pending until server-confirmed durable proof', async () => {
  const f = fixture(); await f.stage(); f.begin('rpc-one'); await settle()
  expect(f.calls.find(c => c.action === 'submission')?.body).toMatchObject({ attemptId: f.item.staging.attemptId, submissionId: 'rpc-one' })
  expect(f.item.status).toBe('pending')
  f.admit('rpc-one'); await settle()
  expect(f.item).toMatchObject({ status: 'resolved', resolvedChoice: 'a', submissionId: 'rpc-one' })
  expect(f.calls.some(c => c.action === 'resolve')).toBe(false)
})
it('links a native plain-mode Send synchronously before its editor is cleared and resolves only durable proof', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  const stagedText = f.input.getSnapshot().draft
  f.beginPlain('plain-native-id', () => {
    expect(f.input.getSnapshot()).toMatchObject({ phase: 'plain', draft: stagedText })
    expect(f.calls.filter(c => c.action === 'submission').at(-1)?.body).toMatchObject({ submissionId: 'plain-native-id' })
    const journal = Object.keys(localStorage).map(key => { try { return JSON.parse(localStorage.getItem(key)!) } catch { return undefined } }).find(value => value?.attemptId === f.item.staging.attemptId)
    expect(journal).toMatchObject({ state: 'awaiting_confirmation', submissionId: 'plain-native-id' })
    expect(JSON.stringify(journal)).not.toContain(stagedText)
  })
  await settle()
  expect(f.input.getSnapshot().draft).toBe('')
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  expect(f.item.status).toBe('pending')
  f.admit('plain-native-id'); await settle()
  expect(f.item).toMatchObject({ status: 'resolved', resolvedChoice: 'a', submissionId: 'plain-native-id' })
})

it('retains native Send intent when session notifications are batched until after editor clear', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  f.beginPlain('batched-native-echo', undefined, true)
  expect(f.input.getSnapshot().draft).toBe('')
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  await settle()
  expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('batched-native-echo')
  f.admit('batched-native-echo'); await settle()
  expect(f.item).toMatchObject({ status: 'resolved', submissionId: 'batched-native-echo' })
})

it('links plain-mode Send with attachments before native clears the attachment rail', async () => {
  const f = fixture(); await f.stage()
  f.beginPlain('plain-with-image', () => {
    expect(f.input.getSnapshot().attachmentIds).toEqual(['image-one'])
    expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('plain-with-image')
  }); await settle()
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  f.admit('plain-with-image'); await settle(); expect(f.item.status).toBe('resolved')
})

it('recovers a staged choice after reload and links a plain-mode Send without an adjudicating phase', async () => {
  const f = fixture('Existing user text', []); await f.stage(); f.bridge.dispose()
  const bridge = createDecisionSubmission(f.context as any), unwatch = bridge.watch('session'); cleanup.push(unwatch, () => bridge.dispose())
  await settle()
  f.beginPlain('plain-after-reload'); await settle()
  expect(f.calls.some(c => c.action === 'submission' && c.body.submissionId === 'plain-after-reload')).toBe(true)
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  f.admit('plain-after-reload'); await settle(); expect(f.item.status).toBe('resolved')
})

it('explicitly retries a failed plain-mode Send with a new native ID and retryOf', async () => {
  const f = fixture('Existing user text', []); await f.stage(); const text = f.input.getSnapshot().draft
  f.beginPlain('failed-plain'); await settle(); f.session.set({ pendingSubmissions: [] })
  f.input.set({ ...f.input.getSnapshot(), draft: text, draftRev: f.input.getSnapshot().draftRev + 1 }); await settle()
  f.beginPlain('retried-plain'); await settle()
  expect(f.calls.filter(c => c.action === 'submission').at(-1)?.body).toMatchObject({ submissionId: 'retried-plain', retryOf: 'failed-plain' })
  f.admit('retried-plain'); await settle(); expect(f.item.status).toBe('resolved')
})

it('does not adopt echoes that already existed when the draft was staged', async () => {
  const f = fixture('Existing user text', [])
  f.session.set({ pendingSubmissions: [{ requestId: 'pre-existing', time: Date.now(), text: 'Existing user text\n\nChoose A.', attachments: [] }] })
  await f.stage(); f.session.set({ ...f.session.getSnapshot() }); await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})

it('rejects a new-looking echo older than the armed input and an echo with mismatched attachments', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  for (const echo of [
    { requestId: 'old', time: 1, text: f.input.getSnapshot().draft.trim(), attachments: [] },
    { requestId: 'wrong-attachments', time: Date.now(), text: f.input.getSnapshot().draft.trim(), attachments: [{}] },
    { requestId: 'different-text', time: Date.now(), text: 'Different request', attachments: [] },
  ]) f.session.set({ pendingSubmissions: [echo] })
  await settle(); expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})

it('does not infer Send from a complete new echo followed by a manual clear without a native Send occurrence', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  const s = f.input.getSnapshot()
  f.session.set({ pendingSubmissions: [{ requestId: 'unrelated-complete-echo', time: Date.now(), text: s.draft.trim(), attachments: [] }] })
  f.input.set({ ...s, draft: '', draftRev: s.draftRev + 1 })
  await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
  expect(f.item.status).toBe('pending')
})

it('keeps the link when ordinary Send clears before its batched session notification', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  const s = f.input.getSnapshot(); f.submitNative('enter')
  f.input.set({ ...s, draft: '', draftRev: s.draftRev + 1, phase: 'plain' })
  await Promise.resolve()
  f.session.set({ pendingSubmissions: [{ requestId: 'batched-native', text: s.draft.trim(), attachments: [] }] })
  await settle()
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('batched-native')
  f.admit('batched-native'); await settle(); expect(f.item.status).toBe('resolved')
})

it('re-proves a restored draft after Send fails before creating any request echo', async () => {
  const f = fixture('Existing user text', []); await f.stage()
  const s = f.input.getSnapshot(); f.submitNative()
  f.input.set({ ...s, draft: '', draftRev: s.draftRev + 1 })
  f.input.set({ ...s, draftRev: s.draftRev + 2 }); await settle()
  expect(f.calls.some(c => c.action === 'discard-staging')).toBe(false)
  f.beginPlain('after-serialization-retry'); await settle()
  expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('after-serialization-retry')
})

it('refuses staging on an older facade without a native Send observer before changing the draft', async () => {
  const f = fixture(); delete (f.native as any).observeSubmissions
  await expect(f.stage()).rejects.toThrow('Send observer is unavailable')
  expect(f.actions.insertText).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(0)
})

it('never attributes an identical-text echo without the staged native input attempt', async () => {
  const f = fixture(); await f.stage()
  f.session.set({ pendingSubmissions: [{ requestId: 'unrelated', text: f.input.getSnapshot().draft.trim() }] }); await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})
it('explicit discard clears linkage only and does not link a later identical send', async () => {
  const f = fixture(), result = await f.stage(), text = f.input.getSnapshot().draft
  await f.bridge.discard('decision', result.staging.attemptId)
  expect(f.input.getSnapshot().draft).toBe(text)
  expect(f.input.getSnapshot().attachmentIds).toEqual(['image-one'])
  f.begin('after-discard'); await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})
it('draft editing clears staging without changing user content or resolving the next message', async () => {
  const f = fixture(); await f.stage()
  f.input.set({ ...f.input.getSnapshot(), draft: 'Different reply', draftRev: 3 }); await settle()
  expect(f.item.staging).toBeUndefined(); expect(f.input.getSnapshot().draft).toBe('Different reply')
  f.begin('different'); await settle(); expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})
it('reload restores staged linkage without duplicate insertion', async () => {
  const f = fixture(); await f.stage(); const text = f.input.getSnapshot().draft
  f.bridge.dispose(); f.input.set({ ...f.input.getSnapshot(), draftRev: 1 })
  const reloaded = createDecisionSubmission(f.context as any), release = reloaded.watch('session'); cleanup.push(release, () => reloaded.dispose())
  await settle(); expect(f.input.getSnapshot().draft).toBe(text); expect(f.actions.insertText).toHaveBeenCalledOnce()
  f.begin('after-reload'); await settle(); expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('after-reload')
})
it('reload replays the journalled native id instead of inferring a later message', async () => {
  const f = fixture(); await f.stage(); f.begin('original-id'); await settle(); f.bridge.dispose(); f.session.set({ pendingSubmissions: [] })
  const reloaded = createDecisionSubmission(f.context as any), release = reloaded.watch('session'); cleanup.push(release, () => reloaded.dispose())
  await settle(); expect(f.calls.filter(c => c.action === 'submission').map(c => c.body.submissionId)).toEqual(['original-id', 'original-id'])
  f.admit('original-id'); await settle(); expect(f.item.status).toBe('resolved')
})
it('failed Send can be explicitly retried on the restored draft with a new request id and retry CAS', async () => {
  const f = fixture(); await f.stage(); const text = f.input.getSnapshot().draft
  f.begin('failed-id'); await settle(); f.session.set({ pendingSubmissions: [] })
  f.input.set({ ...f.input.getSnapshot(), draft: text, attachmentIds: ['image-one'], draftRev: 4, phase: 'plain' }); await settle()
  f.begin('retry-id'); await settle()
  expect(f.calls.filter(c => c.action === 'submission').at(-1)?.body).toMatchObject({ submissionId: 'retry-id', retryOf: 'failed-id' })
  expect(f.item.status).toBe('pending'); f.admit('retry-id'); await settle(); expect(f.item.status).toBe('resolved')
})
it('another tab cannot adopt the staged draft merely by matching its text', async () => {
  const f = fixture(); await f.stage(); f.bridge.dispose(); sessionStorage.clear()
  const other = createDecisionSubmission(f.context as any), release = other.watch('session'); cleanup.push(release, () => other.dispose())
  await settle(); f.begin('other-tab'); await settle(); expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})
it('fails closed for reference chips rather than guessing their serialized content', async () => {
  const f = fixture(); f.input.set({ ...f.input.getSnapshot(), occurrences: [{ source: 'file', ref: 'some-file' }] })
  await expect(f.stage()).rejects.toThrow('reference chips'); expect(f.actions.insertText).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0)
})
it('preserves reference chips and binds the exact native codec serialization instead of clipboard labels', async () => {
  const f = fixture('@file')
  f.input.set({ ...f.input.getSnapshot(), occurrences: [{ offset: 0, length: 5, source: 'file', ref: 'file-one', clipboardText: '@file' }] })
  ;(f.context as any).inputTriggers = { sessionOf: () => ({ serializeReference: async () => '[file bytes]' }) }
  await f.stage()
  expect(f.input.getSnapshot().draft).toBe('@file\n\nChoose A.')
  expect(f.input.getSnapshot().occurrences[0].ref).toBe('file-one')
  expect(f.calls.find(c => c.action === 'stage')?.body.draftText).toBe('[file bytes]\n\nChoose A.')
  f.begin('reference-send', '[file bytes]\n\nChoose A.'); await settle()
  expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('reference-send')
  f.admit('reference-send'); await settle(); expect(f.item.status).toBe('resolved')
})
it('changed reference serialization cannot resolve the decision from a mismatching send', async () => {
  const f = fixture('@file')
  f.input.set({ ...f.input.getSnapshot(), occurrences: [{ offset: 0, length: 5, source: 'file', ref: 'file-one' }] })
  ;(f.context as any).inputTriggers = { sessionOf: () => ({ serializeReference: async () => 'version one' }) }
  await f.stage(); f.begin('changed-reference', 'version two\n\nChoose A.'); await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
  expect(f.item.status).toBe('pending'); expect(f.native.notify).toHaveBeenCalled()
})
it('waits for native asynchronous editor projection before persisting and arming the staged draft', async () => {
  const f = fixture()
  f.actions.insertText.mockImplementation((text: string, span: any) => {
    const snapshot = f.input.getSnapshot()
    setTimeout(() => f.input.set({ ...snapshot, draft: snapshot.draft + text, draftRev: span.draftRev + 1 }), 0)
    return true
  })
  await f.stage(); expect(f.actions.persistDraft).toHaveBeenCalledOnce()
  f.begin('after-editor-commit'); await settle()
  expect(f.calls.find(c => c.action === 'submission')?.body.submissionId).toBe('after-editor-commit')
})
it('a staging conflict preserves the original text and attachments', async () => {
  const f = fixture(); f.failStage(); await expect(f.stage()).rejects.toThrow('stale')
  expect(f.input.getSnapshot().draft).toBe('Existing user text'); expect(f.input.getSnapshot().attachmentIds).toEqual(['image-one']); expect(f.actions.insertText).not.toHaveBeenCalled()
})
it('an edit during stage preparation is never replaced', async () => {
  const f = fixture(); let resume!: () => void; f.gateStage(new Promise<void>(resolve => { resume = resolve }))
  const pending = f.stage(); await settle(); f.input.set({ ...f.input.getSnapshot(), draft: 'New edit', draftRev: 2 }); resume()
  await expect(pending).rejects.toThrow('draft changed'); expect(f.input.getSnapshot().draft).toBe('New edit'); expect(f.actions.insertText).not.toHaveBeenCalled()
})
it('source cancellation during stage preparation never inserts into the departed editor', async () => {
  const f = fixture(), controller = new AbortController(); let resume!: () => void
  f.gateStage(new Promise<void>(resolve => { resume = resolve }))
  const pending = f.stage(controller.signal); await settle(); controller.abort(); resume()
  await expect(pending).rejects.toThrow('source conversation changed')
  expect(f.actions.insertText).not.toHaveBeenCalled(); expect(f.input.getSnapshot().draft).toBe('Existing user text'); expect(f.item.status).toBe('pending')
})
it('a lost initial link request is replayed before its explicit native retry is bound', async () => {
  const f = fixture(), original = globalThis.fetch; let loseFirstLink = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/submission') && loseFirstLink) { loseFirstLink = false; throw new Error('Network unavailable') }
    return original(url, init)
  }))
  await f.stage(); const text = f.input.getSnapshot().draft
  f.begin('lost-link'); await settle(); f.session.set({ pendingSubmissions: [] })
  f.input.set({ ...f.input.getSnapshot(), draft: text, attachmentIds: ['image-one'], draftRev: 4 }); await settle()
  f.begin('explicit-retry'); await settle()
  const links = f.calls.filter(c => c.action === 'submission')
  expect(links.some(c => c.body.submissionId === 'lost-link' && !c.body.retryOf)).toBe(true)
  expect(links.at(-1)?.body).toMatchObject({ submissionId: 'explicit-retry', retryOf: 'lost-link' })
  expect(f.item.status).toBe('pending')
})
it('a closed prior journal cannot block staging a newer decision in the same source session', async () => {
  const f = fixture(); await f.stage(); f.closeWithoutNotify()
  await f.bridge.stage({ decisionId: 'new-decision', choiceId: 'b', sessionId: 'session', prompt: 'Choose B.', input: f.input.getSnapshot(), inputActions: f.actions as any })
  expect(f.item).toMatchObject({ id: 'new-decision', status: 'pending', staging: { choiceId: 'b' } })
  expect(f.input.getSnapshot().draft).toContain('Choose B.')
})
it('a mismatched canonical source response never inserts into the requested editor', async () => {
  const f = fixture()
  await expect(f.bridge.stage({ decisionId: 'decision', choiceId: 'a', sessionId: 'wrong-source', prompt: 'Choose A.', input: f.input.getSnapshot(), inputActions: f.actions as any })).rejects.toThrow('does not match this source conversation')
  expect(f.actions.insertText).not.toHaveBeenCalled(); expect(f.input.getSnapshot().draft).toBe('Existing user text')
})
it('an unavailable session can mount a read-only dock safely but refuses explicit staging', async () => {
  const f = fixture(); f.context.sessions.retain.mockImplementation(() => { throw new Error('Session removed') })
  const bridge = createDecisionSubmission(f.context as any); cleanup.push(() => bridge.dispose())
  expect(() => bridge.watch('removed')).not.toThrow()
  await expect(bridge.stage({ decisionId: 'decision', choiceId: 'a', sessionId: 'removed', prompt: 'Choose A.', input: f.input.getSnapshot(), inputActions: f.actions as any })).rejects.toThrow('Session removed')
  expect(f.actions.insertText).not.toHaveBeenCalled()
})
it('unavailable recovery storage refuses staging before changing the draft', async () => {
  const f = fixture(), blocked = { getItem: () => null, setItem: () => { throw new Error('Storage blocked') } } as unknown as Storage
  const bridge = createDecisionSubmission(f.context as any, { tabStorage: blocked }); cleanup.push(() => bridge.dispose())
  await expect(bridge.stage({ decisionId: 'decision', choiceId: 'a', sessionId: 'session', prompt: 'Choose A.', input: f.input.getSnapshot(), inputActions: f.actions as any })).rejects.toThrow('Storage blocked')
  expect(f.actions.insertText).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0)
})

function programmatic(f: ReturnType<typeof fixture>, attemptId: string, signal?: AbortSignal, submit?: () => void) {
  return f.bridge.submitStaged({ decisionId: 'decision', attemptId, sessionId: 'session', signal,
    inputActions: { submit: submit ?? (() => {
      const s = f.input.getSnapshot()
      f.submitNative(undefined)
      f.session.set({ pendingSubmissions: [{ requestId: 'actual-native-rpc', text: s.draft.trim() }] })
      f.input.set({ ...s, draft: '', draftRev: s.draftRev + 1 })
    }) } })
}

it('scoped programmatic native Send awaits canonical durable proof and returns only its actual requestId', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  let done = false
  const result = programmatic(f, staged.staging.attemptId).then(value => { done = true; return value })
  await settle()
  expect(done).toBe(false)
  expect(f.calls.filter(c => c.action === 'submission').at(-1)?.body.submissionId).toBe('actual-native-rpc')
  f.admit('actual-native-rpc')
  await expect(result).resolves.toEqual({ submissionId: 'actual-native-rpc' })
  expect(JSON.stringify(Object.values(localStorage))).not.toContain('Existing user text')
})

it('coalesces a durable notification during an in-flight pending canonical link into a recheck', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), original = globalThis.fetch
  let release!: () => void, started!: () => void, first = true
  const held = new Promise<void>(resolve => { release = resolve })
  const inFlight = new Promise<void>(resolve => { started = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const response = await original(url, init)
    if (url.endsWith('/submission') && first) {
      first = false
      const pendingSnapshot = await response.json()
      started(); await held
      return { ok: true, json: async () => pendingSnapshot }
    }
    return response
  }))
  const result = programmatic(f, staged.staging.attemptId)
  await inFlight
  f.admit('actual-native-rpc')
  release()
  await expect(result).resolves.toEqual({ submissionId: 'actual-native-rpc' })
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(2)
})

it('integrates scoped native observation with the real DecisionInbox durable proof path', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { DecisionInbox, stageDecision, submitDecision } = await import('../src/app/decision-inbox.ts')
  const f = fixture('', [], 'Run the test suite.'), db = new DatabaseSync(':memory:')
  const inbox = new DecisionInbox(db)
  const events: any[] = [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 101, data: { turn: 1, step: 1, message: { id: 'source-message', role: 'assistant',
      content: [{ type: 'text', text: 'Which approach?\nA) Run the test suite.\nB) Inspect the diff.' }] }, stream: [] } },
    { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const actualItem = inbox.put({ id: 'decision', sessionId: 'session', sourceMessageId: 'source-message', sourceSeq: 1, sourceTurn: 1,
    ticketTitle: 'Fixture', trigger: 'Fixture', status: 'pending', urgency: 'low', createdAt: 102, context: '', question: 'Which approach?',
    recommendation: { recommendedValue: 'a', confidence: 0.7, rationale: '', distribution: [{ id: 'a', probability: 0.7 }, { id: 'b', probability: 0.3 }], provider: '', latencyMs: 0 },
    canonical: { phase: 'scored', draftRevision: 'fixture', owner: 'fixture', leaseToken: 'fixture', leaseExpiresAt: Date.now() + 60_000 },
    choices: [{ id: 'a', label: 'Run tests', prompt: 'Run the test suite.' }, { id: 'b', label: 'Inspect diff', prompt: 'Inspect the diff.' }],
  })
  const ctx = { sessionPersistence: { flush: async () => {}, open: async () => ({
    read: async (offset: number) => ({ events: offset ? [] : [...events] }), [Symbol.asyncDispose]: async () => {},
  }) } } as any
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!init?.body) return { ok: true, json: async () => ({ items: inbox.list() }) }
    const body = JSON.parse(init.body as string), action = url.split('/').at(-1)
    const result = action === 'stage' ? await stageDecision(ctx, inbox, actualItem.id, body)
      : action === 'submission' ? await submitDecision(ctx, inbox, actualItem.id, body)
        : inbox.discardStaging(actualItem.id, body.attemptId)
    return { ok: true, json: async () => result }
  }))
  try {
    const staged = await f.bridge.stage({ decisionId: actualItem.id, choiceId: actualItem.choices[0]!.id, sessionId: 'session',
      prompt: 'Run the test suite.', input: f.input.getSnapshot(), inputActions: f.actions as any })
    let settled = false
    const result = f.bridge.submitStaged({ decisionId: actualItem.id, attemptId: staged.staging.attemptId,
      sessionId: 'session', inputActions: { submit: () => {
        const s = f.input.getSnapshot()
        f.submitNative(undefined)
        f.session.set({ pendingSubmissions: [{ requestId: 'actual-native-rpc', text: s.draft.trim() }] })
        f.input.set({ ...s, draft: '', draftRev: s.draftRev + 1 })
      } } }).then(value => { settled = true; return value })
    const confirmed = expect(result).resolves.toEqual({ submissionId: 'actual-native-rpc' })
    await settle()
    expect(settled).toBe(false)
    expect(inbox.get(actualItem.id)?.status).toBe('pending')
    events.push({ type: 'user/message', seq: 3, time: 1003, data: { id: 'real-inbox-native-message', role: 'user',
      source: { kind: 'user', rpcId: 'actual-native-rpc' }, content: [{ type: 'text', text: 'Run the test suite.' }] } })
    // A native session update triggers a server-owned full durable-history read, not browser-supplied proof.
    f.session.set({ pendingSubmissions: [] })
    await confirmed
    expect(inbox.get(actualItem.id)).toMatchObject({ status: 'resolved', resolutionBasis: 'submitted',
      submissionId: 'actual-native-rpc', submittedMessageId: 'real-inbox-native-message', submittedSeq: 3 })
  } finally { f.bridge.dispose(); db.close() }
})

it('never accepts unscoped or asynchronous undefined native observer occurrences', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  f.submitNative(undefined)
  f.session.set({ pendingSubmissions: [{ requestId: 'unscoped', text: f.input.getSnapshot().draft.trim() }] })
  await settle()
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
  await expect(programmatic(f, staged.staging.attemptId, undefined, () => queueMicrotask(() => f.submitNative(undefined)))).rejects.toThrow('unconfirmed')
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})

it('refuses duplicate programmatic attempts and persists one-shot consumption after abort', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), controller = new AbortController()
  const first = programmatic(f, staged.staging.attemptId, controller.signal)
  const failure = expect(first).rejects.toThrow('unconfirmed')
  await settle()
  await expect(programmatic(f, staged.staging.attemptId)).rejects.toThrow('unavailable or already consumed')
  controller.abort(); await failure
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(1)
})

it('refuses wrong-session and pre-aborted requests before invoking native Send', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn(), controller = new AbortController()
  controller.abort()
  await expect(programmatic(f, staged.staging.attemptId, controller.signal, submit)).rejects.toThrow()
  await expect(f.bridge.submitStaged({ decisionId: 'decision', attemptId: staged.staging.attemptId,
    sessionId: 'other-session', inputActions: { submit } })).rejects.toThrow()
  expect(submit).not.toHaveBeenCalled()
})

it('rejects fake resolved proof with wrong native request or missing canonical evidence', async () => {
  for (const proof of [{ submissionId: 'fabricated' }, { resolutionBasis: undefined }, { submittedMessageId: '' }, { submittedSeq: 1 }, { sessionId: 'other' }]) {
    const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), original = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const response = await original(url, init)
      if (!url.endsWith('/submission')) return response
      const body = await response.json()
      return { ok: true, json: async () => ({ ...body, item: { ...body.item, status: 'resolved', resolvedChoice: 'a',
        resolutionBasis: 'submitted', submittedMessageId: 'native-message', submittedSeq: 3, sourceSeq: 1,
        resolvedAt: Date.now(), submissionId: 'actual-native-rpc', ...proof } }) }
    }))
    await expect(programmatic(f, staged.staging.attemptId)).rejects.toThrow('unconfirmed')
    f.bridge.dispose()
  }
})

it('times out an unconfirmed native submission without resending', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  const originalTimeout = globalThis.setTimeout
  vi.stubGlobal('setTimeout', (handler: () => void, delay: number) => originalTimeout(handler, delay === 30_000 ? 50 : delay))
  await expect(programmatic(f, staged.staging.attemptId)).rejects.toThrow('unconfirmed')
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(1)
})

it('blocks every privileged canonical action kind even under an allowlisted benign prompt', async () => {
  for (const actionKind of ['approve', 'publish', 'restart', 'rollback', 'merge', 'unknown']) {
    const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn()
    f.item.choices[0].actionKind = actionKind
    await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('requires human action')
    expect(submit).not.toHaveBeenCalled()
    f.bridge.dispose()
  }
})

it('blocks ticket_lifecycle actionMode even without a lifecycle field or privileged choice kind', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn()
  f.item.actionMode = 'ticket_lifecycle'
  f.item.choices[0].actionKind = 'suggestion'
  expect(f.item.lifecycle).toBeUndefined()
  await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('requires human action')
  expect(submit).not.toHaveBeenCalled()
})

it('rechecks fresh canonical phase, recommendation, full-precision confidence and distribution before Send', async () => {
  const invalid: Array<(item: any) => void> = [
    item => { item.canonical = undefined },
    item => { item.canonical.phase = 'ready' },
    item => { item.recommendation.recommendedValue = 'b' },
    item => { item.recommendation.distribution = [{ id: 'a', probability: 0.3 }, { id: 'b', probability: 0.7 }] },
    item => { item.recommendation.distribution = [{ id: 'a', probability: 0.522 }, { id: 'b', probability: 0.478 }] },
    item => { item.recommendation.distribution = [{ id: 'a', probability: 0.5 }, { id: 'b', probability: 0.5 }] },
    item => { item.choices.push({ id: 'c', prompt: 'Inspect the test coverage.' }); item.recommendation.distribution = [
      { id: 'a', probability: 0.39 }, { id: 'b', probability: 0.32 }, { id: 'c', probability: 0.29 }] },
    item => { item.recommendation.distribution.pop() },
    item => { item.recommendation.distribution[1].id = 'a' },
    item => { item.recommendation.distribution[1].id = 'foreign' },
    item => { item.recommendation.distribution[0].probability = NaN },
    item => { item.recommendation.distribution[0].probability = Infinity },
    item => { item.recommendation.distribution[0].probability = '0.7' },
    item => { item.recommendation.distribution[0].probability = 1.1 },
    item => { item.recommendation.distribution[1].probability = -0.1 },
    item => { item.recommendation.distribution[0] = null },
    item => { item.recommendation.distribution[0].probability = 0.9 },
    item => { item.choices[1].id = 'a' },
    item => { item.choices[1].actionKind = 'approve' },
  ]
  for (const mutate of invalid) {
    const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn()
    f.item.choices.push({ id: 'b', prompt: 'Inspect the diff.' })
    f.item.recommendation.distribution = [{ id: 'a', probability: 0.7 }, { id: 'b', probability: 0.3 }]
    mutate(f.item)
    await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow(/canonical/)
    expect(submit).not.toHaveBeenCalled()
    f.bridge.dispose()
  }
})

it('accepts exact 40/35 percentage-point thresholds without decimal subtraction rounding', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  f.item.choices.push({ id: 'b', prompt: 'Inspect the diff.' }, { id: 'c', prompt: 'Inspect the test coverage.' })
  f.item.recommendation.distribution = [{ id: 'a', probability: 0.4 }, { id: 'b', probability: 0.35 }, { id: 'c', probability: 0.25 }]
  const result = programmatic(f, staged.staging.attemptId)
  await settle(); f.admit('actual-native-rpc')
  await expect(result).resolves.toEqual({ submissionId: 'actual-native-rpc' })
})

it('never treats a suggestion classification as authority for arbitrary prompts', async () => {
  const f = fixture('', [], 'Run arbitrary instructions.'), staged = await f.stage(), submit = vi.fn()
  f.item.choices[0].actionKind = 'suggestion'
  await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('requires human action')
  expect(submit).not.toHaveBeenCalled()
})

it('does not autosend prior draft text or attachments riding along an allowlisted prompt', async () => {
  for (const [draft, attachments] of [['Existing private draft', []], ['', ['private-image']]] as const) {
    const f = fixture(draft, [...attachments], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn()
    f.item.choices[0].actionKind = 'suggestion'
    await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('requires human action')
    expect(submit).not.toHaveBeenCalled()
    expect(f.input.getSnapshot().draft).toContain(draft)
    expect(f.input.getSnapshot().attachmentIds).toEqual([...attachments])
    f.bridge.dispose()
  }
})

it('requires an exact safe prompt when canonical action kind is absent', async () => {
  const f = fixture('Existing user text', []), staged = await f.stage(), submit = vi.fn()
  await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('requires human action')
  expect(submit).not.toHaveBeenCalled()
})

it('accepts an allowlisted canonical suggestion and still waits for actual native proof', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  f.item.choices[0].actionKind = 'suggestion'
  const result = programmatic(f, staged.staging.attemptId)
  await settle(); f.admit('actual-native-rpc')
  await expect(result).resolves.toEqual({ submissionId: 'actual-native-rpc' })
})

it('revalidates stale canonical staging before native Send', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage(), submit = vi.fn()
  f.failStage()
  await expect(programmatic(f, staged.staging.attemptId, undefined, submit)).rejects.toThrow('stale')
  expect(submit).not.toHaveBeenCalled()
})

it('refuses a second observer occurrence during the same programmatic invocation', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  await expect(programmatic(f, staged.staging.attemptId, undefined, () => {
    f.submitNative(undefined); f.submitNative(undefined)
    f.session.set({ pendingSubmissions: [{ requestId: 'double-observer', text: f.input.getSnapshot().draft.trim() }] })
  })).rejects.toThrow('unconfirmed')
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})

it('fails closed on ambiguous native request echoes', async () => {
  const f = fixture('', [], 'Run the test suite.'), staged = await f.stage()
  await expect(programmatic(f, staged.staging.attemptId, undefined, () => {
    f.submitNative(undefined)
    const text = f.input.getSnapshot().draft.trim()
    f.session.set({ pendingSubmissions: [{ requestId: 'one', text }, { requestId: 'two', text }] })
  })).rejects.toThrow('unconfirmed')
  expect(f.calls.filter(c => c.action === 'submission')).toHaveLength(0)
})
