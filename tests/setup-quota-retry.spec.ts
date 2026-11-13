import { expect, it } from 'vitest'
import { quotaRetryAt } from '../src/app/setup.ts'

const NOW = 1_000_000_000_000
it('waits for a future reset plus up to 10 seconds of jitter', () => {
  expect(quotaRetryAt(NOW + 60_000, NOW, 1, 0)).toBe(NOW + 60_000)
  expect(quotaRetryAt(NOW + 60_000, NOW, 1, 0.5)).toBe(NOW + 65_000)
  expect(quotaRetryAt(NOW + 60_000, NOW, 3, 1)).toBe(NOW + 70_000)
})
it('backs off from 10 minutes, doubling per failure up to 1 hour, when the reset is unreadable or past', () => {
  const minutes = (failures: number, reset?: number) => (quotaRetryAt(reset, NOW, failures) - NOW) / 60_000
  expect([1, 2, 3, 4, 5, 50, 5000].map(failures => minutes(failures))).toEqual([10, 20, 40, 60, 60, 60, 60])
  expect(minutes(1, NOW)).toBe(10)
  expect(minutes(2, NOW - 1000)).toBe(20)
})
