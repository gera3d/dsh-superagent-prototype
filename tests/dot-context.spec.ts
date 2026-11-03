import { expect, it, vi } from 'vitest'
import { dotContext } from '../src/client/dot-context.ts'

it('reads projects including empty workspaces, thread titles and pending questions without opening or prompting Sessions', async () => {
  const create = vi.fn(), prompt = vi.fn(), retain = vi.fn()
  const sessions = { create, prompt, retain, list: { getSnapshot: () => ({ phase: 'ready', ids: ['idle', 'busy', 'blank'], byId: {
    idle: { id: 'idle', title: 'Older task', cwd: '/project', running: false, blank: false, updatedAt: 100 },
    busy: { id: 'busy', title: 'Active task', cwd: '/project', running: true, blank: false, updatedAt: 50 },
    blank: { id: 'blank', cwd: '/empty', running: false, blank: true, updatedAt: 200 },
  }, projectionsBySession: { busy: { values: { userQuestions: { active: [{ callId: 'q' }] } } } } }) } }
  const context = await dotContext(sessions as never, { list: { getSnapshot: () => ({ items: [
    { workspaceId: 'project', title: 'My Project', path: '/project', sessionIds: ['busy', 'idle'] },
    { workspaceId: 'empty', title: 'Empty Project', path: '/empty', sessionIds: ['blank'] },
  ] }) } })
  expect(context.projects).toHaveLength(2)
  expect(context.threads.map(t => t.id)).toEqual(['busy', 'idle'])
  expect(context.threads[0]).toMatchObject({ title: 'Active task', projectId: 'project', running: true, waiting: 1 })
  expect(create).not.toHaveBeenCalled(); expect(prompt).not.toHaveBeenCalled(); expect(retain).not.toHaveBeenCalled()
})

it('derives projects from cwd when the optional workspace service is absent', async () => {
  const context = await dotContext({ list: { getSnapshot: () => ({ phase: 'ready', ids: ['a', 'b'], byId: {
    a: { displayTitle: 'Task A', cwd: '/work/app', updatedAt: 100 }, b: { displayTitle: 'Task B', cwd: '/work/app', updatedAt: 50 },
  } }) } } as never)
  expect(context.projects).toEqual([{ id: 'cwd:/work/app', title: 'app', path: '/work/app' }])
  expect(context.threads[0]).toMatchObject({ title: 'Task A', projectId: 'cwd:/work/app', waiting: 0 })
})

it('refreshes a pending catalog once and reports unavailable context honestly', async () => {
  const refresh = vi.fn(async () => {})
  await expect(dotContext({ refresh, list: { getSnapshot: () => ({ phase: 'pending' }) } } as never)).rejects.toThrow('not ready')
  expect(refresh).toHaveBeenCalledOnce()
})
