import { describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DotAction } from '../src/app/dot.ts'
import type { DotContext } from '../src/client/dot-chat.tsx'
import { executeApprovedDotAction } from '../src/client/dot-execution.ts'

const snapshot = (): DotContext => ({
  projects: [{ id: 'workspace', title: 'App', path: '/app' }],
  threads: [{ id: 'existing', title: 'Active', projectId: 'workspace', running: true, waiting: 0, updatedAt: 1 }],
})
const start: DotAction = { type: 'start_thread', projectId: 'workspace', prompt: 'Implement the change', why: 'Approved task' }
const message: DotAction = { type: 'message_thread', sessionId: 'existing', prompt: 'Follow up', why: 'Approved followup' }
const open: DotAction = { type: 'open_thread', sessionId: 'existing', why: 'Inspect' }

function fixture() {
  const controller = new AbortController()
  const abandon = vi.fn()
  const beginSubmission = vi.fn(() => ({ requestId: 'request-1', abandon }))
  const prompt = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: { accepted: true } }))
  const cancel = vi.fn(), updateQueue = vi.fn()
  const session = { beginSubmission, prompt, cancel, updateQueue }
  const ready = vi.fn(async () => ({ session }))
  const using = vi.fn(async (_id: unknown, _options: unknown, operation: (ref: unknown) => unknown) => operation({ ready: ready() }))
  const create = vi.fn(async () => 'created')
  const sessions = { create, using } as unknown as ISessions
  const approved = snapshot()
  const getContext = vi.fn(async () => snapshot())
  const openSession = vi.fn(async (_id: string) => {})
  const execute = (action: DotAction = start) => executeApprovedDotAction(sessions, action, approved, getContext, controller.signal, openSession)
  return { controller, abandon, beginSubmission, prompt, cancel, updateQueue, ready, using, create, approved, getContext, openSession, execute }
}

