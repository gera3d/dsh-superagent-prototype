// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { DecisionCard } from '../src/client/decision-card.tsx'
import type { DecisionChoice, DecisionEvaluationResult } from '../src/core/decision.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
usePanel()

it('navigates to the Characters section in Settings beside Eval and Execution', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // Verify navigation buttons in settings include Sources, Eval, Execution, Characters, Prompts, Deployment
  const navLinks = all('.dt-settings-link').map(link => link.textContent)
  expect(navLinks).toContain(zh['settingsGroup.source'])
  expect(navLinks).toContain(zh['settingsGroup.eval'])
  expect(navLinks).toContain(zh['settingsGroup.execution'])
  expect(navLinks).toContain(zh['settingsGroup.characters'])
  expect(navLinks).toContain(zh['settingsGroup.prompts'])

  // Click Characters settings link
  await click(find(zh['settingsGroup.characters'], '.dt-settings-link'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.characters'])
  expect(document.querySelector('.dt-settings-title')?.textContent).toBe(zh['settingsGroup.characters'])

  // Verify Characters list block is rendered with Senior Developer
  expect(text()).toContain('Senior Developer')
  expect(text()).toContain('Code Quality, Reliability & Regression Guard')
  expect(text()).toContain(zh['characterMode.suggest'])

  // Verify Decisions Ranker section is rendered
  expect(text()).toContain(zh.decisionsRanker)
  expect(text()).toContain(zh.decisionsApiKeyEnv)

  // Verify Locked Escalation Boundaries section is rendered and contains all categories
  expect(text()).toContain(zh.lockedEscalationTitle)
  expect(text()).toContain('Financial actions & billing')
  expect(text()).toContain('Destructive modifications & deletions')
  expect(text()).toContain('Secrets & credentials access')
  expect(text()).toContain('Identity impersonation & external broadcast')
  expect(text()).toContain('Genuinely undecided tradeoffs')
})

it('renders decision cards with character attribution, why answered, correction callout, and quick override', async () => {
  const choices: DecisionChoice[] = [
    { id: 'run_tests', label: 'Run regression tests first' },
    { id: 'merge_now', label: 'Merge without running tests' },
  ]
  const recommendation: DecisionEvaluationResult = {
    recommendedValue: 'run_tests',
    confidence: 0.95,
    rationale: 'Untested pull request risks regressing live endpoints.',
    distribution: [
      { id: 'run_tests', probability: 0.95 },
      { id: 'merge_now', probability: 0.05 },
    ],
    provider: 'openai-luna',
    latencyMs: 120,
  }

  const domContainer = document.createElement('div')
  const root = createRoot(domContainer)
  const onOverride = vi.fn()
  await act(async () => {
    root.render(
      <DecisionCard
        title="How to proceed with PR #79?"
        recommendation={recommendation}
        choices={choices}
        onOverrideCharacter={onOverride}
        character={{
          characterId: 'senior-developer',
          name: 'Senior Developer',
          specialty: 'Code Quality & Testing',
          mode: 'suggest',
          rationale: 'Pushes back on untested code; insists on regression tests before merge.',
          correction: 'Weak proposal amended: requires passing vitest run before merge approval.',
        }}
      />,
    )
  })

  // Verify character attribution
  expect(domContainer.textContent).toContain('Senior Developer')
  expect(domContainer.textContent).toContain('Code Quality & Testing')
  expect(domContainer.textContent).toContain('Suggest only')

  // Verify why answered and correction callout
  expect(domContainer.textContent).toContain('Why answered:')
  expect(domContainer.textContent).toContain('Pushes back on untested code')
  expect(domContainer.textContent).toContain('Correction visible:')
  expect(domContainer.textContent).toContain('Weak proposal amended: requires passing vitest run before merge approval.')

  // Verify Quick override button exists and toggles selector
  const overrideBtn = [...domContainer.querySelectorAll('button')].find(btn => btn.textContent?.includes('Quick override'))
  expect(overrideBtn).toBeDefined()
  await act(async () => {
    overrideBtn!.click()
  })

  expect(domContainer.textContent).toContain('Character:')
  expect(domContainer.textContent).toContain('Mode:')

  act(() => {
    root.unmount()
  })
})
