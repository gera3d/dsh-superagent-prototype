import { expect, it } from 'vitest'
import { publicationProcessIdentity, publicationProcessState } from '../src/app/publication-process.ts'
it('observes a stable read-only OS start identity for the current process', () => {
  const identity = publicationProcessIdentity(process.pid)
  expect(identity).toBeTruthy()
  expect(publicationProcessIdentity(process.pid)).toBe(identity)
  expect(publicationProcessState(process.pid, identity)).toBe('same')
})
it('distinguishes recycled PID from original owner and fails closed on unknown identity', () => {
  expect(publicationProcessState(123, 'original', () => 'replacement', () => true)).toBe('different')
  expect(publicationProcessState(123, 'original', () => undefined, () => true)).toBe('unknown')
  expect(publicationProcessState(123, undefined, () => 'original', () => true)).toBe('unknown')
  expect(publicationProcessState(123, 'original', () => 'original', () => false)).toBe('absent')
})
