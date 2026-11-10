/** DOM rendering and interaction helpers for panel tests. */
import { performance } from 'node:perf_hooks'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect } from 'vitest'
import { App } from '../../src/client/app.tsx'
import { usePageForm } from '../../src/client/deployment.tsx'
import { zh } from '../../src/client/locales.ts'
import type { T } from '../../src/client/text.ts'
import { server, usePanelServer } from './panel-server.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
/** Fixture project and thread catalog (not a real DSH workspace); Sections tests pick from it. */
export const PROJECT_CONTEXT = { projects: [{ id: 'ws-1', title: 'Fixture project', path: '/fixture/project' }],
  threads: [{ id: 'session-1', title: 'Fixture planning thread', projectId: 'ws-1', running: false, waiting: 0, updatedAt: 0 }] }
const projectContext = async () => PROJECT_CONTEXT
function Panel({ t }: { t: T }) {
  return <App t={t} openSession={async id => { server.opened.push(id) }} deploymentForm={usePageForm(server.form)} projectContext={projectContext} />
}
let root: Root | undefined
let container: HTMLElement | undefined
function unmount() {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
}
export const usePanel = () => usePanelServer(unmount)

/** Flush responses and React updates using a real event-loop turn, even when the panel's polling clock is frozen. */
export async function settle() {
  // vi.waitFor advances fake timers even on its first check. Keep the existing 1s response budget on a real clock.
  const deadline = performance.now() + 1000
  do {
    await act(async () => { await setImmediate() })
    if (server.pending === 0) break
    await setTimeout(10)
  } while (performance.now() < deadline)
  expect(server.pending).toBe(0)
  await act(async () => { await setImmediate() })
}
export async function mount(dictionary: Record<string, string> = zh) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<Panel t={translator(dictionary)} />) })
  await settle()
}
export async function remount(dictionary: Record<string, string> = zh) { unmount(); await mount(dictionary) }

export const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const CONTROLS = 'button, [role="button"], [role="tab"], [role="switch"], a'
export function find(name: string, selector = CONTROLS): HTMLElement {
  const match = all(selector).find(element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name)
  if (!match) throw new Error(`No ${selector} named ${name}`)
  return match
}
export const tab = (name: string) => find(name, '[role="tab"]')
export async function click(target: string | HTMLElement) {
  const element = typeof target === 'string' ? find(target) : target
  await act(async () => { element.click() })
  await settle()
}
export async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  await settle()
}
/** The page's text without its stylesheet. */
export const text = () => [...document.body.querySelectorAll('style')].reduce((all, style) => all.replace(style.textContent ?? '', ''),
  document.body.textContent ?? '')
export function field<E extends HTMLElement>(label: string): E {
  const labelled = (element: HTMLElement) => !!element.id && all('label').some(item => (item as HTMLLabelElement).htmlFor === element.id
    && item.textContent === label)
  const match = all('input, textarea, select').find(element => element.getAttribute('aria-label') === label || labelled(element))
  if (!match) throw new Error(`No field ${label}`)
  return match as unknown as E
}
export const at = (route: object) => sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route, stack: [] }))
