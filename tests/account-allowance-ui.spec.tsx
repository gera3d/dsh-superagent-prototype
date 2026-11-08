// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AllowanceHeaderBadge,
  AllowanceSidebarBody,
  ProviderAllowanceCard,
  QuotaWindowRow,
  ALLOWANCE_TAB_KIND,
  type AllowanceClientContext,
} from '../src/client/account-allowance.tsx'
import type { AccountAllowanceReport, ProviderAllowance } from '../src/app/account-allowance.ts'
import { en } from '../src/client/locales.ts'
import type { T } from '../src/client/text.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const t = ((k: string, p?: Record<string, unknown>) => {
  let s = (en as Record<string, string>)[k] ?? k
  if (p) {
    for (const [pk, pv] of Object.entries(p)) s = s.replace(`{${pk}}`, String(pv))
  }
  return s
}) as T

const sampleReport: AccountAllowanceReport = {
  accountId: 'acc_primary',
  accountAlias: 'Primary Account',
  accountEmail: 'operator@example.com',
  isPrimary: true,
  source: 'antigravity',
  sourceLabel: 'Google Antigravity',
  updatedAt: 1794161036386,
  stale: false,
  providers: [
    {
      provider: 'google',
      family: 'google',
      source: 'antigravity',
      label: 'Google (Gemini)',
      accountProvenance: 'Google Antigravity (operator@example.com)',
      status: 'available',
      rollingWindow: { fraction: 0.69, resetTime: '2026-11-08T20:25:42Z' },
      weeklyWindow: { fraction: 0.87, resetTime: '2026-11-14T22:42:10Z' },
      description: 'Gemini Flash and Pro models',
      stale: false,
    },
    {
      provider: 'antigravity-claude',
      family: 'anthropic',
      source: 'antigravity',
      label: 'Antigravity Claude',
      accountProvenance: 'Google Antigravity model pool (multi-model quota)',
      status: 'available',
      rollingWindow: { fraction: 1.0, resetTime: '2026-11-08T23:03:56Z' },
      weeklyWindow: { fraction: 0.50, resetTime: '2026-11-12T16:11:42Z' },
      description: 'Claude 3.7 / 3.5 models',
      stale: false,
    },
    {
      provider: 'anthropic-direct',
      family: 'anthropic',
      source: 'direct',
      label: 'Anthropic (Direct)',
      accountProvenance: 'Direct Anthropic subscription / API',
      status: 'unavailable',
      description: 'No local authenticated quota reader configured for direct Anthropic subscription',
      stale: false,
    },
  ],
}

let root: ReturnType<typeof createRoot> | undefined
const container = document.createElement('div')

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.replaceChildren()
  vi.unstubAllGlobals()
})

describe('AllowanceHeaderBadge', () => {
  it('renders compact Google, Antigravity Claude, and Direct Anthropic percentages beside chat', async () => {
    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceHeaderBadge report={sampleReport} t={t} />)
    })

    const button = container.querySelector('.dt-allowance-header-badge') as HTMLButtonElement
    expect(button).toBeDefined()
    expect(button.textContent).toContain('G')
    expect(button.textContent).toContain('69%')
    expect(button.textContent).toContain('AC')
    expect(button.textContent).toContain('100%')
    expect(button.textContent).toContain('A')
    expect(button.textContent).toContain('--')
    expect(button.getAttribute('aria-label')).toContain('Google 69%, Antigravity Claude 100%, Anthropic (Direct) Unavailable')
    expect(button.getAttribute('data-warning')).toBeNull()
  })

  it('indicates warning state when a provider is in cooldown', async () => {
    const cooldownReport: AccountAllowanceReport = {
      ...sampleReport,
      providers: [
        sampleReport.providers[0]!,
        {
          ...sampleReport.providers[1]!,
          status: 'cooldown',
          cooldownUntil: Date.now() + 300_000,
          rollingWindow: { fraction: 0.05, resetTime: '2026-11-08T23:00:00Z' },
        },
        sampleReport.providers[2]!,
      ],
    }

    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceHeaderBadge report={cooldownReport} t={t} />)
    })

    const button = container.querySelector('.dt-allowance-header-badge') as HTMLButtonElement
    expect(button.getAttribute('data-warning')).toBe('true')
  })

  it('opens Right Sidebar tab when clicked with sidebarRight context', async () => {
    const openTab = vi.fn()
    const ctx = {
      sidebarRight: {
        openTab,
        isExpanded: () => true,
        toggleExpanded: vi.fn(),
      },
    } as unknown as AllowanceClientContext

    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceHeaderBadge ctx={ctx} report={sampleReport} t={t} />)
    })

    const button = container.querySelector('.dt-allowance-header-badge') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    expect(openTab).toHaveBeenCalledWith(ALLOWANCE_TAB_KIND)
  })

  it('toggles fallback popover when clicked without sidebarRight context', async () => {
    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceHeaderBadge report={sampleReport} t={t} />)
    })

    expect(container.querySelector('.dt-allowance-inline-popover')).toBeNull()

    const button = container.querySelector('.dt-allowance-header-badge') as HTMLButtonElement
    await act(async () => {
      button.click()
    })

    expect(container.querySelector('.dt-allowance-inline-popover')).not.toBeNull()
  })
})

