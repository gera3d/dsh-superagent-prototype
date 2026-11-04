/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { createDecisionSubmission, decisionDraftFingerprint } from '../src/client/decision-submission.ts'

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => value, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, set: (next: T, deferred = false) => { value = next; const notify = () => listeners.forEach(fn => fn()); if (deferred) queueMicrotask(notify); else notify() } }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
let cleanup: (() => void)[] = []
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = []; vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(draft = 'Existing user text', attachmentIds = ['image-one']) {
  const input = store<any>({ draft, draftRev: 1, phase: 'plain', occurrences: [], attachmentIds, queue: [] })
  const session = store<any>({ pendingSubmissions: [], running: false })
  const submissionObservers = new Set<(occurrence: any) => void>()
  const native = { state: input, notify: vi.fn(), observeSubmissions: (listener: (occurrence: any) => void) => { submissionObservers.add(listener); return () => { submissionObservers.delete(listener) } } }, release = vi.fn()
  const submitNative = (source: 'click' | 'enter' | undefined = 'click') => { for (const listener of submissionObservers) listener({ timestamp: Date.now(), source, input: input.getSnapshot() }) }
  const binding = { ctx: {}, session }
  const context = { sessions: { retain: vi.fn(() => ({ ready: Promise.resolve(binding), binding, release })) }, conversation: { input: { for: () => native } } }
  const calls: { action: string; body: any }[] = []
  let item: any = { id: 'decision', sessionId: 'session', status: 'pending' }, admitted: string | undefined, stageFailure = false, gate: Promise<void> | undefined
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
      if (body.submissionId === admitted) item = { ...item, status: 'resolved', resolvedChoice: 'a', submissionId: admitted }
    } else throw new Error('Unexpected action: ' + action)
    return { ok: true, json: async () => ({ item, staging: item.staging, execution: 'not_executed' }) }
  }))
  const bridge = createDecisionSubmission(context as any), unwatch = bridge.watch('session')
  cleanup.push(unwatch, () => bridge.dispose())
  const actions = { captureInsertion: vi.fn(() => ({ start: 0, end: draft.length, draftRev: input.getSnapshot().draftRev })), insertText: vi.fn((text: string, span: any) => {
    const s = input.getSnapshot(); if (s.phase !== 'plain' || span.draftRev !== s.draftRev) return false
    input.set({ ...s, draft: s.draft.slice(0, span.start) + text + s.draft.slice(span.end), draftRev: s.draftRev + 1 }); return true
  }), persistDraft: vi.fn() }
  const stage = (signal?: AbortSignal) => bridge.stage({ decisionId: 'decision', choiceId: 'a', sessionId: 'session', prompt: 'Choose A.', input: input.getSnapshot(), inputActions: actions as any, signal })
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
