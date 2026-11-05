// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DecisionCard } from '../src/client/decision-card.tsx'
import type { DecisionEvaluationResult } from '../src/core/decision.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const recommendation: DecisionEvaluationResult = { recommendedValue: 'review', confidence: 0.7,
  rationale: 'Review first because deployment is hard to reverse.', distribution: [], provider: 'Configured model', latencyMs: 1 }
const choices = [{ id: 'review', label: 'Review changes', description: 'Slower, but reduces risk.', prompt: 'Please review the pending changes before deployment.' }, { id: 'deploy', label: 'Deploy now' }]
const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { act(() => root?.unmount()); root = undefined; container.replaceChildren(); vi.restoreAllMocks() })
async function render(props: Partial<Parameters<typeof DecisionCard>[0]> = {}) {
  if (root) {
    act(() => root?.unmount())
    container.replaceChildren()
  }
  root = createRoot(container)
  await act(async () => { root!.render(<DecisionCard title="Should we deploy?" context="The change is ready for review, but has not been deployed." recommendation={recommendation} choices={choices} {...props} />) })
}

it('shows the actual question, source context, explicit recommendation and tradeoff', async () => {
  await render()
  expect(container.textContent).toContain('Should we deploy?')
  expect(container.querySelector('[aria-label="Source context"]')?.textContent).toContain('has not been deployed')
  expect(container.querySelector('[aria-label="Recommendation"]')?.textContent).toContain('Recommended: Review changes')
  expect(container.textContent).toContain(recommendation.rationale)
  expect(container.textContent).toContain('Evaluator: Configured model')
  expect(container.textContent).toContain('Slower, but reduces risk.')
  expect(container.textContent).toContain('Preview response')
})

it('retains full long context behind an accessible disclosure', async () => {
  const context = 'Context '.repeat(200) + 'Important final constraint.'
  await render({ context })
  expect(container.querySelector('[aria-label="Source context"] details')?.textContent).toContain(context)
  expect(container.textContent).toContain('Read full source context')
})

it('reports missing context and unavailable evaluation rather than inventing a pick', async () => {
  await render({ context: '', recommendation: { ...recommendation, recommendedValue: '' }, unavailableReason: 'Advisor is still generating.' })
  expect(container.textContent).toContain('No source context was saved')
  expect(container.textContent).toContain('No recommendation yet')
  expect(container.textContent).toContain('Advisor is still generating.')
  expect(container.textContent).not.toContain('Recommended:')
})

it('requests evaluation explicitly, with no selection side effect, and surfaces failure', async () => {
  const onExecute = vi.fn()
  const onEvaluate = vi.fn().mockRejectedValue(new Error('Evaluator offline; nothing changed.'))
  await render({ recommendation: { ...recommendation, recommendedValue: '' }, onExecute, onEvaluate })
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Get recommendation')!
  await act(async () => { button.click() })
  expect(onEvaluate).toHaveBeenCalledOnce()
  expect(onExecute).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Evaluator offline')
})

it('marks completion, disables choices and refresh, and resets locally for another choice', async () => {
  const onExecute = vi.fn().mockResolvedValue(undefined)
  const onEvaluate = vi.fn().mockResolvedValue(undefined)
  await render({ onExecute, onEvaluate })
  const buttons = () => [...container.querySelectorAll('button')]
  await act(async () => { buttons().find(button => button.textContent === 'Choose')!.click() })
  expect(container.querySelector('.dt-decision-card')?.getAttribute('data-state')).toBe('completed')
  expect(container.querySelector('[data-chosen="true"]')?.textContent).toContain('Review changes')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('does not confirm execution')
  const disabled = buttons().filter(button => button.textContent !== 'Start new decision')
  expect(disabled).toHaveLength(3)
  expect(disabled.every(button => button.disabled)).toBe(true)
  await act(async () => { disabled.forEach(button => button.click()) })
  expect(onExecute).toHaveBeenCalledOnce()
  expect(onEvaluate).not.toHaveBeenCalled()
  await act(async () => { buttons().find(button => button.textContent === 'Start new decision')!.click() })
  expect(onExecute).toHaveBeenCalledOnce()
  expect(container.querySelector('.dt-decision-card')?.getAttribute('data-state')).toBe('pending')
  expect(container.querySelector('[data-chosen="true"]')).toBeNull()
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(buttons().every(button => !button.disabled)).toBe(true)
  await act(async () => { buttons().find(button => button.textContent === 'Refresh')!.click() })
  expect(onEvaluate).toHaveBeenCalledOnce()
  await act(async () => { buttons().filter(button => button.textContent === 'Choose')[1]!.click() })
  expect(onExecute).toHaveBeenLastCalledWith('deploy')
})

it('does not complete after a rejected or declined choice', async () => {
  const onExecute = vi.fn().mockRejectedValueOnce(new Error('Not saved')).mockResolvedValue(false)
  await render({ onExecute })
  const button = container.querySelector('button')!
  await act(async () => { button.click() })
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Not saved')
  expect(button.disabled).toBe(false)
  await act(async () => { button.click() })
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.querySelector('.dt-decision-card')?.getAttribute('data-state')).toBe('pending')
})

it('keeps historical alternatives inspectable without action buttons', async () => {
  await render()
  expect(container.textContent).toContain('Deploy now')
  expect(container.querySelector('button')).toBeNull()
})

it('shows percentages consistently on scored cards and plain Not scored labels on unscored cards', async () => {
  // 1. Scored card
  await render({
    recommendation: {
      recommendedValue: 'review',
      confidence: 0.85,
      rationale: 'Ranked best.',
      distribution: [
        { id: 'review', probability: 0.85 },
        { id: 'deploy', probability: 0.15 },
      ],
      provider: 'OpenAI Decisions API',
      latencyMs: 10,
    },
  })
  expect(container.textContent).toContain('85%')
  expect(container.textContent).toContain('15%')
  expect(container.textContent).not.toContain('Not scored')

  // 2. Unscored card
  await render({
    recommendation: {
      recommendedValue: '',
      confidence: 0,
      rationale: 'Not evaluated.',
      distribution: [],
      provider: 'Not evaluated',
      latencyMs: 0,
    },
  })
  const notScoredBadges = container.querySelectorAll('.dt-badge--not-scored')
  expect(notScoredBadges.length).toBe(2)
  expect(container.textContent).toContain('Not scored')
  expect(container.textContent).not.toContain('%')
})

it('renders "Not scored" badge on unscored card and never displays 0%', async () => {
  await render({
    recommendation: {
      recommendedValue: '',
      confidence: 0,
      rationale: 'Unscored alternatives.',
      distribution: [],
      provider: 'Not evaluated',
      latencyMs: 0,
    },
  })
  const notScoredBadges = container.querySelectorAll('.dt-badge--not-scored')
  expect(notScoredBadges.length).toBe(2)
  expect(container.textContent).toContain('Not scored')
  expect(container.textContent).not.toContain('%')
})
