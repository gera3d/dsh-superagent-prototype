import { expect, it } from 'vitest'
import { DeliveryConfirmRequest } from '../src/app/http.ts'
it('accepts only a positive revision and exact action ID, never commands or caller authority', () => {
  expect(DeliveryConfirmRequest.parse({ revision: 4, actionId: 'review-4' })).toEqual({ revision: 4, actionId: 'review-4' })
  for (const input of [
    { revision: 0, actionId: 'x' }, { revision: -1, actionId: 'x' }, { revision: 1.2, actionId: 'x' },
    { revision: '4', actionId: 'x' }, { revision: 4, actionId: '' }, { revision: 4 },
    { revision: 4, actionId: 'x', command: 'publish everything' }, { revision: 4, actionId: 'x', authority: 'owner' },
  ]) expect(DeliveryConfirmRequest.safeParse(input).success).toBe(false)
})