describe('executeApprovedDotAction explicit approval boundary', () => {
  it('does nothing before explicit invocation, then creates and queues exactly once', async () => {
    const f = fixture()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(await f.execute()).toMatchObject({ status: 'succeeded', sessionId: 'created' })
    expect(f.getContext).toHaveBeenCalledOnce()
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace' })
    expect(f.using).toHaveBeenCalledExactlyOnceWith('created', { source: 'controllerOperation', signal: f.controller.signal }, expect.any(Function))
    expect(f.ready).toHaveBeenCalledOnce()
    expect(f.beginSubmission).toHaveBeenCalledExactlyOnceWith({ mode: 'queue', text: start.prompt, attachments: [] })
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: start.prompt }], 'queue', f.controller.signal, 'request-1')
    expect(f.openSession).not.toHaveBeenCalled()
  })

  it('uses cwd only for the catalog fallback, never a workspace id', async () => {
    const f = fixture()
    const context = snapshot()
    context.projects[0]!.id = 'cwd:/app'
    f.approved.projects = context.projects
    f.getContext.mockResolvedValue(context)
    expect((await f.execute({ ...start, projectId: 'cwd:/app' })).status).toBe('succeeded')
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ cwd: '/app' })
  })

  it.each([
    { type: 'delete_thread', why: 'bad' }, null, { ...start, prompt: '' }, { ...start, prompt: '  ' },
    { ...start, prompt: 4 }, { ...start, projectId: null }, { ...message, sessionId: '' }, { ...open, why: null },
  ])('rejects malformed or unknown action without mutations: %j', async action => {
    const f = fixture()
    expect((await f.execute(action as DotAction)).status).toBe('failed')
    expect(f.create).not.toHaveBeenCalled(); expect(f.using).not.toHaveBeenCalled(); expect(f.openSession).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'removed', 'path', 'fallback'])('rejects unknown or stale project %s', async kind => {
    const f = fixture()
    const current = snapshot()
    let action = start
    if (kind === 'unknown') f.approved.projects = []
    if (kind === 'removed') current.projects = []
    if (kind === 'path') current.projects[0]!.path = '/another'
    if (kind === 'fallback') {
      f.approved.projects[0]!.id = current.projects[0]!.id = 'cwd:/different'
      action = { ...start, projectId: 'cwd:/different' }
    }
    f.getContext.mockResolvedValue(current)
    expect((await f.execute(action)).status).toBe('failed')
    expect(f.create).not.toHaveBeenCalled(); expect(f.using).not.toHaveBeenCalled()
  })

  it.each([message, open])('requires approved and current thread membership for $type', async action => {
    for (const missing of ['approved', 'current']) {
      const f = fixture()
      if (missing === 'approved') f.approved.threads = []
      else f.getContext.mockResolvedValue({ ...snapshot(), threads: [] })
      expect((await f.execute(action)).status).toBe('failed')
      expect(f.create).not.toHaveBeenCalled(); expect(f.using).not.toHaveBeenCalled(); expect(f.openSession).not.toHaveBeenCalled()
    }
  })

  it('queues followup to a running thread without creating, steering, or cancelling', async () => {
    const f = fixture()
    expect(await f.execute(message)).toMatchObject({ status: 'succeeded', sessionId: 'existing' })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: message.prompt }], 'queue', f.controller.signal, 'request-1')
    expect(f.cancel).not.toHaveBeenCalled(); expect(f.updateQueue).not.toHaveBeenCalled()
  })

  it('opens only the validated thread, without a prompt or retain', async () => {
    const f = fixture()
    expect(await f.execute(open)).toMatchObject({ status: 'succeeded', sessionId: 'existing' })
    expect(f.openSession).toHaveBeenCalledExactlyOnceWith('existing')
    expect(f.using).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  })

  it('has no side effects when already aborted', async () => {
    const f = fixture(); f.controller.abort()
    expect((await f.execute()).status).toBe('failed')
    expect(f.getContext).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.using).not.toHaveBeenCalled()
  })

  it.each([start, message, open])('rechecks abort after catalog refresh for $type', async action => {
    const f = fixture()
    f.getContext.mockImplementation(async () => { f.controller.abort(); return snapshot() })
    expect((await f.execute(action)).status).toBe('failed')
    expect(f.create).not.toHaveBeenCalled(); expect(f.using).not.toHaveBeenCalled(); expect(f.openSession).not.toHaveBeenCalled()
  })

  it('retains created id if aborted during create, with no prompt or retry', async () => {
    const f = fixture()
    f.create.mockImplementation(async () => { f.controller.abort(); return 'created' })
    expect(await f.execute()).toMatchObject({ status: 'failed', sessionId: 'created' })
    expect(f.create).toHaveBeenCalledOnce(); expect(f.using).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  })

  it('does not begin a submission if aborted while waiting for ready', async () => {
    const f = fixture()
    f.ready.mockImplementation(async () => { f.controller.abort(); return { session: { beginSubmission: f.beginSubmission, prompt: f.prompt, cancel: f.cancel, updateQueue: f.updateQueue } } })
    expect((await f.execute(message)).status).toBe('failed')
    expect(f.beginSubmission).not.toHaveBeenCalled(); expect(f.prompt).not.toHaveBeenCalled()
  })

  it('abandons the echo if cancellation occurs during submission setup', async () => {
    const f = fixture()
    f.beginSubmission.mockImplementation(() => { f.controller.abort(); return { requestId: 'request-1', abandon: f.abandon } })
    expect((await f.execute(message)).status).toBe('failed')
    expect(f.abandon).toHaveBeenCalledOnce(); expect(f.prompt).not.toHaveBeenCalled()
  })

  it('reports rejected RemoteResult, retains created id, and never retries', async () => {
    const f = fixture()
    f.prompt.mockResolvedValue({ ok: false, error: { message: 'SECRET server detail', code: 'unavailable' } })
    const result = await f.execute()
    expect(result).toMatchObject({ status: 'failed', sessionId: 'created', message: expect.stringContaining('did not accept') })
    expect(result.message).not.toContain('SECRET')
    expect(f.abandon).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce()
  })

  it('abandons echo on serialization/transport exception without replay', async () => {
    const f = fixture()
    f.prompt.mockRejectedValue(new Error('SECRET serialization detail'))
    const result = await f.execute()
    expect(result).toMatchObject({ status: 'failed', sessionId: 'created' })
    expect(result.message).not.toContain('SECRET')
    expect(f.abandon).toHaveBeenCalledOnce(); expect(f.prompt).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce()
  })

  it('never retries uncertain create and returns a safe failure', async () => {
    const f = fixture(); f.create.mockRejectedValue(new Error('SECRET'))
    const result = await f.execute()
    expect(result.status).toBe('failed'); expect(result.message).not.toContain('SECRET')
    expect(f.create).toHaveBeenCalledOnce(); expect(f.prompt).not.toHaveBeenCalled()
  })

  it('returns safe receipts for catalog, ready, and navigation errors', async () => {
    for (const stage of ['catalog', 'ready', 'open']) {
      const f = fixture()
      if (stage === 'catalog') f.getContext.mockRejectedValue(new Error('SECRET'))
      if (stage === 'ready') f.ready.mockRejectedValue(new Error('SECRET'))
      if (stage === 'open') f.openSession.mockRejectedValue(new Error('SECRET'))
      const result = await f.execute(stage === 'open' ? open : start)
      expect(result.status).toBe('failed'); expect(result.message).not.toContain('SECRET')
      expect(f.prompt).not.toHaveBeenCalled()
      if (stage === 'ready') expect(result.sessionId).toBe('created')
    }
  })
})
