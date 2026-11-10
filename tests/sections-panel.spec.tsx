// @vitest-environment jsdom
// The Sections tab against fixture data only: no real project, ticket or session is read or moved.
import { expect, it } from 'vitest'
import type { ApiResponse } from '../src/app/api.ts'
import { parseRoute, TABS } from '../src/client/route.ts'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text, at } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
const progress = (over: Partial<Record<string, number>> = {}) => ({ total: 2, working: 1, person: 0, idle: 0, ended: 1, unknown: 0, percent: 50, ...over })
/** Fixture views are written by hand, so they are checked against the response type only here. */
const view = (value: unknown) => value as ApiResponse<'GET sections'>
const door = { name: 'door-open', glyph: '🚪', color: '#38bdf8' }
const row = ticketSummary({ id: 't1', title: '修复回归' })
function approved() {
  server.sections = view({ project: 'ws-1', structure: 'approved', unassigned: { total: 1, items: [ticketSummary({ id: 'loose', title: '未分区任务' })] },
    totals: progress(), sections: [
      { id: 'sec_1', project: 'ws-1', position: 0, name: 'Front door', icon: door, goal: 'Let people in', baseThread: 'session-1', createdAt: '', updatedAt: '',
        tasks: [{ kind: 'ticket', id: 't1', stage: 'working', ticket: row }, { kind: 'session', id: 'session-2', stage: 'unknown' }], progress: progress() },
      { id: 'sec_2', project: 'ws-1', position: 1, name: 'Autopilot', icon: { name: 'zap', glyph: '⚡', color: '#fbbf24' }, goal: '', createdAt: '', updatedAt: '',
        tasks: [], progress: progress({ total: 0, working: 0, ended: 0, percent: 0 }) }] })
}

it('parses the sections route and lists the tab', () => {
  expect(TABS).toContain('sections')
  expect(parseRoute({ page: 'sections', query: { project: 'ws-1', section: 'sec_1', junk: 'x' } })).toEqual({ page: 'sections', query: { project: 'ws-1', section: 'sec_1' } })
  expect(parseRoute({ page: 'sections' })).toEqual({ page: 'sections' })
  expect(Object.keys(zh).filter(key => key.startsWith('section')).every(key => key in en)).toBe(true)
})

it('shows the empty state and never offers section structure without a proposal', async () => {
  await mount()
  await click(tab(zh['tab.sections']))
  expect(text()).toContain(zh.sectionsNone)
  expect(all('[data-testid="sections-proposal"]')).toHaveLength(0)
  expect(server.requests.some(request => request.path === 'sections?project=ws-1')).toBe(true)
})

it('shows a pending proposal as inert text with approve and reject only behind a confirmation', async () => {
  server.sections = view({ project: 'ws-1', structure: 'proposed', sections: [], unassigned: { total: 0, items: [] }, totals: progress({ total: 0 }),
    proposal: { id: 'prop_1', project: 'ws-1', status: 'pending', proposedAt: '', sections: [{ name: 'Front door', icon: 'door-open', members: [{ kind: 'ticket', id: 't1' }] }] } })
  await mount()
  await click(tab(zh['tab.sections']))
  expect(text()).toContain('Front door')
  expect(server.requests.filter(request => request.method === 'POST')).toEqual([])
  await click(zh.sectionsApprove)
  // Opening the confirmation sends nothing; the operator must confirm.
  expect(server.requests.filter(request => request.method === 'POST')).toEqual([])
})

it('renders the project overview with icons and progress, then opens a section and its base thread', async () => {
  approved()
  await mount()
  await click(tab(zh['tab.sections']))
  const glyphs = all('.dt-section-glyph')
  expect(glyphs.map(glyph => glyph.dataset.icon)).toEqual(['door-open', 'zap'])
  expect(text()).toContain('Front door')
  expect(text()).toContain(zh.sectionProgress.replace('{done}', '1').replace('{total}', '2'))
  expect(text()).toContain('未分区任务')
  await click(find(zh.sectionBaseThread, 'button'))
  expect(server.opened).toEqual(['session-1'])
  await click('Front door')
  expect(text()).toContain('Let people in')
  expect(text()).toContain('修复回归')
  expect(text()).toContain('session-2')
  // The section route survives a remount.
  await remount()
  expect(text()).toContain('Let people in')
})

it('previews Press forward and Make it better without sending any change to a task', async () => {
  approved()
  at({ page: 'sections', query: { project: 'ws-1', section: 'sec_1' } })
  await mount()
  await click(zh.sectionPressForward)
  expect(all('[data-testid="steering-preview"]')).toHaveLength(1)
  expect(text()).toContain(zh.sectionPreviewOnly)
  const posts = server.requests.filter(request => request.method === 'POST').map(request => request.path)
  expect(posts).toEqual(['sections/sec_1/press-forward'])
  expect(posts.some(path => /tickets|retry|stop|move|approve/.test(path))).toBe(false)
})
