/** Isolated fixture entry for Sections screenshots: the real App against a stubbed fetch with invented data. Not native or live acceptance. */
import { createRoot } from 'react-dom/client'
import { App } from '../../src/client/app.tsx'
import { zh } from '../../src/client/locales.ts'
import { SettingsSchema } from '../../src/policy.ts'

const g = globalThis as unknown as { __page?: string; __section?: string }
const task = (id: string, title: string, stage: string, extra = {}) => ({ id, title, state: 'open', stage, threads: [], undelivered: 0, updatedAt: '2026-11-10T08:00:00Z',
  actions: { retry: false, stop: false }, ...extra })
const progress = (over = {}) => ({ total: 3, working: 1, person: 1, idle: 0, ended: 1, unknown: 0, percent: 33, ...over })
const sections = { project: 'fixture', structure: 'approved', totals: progress({ total: 5, ended: 2, percent: 40 }),
  unassigned: { total: 1, items: [task('x', 'Fixture: tidy release notes', 'working')] },
  sections: [
    { id: 'sec_1', project: 'fixture', position: 0, name: 'Front door', icon: { name: 'door-open', glyph: '🚪', color: '#38bdf8' }, goal: 'Fixture goal: people can reach the product in one step.',
      baseThread: 'fixture-base', createdAt: '', updatedAt: '', progress: progress(), tasks: [
        { kind: 'ticket', id: 'a', stage: 'ended', ticket: task('a', 'Fixture: first-run screen', 'ended') },
        { kind: 'ticket', id: 'b', stage: 'working', ticket: task('b', 'Fixture: sign-in link', 'working') },
        { kind: 'ticket', id: 'c', stage: 'person', ticket: task('c', 'Fixture: copy needs a decision', 'person', { action: 'review' }) }] },
    { id: 'sec_2', project: 'fixture', position: 1, name: 'Autopilot', icon: { name: 'zap', glyph: '⚡', color: '#fbbf24' }, goal: '', baseThread: undefined, createdAt: '', updatedAt: '',
      progress: progress({ total: 2, working: 0, person: 0, ended: 1, percent: 50 }), tasks: [
        { kind: 'ticket', id: 'd', stage: 'ended', ticket: task('d', 'Fixture: schedule rules', 'ended') },
        { kind: 'session', id: 'fixture-chat', stage: 'unknown' }] },
    { id: 'sec_3', project: 'fixture', position: 2, name: 'Acceptance', icon: { name: 'flask', glyph: '🧪', color: '#a3e635' }, goal: '', createdAt: '', updatedAt: '',
      progress: progress({ total: 0, working: 0, person: 0, ended: 0, percent: 0 }), tasks: [] }] }
window.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url, 'http://x').pathname.replace('/orchestrator/api/', '')
  if (path === 'overview') return Response.json({ problems: [], person: [], executor: { running: 1, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, policyVersion: 'v' })
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0, maxWorkers: 3 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  if (path === 'sections') return Response.json(sections)
  if (path.endsWith('press-forward') && init?.method === 'POST') return Response.json({ action: 'press-forward', state: 'preview', execution_authorized: false, section: 'sec_1', retryable: [], waitingOnPerson: [], running: 1,
    note: 'Preview only. Advancing a task stays with its own ticket controls and approval gates; no task was started, retried or messaged.' })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}) as typeof fetch
const route = g.__page === 'sections' ? { page: 'sections', query: { project: 'fixture', ...g.__section ? { section: g.__section } : {} } } : { page: 'overview' }
sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route, stack: [] }))
const project = async () => ({ projects: [{ id: 'fixture', title: 'Fixture project', path: '/fixture' }],
  threads: [{ id: 'fixture-base', title: 'Fixture base thread', projectId: 'fixture', running: false, waiting: 0, updatedAt: 0 }] })
const t = ((key: keyof typeof zh, values?: Record<string, unknown>) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_m, n: string) => String(values?.[n] ?? ''))) as never
createRoot(document.getElementById('root')!).render(<App t={t} openSession={async () => {}} deploymentForm={{} as never} projectContext={project} />)