describe('AllowanceSidebarBody', () => {
  it('renders detailed cards for Google and Anthropic in the right sidebar panel with explicit provenance', async () => {
    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceSidebarBody report={sampleReport} t={t} />)
    })

    expect(container.textContent).toContain('Account Allowance')
    expect(container.textContent).toContain('operator@example.com')
    expect(container.textContent).toContain('Primary')
    expect(container.textContent).toContain('Google Antigravity')
    expect(container.textContent).toContain('Google (Gemini)')
    expect(container.textContent).toContain('Antigravity Claude')
    expect(container.textContent).toContain('Anthropic (Direct)')
    expect(container.textContent).toContain('Unavailable')
    expect(container.textContent).toContain('Rolling 5h window')
    expect(container.textContent).toContain('Weekly window')

    // Provenance labels
    expect(container.textContent).toContain('Google Antigravity (operator@example.com)')
    expect(container.textContent).toContain('Google Antigravity model pool (multi-model quota)')
    expect(container.textContent).toContain('Direct Anthropic subscription / API')

    // Progressbars: 2 providers with active quotas x 2 windows = 4 bars
    const bars = container.querySelectorAll('.dt-allowance-bar-track')
    expect(bars.length).toBe(6) // 3 cards x 2 window rows
    expect(bars[0]?.getAttribute('aria-valuenow')).toBe('69')
    expect(bars[1]?.getAttribute('aria-valuenow')).toBe('87')
    expect(bars[2]?.getAttribute('aria-valuenow')).toBe('100')
    expect(bars[3]?.getAttribute('aria-valuenow')).toBe('50')
    // Direct Anthropic has undefined fractions
    expect(bars[4]?.getAttribute('aria-valuenow')).toBeNull()
    expect(bars[5]?.getAttribute('aria-valuenow')).toBeNull()

    // Local subscription note
    expect(container.textContent).toContain('Authenticated local Antigravity subscription pool')
  })

  it('displays empty state when account is missing', async () => {
    const emptyReport: AccountAllowanceReport = {
      accountId: '',
      accountAlias: 'Empty',
      isPrimary: false,
      source: 'antigravity',
      sourceLabel: 'Google Antigravity',
      providers: [],
      stale: true,
      problem: 'account_missing',
    }

    root = createRoot(container)
    await act(async () => {
      root!.render(<AllowanceSidebarBody report={emptyReport} t={t} />)
    })

    expect(container.textContent).toContain('No Antigravity subscription accounts configured')
  })
})

describe('QuotaWindowRow & ProviderAllowanceCard', () => {
  it('never turns missing fraction into 0% in the gauge row', async () => {
    root = createRoot(container)
    await act(async () => {
      root!.render(<QuotaWindowRow title="Missing Rolling" window={{ resetTime: '2026-11-08T22:00:00Z' }} t={t} />)
    })

    expect(container.querySelector('.dt-allowance-window-percent')?.textContent).toBe('--')
    const bar = container.querySelector('.dt-allowance-bar-track')
    expect(bar?.getAttribute('aria-valuenow')).toBeNull()
    const fill = container.querySelector('.dt-allowance-bar-fill') as HTMLElement
    expect(fill.style.width).toBe('0%')
  })

  it('renders warn and danger tone on critical allowance levels', async () => {
    const lowAllowance: ProviderAllowance = {
      provider: 'google',
      family: 'google',
      source: 'antigravity',
      label: 'Google (Gemini)',
      accountProvenance: 'Google Antigravity',
      status: 'available',
      rollingWindow: { fraction: 0.08, resetTime: '2026-11-08T22:00:00Z' },
      weeklyWindow: { fraction: 0.22, resetTime: '2026-11-14T22:00:00Z' },
      stale: false,
    }

    root = createRoot(container)
    await act(async () => {
      root!.render(<ProviderAllowanceCard allowance={lowAllowance} t={t} />)
    })

    const windows = container.querySelectorAll('.dt-allowance-window')
    expect(windows[0]?.getAttribute('data-tone')).toBe('danger') // 8% <= 10%
    expect(windows[1]?.getAttribute('data-tone')).toBe('warn') // 22% <= 25%
  })
})
