// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LifecycleCard } from '../src/client/lifecycle-card.tsx'
import type { PendingDecisionItem } from '../src/core/decision.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const item: PendingDecisionItem = { id: 'life-demo', ticketId: 't1', ticketTitle: 'Public example', trigger: 'Ready', status: 'pending', urgency: 'low', createdAt: 1,
  question: 'Ready', context: 'Ready for review', actionMode: 'ticket_lifecycle', lifecycle: { kind: 'done', assignmentId: 'a1', prNumber: 150, docsOnly: false },
  choices: [{ id: 'try_it', label: 'Try it' }, { id: 'changes_needed', label: 'Changes needed' }],
  recommendation: { recommendedValue: '', confidence: 0, rationale: '', distribution: [], provider: '', latencyMs: 0 } }
let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')
afterEach(() => { act(() => root?.unmount()); root = undefined; container.replaceChildren() })
async function render(props: Partial<Parameters<typeof LifecycleCard>[0]> = {}) {
  root = createRoot(container)
  const onAction = vi.fn().mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'No action executed.', url: 'https://github.com/example/project/pull/150/files' })
  const onTicket = vi.fn()
  await act(async () => { root!.render(<LifecycleCard item={item} onAction={onAction} onTicket={onTicket} {...props} />) })
  return { onAction, onTicket }
}
it('is quiet, requires Try it first for unverified/code changes, and has no model/advisor controls', async () => {
  await render()
  expect(container.textContent).toContain('Try it first')
  expect(container.textContent).toContain('Nothing is applied or restarted')
  expect(container.textContent).not.toContain('Get recommendation')
  expect(container.textContent).not.toContain('Not scored')
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['View ticket', 'Try it', 'Changes needed'])
})
it('uses an explicit action and renders a safe human review link without executing chat', async () => {
  const { onAction, onTicket } = await render()
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Try it')!.click() })
  expect(onAction).toHaveBeenCalledWith('try_it')
  expect(onTicket).not.toHaveBeenCalled()
  expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('No action executed')
})
it('opens feedback in the ticket only after server validation and surfaces stale conflicts', async () => {
  const onTicket = vi.fn(), onAction = vi.fn().mockRejectedValueOnce(new Error('Ticket state changed')).mockResolvedValue({ execution: 'not_executed', ticketId: 't1', message: 'No message sent.' })
  await render({ onTicket, onAction })
  const changes = [...container.querySelectorAll('button')].find(button => button.textContent === 'Changes needed')!
  await act(async () => { changes.click() })
  expect(onTicket).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Ticket state changed')
  await act(async () => { changes.click() })
  expect(onTicket).toHaveBeenCalledOnce()
})
it('shows only Retry and Open issue for stuck cards and disables successful retries', async () => {
  const stuck = { ...item, lifecycle: { kind: 'stuck' as const, assignmentId: 'a1', issueUrl: 'https://github.com/example/project/issues/143' }, choices: [{ id: 'retry', label: 'Retry' }, { id: 'open_issue', label: 'Open issue' }] }
  const onAction = vi.fn().mockResolvedValue({ execution: 'retried', ticketId: 't1', message: 'Fresh assignment requested.' })
  await render({ item: stuck, onAction })
  expect(container.querySelector('a')?.getAttribute('href')).toBe(stuck.lifecycle.issueUrl)
  expect(container.querySelector('a')?.textContent).toContain('Open issue')
  const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!
  await act(async () => { retry.click() })
  expect(retry.disabled).toBe(true)
  await act(async () => { retry.click() })
  expect(onAction).toHaveBeenCalledOnce()
})
