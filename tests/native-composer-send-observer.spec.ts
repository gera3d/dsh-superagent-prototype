import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

// Opt-in contract test of the installed browser artifact, not a simulated phase transition.
const bundle = process.env.DSH_NATIVE_COMPOSER_BUNDLE
it.skipIf(!bundle)('native Send publishes an immutable scoped snapshot before clear and retains analytics', () => {
  const source = readFileSync(bundle!, 'utf8')
  const start = source.indexOf('observeSubmissions(observer) {')
  const end = source.indexOf('/** Settle one detached default send', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const Host = new Function(`return class { ${source.slice(start, end)} }`)()
  const host = new Host()
  host.snapshot = { phase: 'plain', draft: 'report-only draft', draftRev: 3, attachmentIds: ['image'], occurrences: [{ ref: 'file' }] }
  host.deps = { messageSubmitted: vi.fn() }; host.notify = vi.fn()
  const observer = vi.fn(), off = host.observeSubmissions(observer)
  host.notifySubmission({ timestamp: 17, source: 'click' })
  const occurrence = observer.mock.calls[0]![0]
  expect(occurrence).toMatchObject({ source: 'click', timestamp: 17, input: { draft: 'report-only draft', phase: 'plain' } })
  expect(Object.isFrozen(occurrence.input)).toBe(true)
  expect(Object.isFrozen(occurrence.input.attachmentIds)).toBe(true)
  host.snapshot.attachmentIds.push('later-image')
  expect(occurrence.input.attachmentIds).toEqual(['image'])
  expect(host.deps.messageSubmitted).toHaveBeenCalledOnce()
  off(); host.notifySubmission({ timestamp: 18, source: 'enter' }); expect(observer).toHaveBeenCalledOnce()
  const sink = source.slice(source.indexOf('sinkSerialized(attempt, draft, mode) {'), source.indexOf('observeSubmissions(observer) {'))
  expect(sink.indexOf('this.notifySubmission(attempt.submission)')).toBeLessThan(sink.indexOf('this.deps.defaultSink'))
  expect(sink.indexOf('this.notifySubmission(attempt.submission)')).toBeLessThan(sink.indexOf('Promise.all(occurrences.map'))
})
