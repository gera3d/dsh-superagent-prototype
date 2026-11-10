// @vitest-environment jsdom
/** The Decisions settings section: switching the ranker to Jev through OpenRouter and saving the block. */
import { describe, expect, it } from 'vitest'
import { settingsRoute } from '../src/client/route.ts'
import { zh } from '../src/client/locales.ts'
import { at, click, mount, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Decisions settings', () => {
  usePanel()

  it('lists Decisions among the settings groups', async () => {
    at(settingsRoute('decisions'))
    await mount()
    const links = [...document.querySelectorAll('.dt-settings-link')].map(link => link.textContent)
    expect(links).toContain(zh['settingsGroup.decisions'])
    expect(document.querySelector('[data-testid="decisions-settings"]')).not.toBeNull()
  })

  it('fills in Jev through OpenRouter and saves it without touching the key itself', async () => {
    at(settingsRoute('decisions'))
    await mount()
    await click(document.querySelector('[data-testid="decisions-use-jev"]') as HTMLButtonElement)
    await click(document.querySelector('.dt-savebar button[type="submit"]') as HTMLButtonElement)
    expect(server.settings.decisions).toMatchObject({
      provider: 'typesafe-jev', model: 'typesafe/jev-1.13', endpoint: 'https://openrouter.ai/api/alpha/decisions',
      apiKeyEnv: 'OPENROUTER_API_KEY', timeoutMs: 15000,
    })
  })

  it('saves a hand-typed key variable name', async () => {
    at(settingsRoute('decisions'))
    await mount()
    const input = document.querySelector('input[placeholder="OPENROUTER_API_KEY"]') as HTMLInputElement
    await type(input, 'MY_JEV_KEY')
    await click(document.querySelector('.dt-savebar button[type="submit"]') as HTMLButtonElement)
    expect(server.settings.decisions.apiKeyEnv).toBe('MY_JEV_KEY')
  })
})
