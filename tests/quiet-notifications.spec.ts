import { describe, expect, it, vi } from 'vitest'
import { ExecutorConfigSchema, SettingsSchema } from '../src/policy.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Ticket } from '../src/core/index.ts'

describe('quiet notifications & sound setting', () => {
  it('defaults sound setting to false (silent)', () => {
    const config = ExecutorConfigSchema.parse({})
    expect(config.sound).toBe(false)

    const settings = SettingsSchema.parse({})
    expect(settings.executor.sound).toBe(false)
  })

  it('allows enabling sound explicitly when desired', () => {
    const config = ExecutorConfigSchema.parse({ sound: true })
    expect(config.sound).toBe(true)
  })

  it('orchestrator_report requests silent notification (sound: none) by default', async () => {
    const mockExecFile = vi.fn()
    vi.doMock('node:child_process', () => ({
      execFile: mockExecFile,
    }))

    const ticket: Ticket = {
      id: 'ticket-1',
      title: 'Fix noisy chime',
      decisionId: 'd-1',
      origin: { triggerId: 'tr-1', triggerIds: ['tr-1'] },
      channels: [],
      mandate: {
        actor: { id: 'gera3d', source: 'github' },
        basis: { addressed: 'mention', row: 'issues', scope: { isPr: false, kind: 'issue', number: 120 }, sender: 'gera3d', source: 'github', via: 'addressed' },
        policyVersion: 'v1',
        scope: 'Fix noisy chime',
        strength: 'explicit',
      },
      assignments: [{ id: 'a-1', createdAt: new Date().toISOString(), state: 'running' }],
      inputs: [],
      undelivered: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const ticketsMap = new Map<string, Ticket>([[ticket.id, ticket]])

    const host: ExecutorToolsHost = {
      engine: {
        report: vi.fn((_id, report) => ({ ...ticket, report, attention: undefined } as any)),
        reply: vi.fn(),
        markUnrelated: vi.fn(),
        handback: vi.fn(),
        followForContext: vi.fn(),
      },
      store: {
        tickets: {
          get: (id: string) => ticketsMap.get(id),
          save: (t: Ticket) => { ticketsMap.set(t.id, t) },
          list: () => [...ticketsMap.values()],
        } as any,
        replyStatus: vi.fn(),
        atomic: ((fn: () => any) => fn()) as any,
        settings: () => SettingsSchema.parse({ executor: { sound: false } }),
      },
      sessions: {
        relay: vi.fn(),
        notify: vi.fn(),
      },
      resources: {} as any,
      github: {
        deployment: { github: { login: 'agent' } },
      } as any,
      sendReplies: vi.fn(),
    }

    const tools = executorTools(host, ticket)
    const reportTool = tools.find(t => t.name === 'orchestrator_report')!
    expect(reportTool).toBeDefined()

    await reportTool.execute({
      state: 'ready',
      summary: 'Task verified and complete',
    }, new AbortController().signal)

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const callArgs = mockExecFile.mock.calls[0] as unknown[]
    const cliPath = callArgs[0] as string
    const args = callArgs[1] as string[]
    expect(cliPath).toContain('dsh-notify')
    expect(args).toEqual([
      'SuperAgent Work Ready',
      'Fix noisy chime',
      'none',
    ])
  })

  it('orchestrator_report requests Glass chime when executor.sound is enabled', async () => {
    const mockExecFile = vi.fn()
    vi.doMock('node:child_process', () => ({
      execFile: mockExecFile,
    }))

    const ticket: Ticket = {
      id: 'ticket-2',
      title: 'Sound enabled task',
      decisionId: 'd-2',
      origin: { triggerId: 'tr-2', triggerIds: ['tr-2'] },
      channels: [],
      mandate: {
        actor: { id: 'gera3d', source: 'github' },
        basis: { addressed: 'mention', row: 'issues', scope: { isPr: false, kind: 'issue', number: 121 }, sender: 'gera3d', source: 'github', via: 'addressed' },
        policyVersion: 'v1',
        scope: 'Sound enabled task',
        strength: 'explicit',
      },
      assignments: [{ id: 'a-2', createdAt: new Date().toISOString(), state: 'running' }],
      inputs: [],
      undelivered: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const ticketsMap = new Map<string, Ticket>([[ticket.id, ticket]])

    const host: ExecutorToolsHost = {
      engine: {
        report: vi.fn((_id, report) => ({ ...ticket, report, attention: undefined } as any)),
        reply: vi.fn(),
        markUnrelated: vi.fn(),
        handback: vi.fn(),
        followForContext: vi.fn(),
      },
      store: {
        tickets: {
          get: (id: string) => ticketsMap.get(id),
          save: (t: Ticket) => { ticketsMap.set(t.id, t) },
          list: () => [...ticketsMap.values()],
        } as any,
        replyStatus: vi.fn(),
        atomic: ((fn: () => any) => fn()) as any,
        settings: () => SettingsSchema.parse({ executor: { sound: true } }),
      },
      sessions: {
        relay: vi.fn(),
        notify: vi.fn(),
      },
      resources: {} as any,
      github: {
        deployment: { github: { login: 'agent' } },
      } as any,
      sendReplies: vi.fn(),
    }

    const tools = executorTools(host, ticket)
    const reportTool = tools.find(t => t.name === 'orchestrator_report')!

    await reportTool.execute({
      state: 'ready',
      summary: 'Task verified and complete with sound',
    }, new AbortController().signal)

    expect(mockExecFile).toHaveBeenCalledTimes(1)
    const callArgs = mockExecFile.mock.calls[0] as unknown[]
    const cliPath = callArgs[0] as string
    const args = callArgs[1] as string[]
    expect(cliPath).toContain('dsh-notify')
    expect(args).toEqual([
      'SuperAgent Work Ready',
      'Sound enabled task',
      'Glass',
    ])
  })

  it('orchestrator_report does not trigger dsh-notify for progress reports', async () => {
    const mockExecFile = vi.fn()
    vi.doMock('node:child_process', () => ({
      execFile: mockExecFile,
    }))

    const ticket: Ticket = {
      id: 'ticket-3',
      title: 'In progress task',
      decisionId: 'd-3',
      origin: { triggerId: 'tr-3', triggerIds: ['tr-3'] },
      channels: [],
      mandate: {
        actor: { id: 'gera3d', source: 'github' },
        basis: { addressed: 'mention', row: 'issues', scope: { isPr: false, kind: 'issue', number: 122 }, sender: 'gera3d', source: 'github', via: 'addressed' },
        policyVersion: 'v1',
        scope: 'In progress task',
        strength: 'explicit',
      },
      assignments: [{ id: 'a-3', createdAt: new Date().toISOString(), state: 'running' }],
      inputs: [],
      undelivered: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const ticketsMap = new Map<string, Ticket>([[ticket.id, ticket]])

    const host: ExecutorToolsHost = {
      engine: {
        report: vi.fn((_id, report) => ({ ...ticket, report, attention: undefined } as any)),
        reply: vi.fn(),
        markUnrelated: vi.fn(),
        handback: vi.fn(),
        followForContext: vi.fn(),
      },
      store: {
        tickets: {
          get: (id: string) => ticketsMap.get(id),
          save: (t: Ticket) => { ticketsMap.set(t.id, t) },
          list: () => [...ticketsMap.values()],
        } as any,
        replyStatus: vi.fn(),
        atomic: ((fn: () => any) => fn()) as any,
        settings: () => SettingsSchema.parse({ executor: { sound: true } }),
      },
      sessions: {
        relay: vi.fn(),
        notify: vi.fn(),
      },
      resources: {} as any,
      github: {
        deployment: { github: { login: 'agent' } },
      } as any,
      sendReplies: vi.fn(),
    }

    const tools = executorTools(host, ticket)
    const reportTool = tools.find(t => t.name === 'orchestrator_report')!

    await reportTool.execute({
      state: 'progress',
      summary: 'Still working...',
    }, new AbortController().signal)

    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
