import { expect, it } from 'vitest'
import { activeDeliveryForSession } from '../src/client/finding-association.ts'
it('completed historical delivery does not suppress later ordinary thread advice', () => {
 const item:any={id:'delivery-auto-worker',status:'pending',sessionId:'worker-original',delivery:{id:'auto-original',state:'stale',workers:['original'],historicalCompletion:{kind:'delivered_by_later_release',recordedAt:'2026-11-09T00:00:00Z'}}}
 expect(activeDeliveryForSession(item,'worker-original')).toBe(false)
})
