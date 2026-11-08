// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { SpecialistStatus, statusText } from '../src/client/specialist-status.tsx'
import type { Activity } from '../src/core/specialist-activity.ts'
import { ACTIVITY_STATES, seedProfiles } from '../src/core/specialist-profile.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const css = readFileSync(join(process.cwd(), 'src/client/specialist-status.css'), 'utf8')
const profiles = seedProfiles()
let roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.innerHTML = '' })
function render(activity: Activity, profile = profiles[1]!, note?: string) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(<SpecialistStatus profile={profile} activity={activity} note={note} now={100_000} />))
  return host
}

it('renders every real state with accessible text, a status role and a keyboard stop', () => {
  for (const state of ACTIVITY_STATES) {
    const host = render({ state, stale: false, at: 95_000, reason: 'Because of evidence' })
    const status = host.querySelector('[role="status"]') as HTMLElement
    expect(host.firstElementChild?.getAttribute('data-state')).toBe(state)
    expect(status.getAttribute('aria-label')).toContain('Senior Developer')
    expect(status.getAttribute('aria-label')).toContain('updated 5s ago')
    expect(status.tabIndex).toBe(0)
    expect(host.querySelector('[aria-hidden="true"]')).not.toBeNull() // decorative art is hidden from AT
    act(() => roots.pop()!.unmount()); host.remove()
  }
})

it('shows unknown and stale as non-working, and unsupported states as unknown', () => {
  const stale = render({ state: 'unknown', stale: true, at: 1000, reason: 'Last tools evidence is 99s old; not shown as working' })
  expect(stale.querySelector('.dsa-spec')?.getAttribute('data-state')).toBe('unknown')
  expect(stale.querySelector('.dsa-spec')?.getAttribute('data-stale')).toBe('true')
  expect(stale.textContent).toContain('Status unknown · stale')
  const restricted = render({ state: 'testing', stale: false, at: 99_000, reason: 'x' }, { ...profiles[0]!, activityStates: ['idle'] })
  expect(restricted.querySelector('.dsa-spec')?.getAttribute('data-state')).toBe('unknown')
  expect(restricted.textContent).toContain('Status unknown')
  expect(statusText(profiles[0]!, { state: 'unknown', stale: false, reason: 'No native activity evidence' }, 5)).toBe('Administrator: Status unknown. No native activity evidence.')
})

it('shows the unavailable-capability note as text and swaps in a custom art asset', () => {
  const host = render({ state: 'waiting', stale: false, reason: 'r' }, profiles[2]!, 'Cloudflare capability unavailable: decide whether to connect it.')
  expect(host.querySelector('.dsa-spec__note')?.textContent).toContain('Cloudflare capability unavailable')
  expect(host.querySelector('svg')).not.toBeNull()
  const art = document.createElement('div'); document.body.append(art); const root = createRoot(art); roots.push(root)
  act(() => root.render(<SpecialistStatus profile={profiles[2]!} activity={{ state: 'idle', stale: false, reason: 'r' }} art="/assets/cf.gif" now={1} />))
  expect(art.querySelector('svg')).toBeNull()
  expect((art.querySelector('.dsa-spec__avatar') as HTMLElement).style.backgroundImage).toContain('/assets/cf.gif')
})

it('animates only evidence-backed working states, with a reduced-motion fallback and a compact one-row layout', () => {
  // Working animation selectors all require data-stale="false"; unknown/complete/blocked/idle have none.
  const animated = [...css.matchAll(/\.dsa-spec\[data-state="(\w+)"\](\[data-stale="false"\])? \.dsa-spec__ring \{ [^}]*animation:/g)]
  expect(animated.map(match => match[1]).sort()).toEqual(['investigating', 'testing', 'tools', 'waiting'])
  for (const match of animated.filter(item => item[1] !== 'waiting')) expect(match[2]).toBeTruthy()
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none !important/)
  expect(css).toMatch(/\.dsa-spec \{[^}]*display: inline-flex[^}]*max-width: 100%/)
  expect(css).toMatch(/\.dsa-spec__text:focus-visible \{ outline:/)
  expect(css).toMatch(/@media \(max-width: 420px\) \{ \.dsa-spec__name \{ display: none; \} \}/)
  // Theme tokens, not hard-coded surfaces: no background fills and no fixed sizing beyond the 22px glyph.
  expect(css).not.toMatch(/background(-color)?:\s*#/)
  expect(css).not.toMatch(/position:\s*(fixed|absolute)/)
})

it('turns working evidence into unknown on its own timer without any prop change', async () => {
  const { vi } = await import('vitest')
  vi.useFakeTimers(); vi.setSystemTime(1_000_000 + 1000)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  act(() => root.render(<SpecialistStatus profile={profiles[1]!} activity={{ state: 'investigating', stale: false, at: 1_000_000, reason: 'Turn in progress' }} />))
  expect(host.firstElementChild?.getAttribute('data-state')).toBe('investigating')
  act(() => { vi.setSystemTime(1_000_000 + 91_000); vi.advanceTimersByTime(91_000) })
  expect(host.firstElementChild?.getAttribute('data-state')).toBe('unknown')
  vi.useRealTimers()
})
