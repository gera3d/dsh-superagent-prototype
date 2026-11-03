import { afterEach, expect, it, vi } from 'vitest'
import { evaluateDecision } from '../src/core/decision.ts'
const request = { context: 'Tests passed. Changes are not deployed.', question: 'Release now or wait for review?', choices: [{ id: 'release', label: 'Release now' }, { id: 'review', label: 'Wait for review' }] }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it('does not invent a recommendation without credentials', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  const result = await evaluateDecision(request)
  expect(result.recommendedValue).toBe('')
  expect(result.distribution).toEqual([])
  expect(result.provider).not.toContain('Jev')
})
it('never sends an OpenRouter credential to DeepSeek', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  vi.stubEnv('OPENROUTER_API_KEY', 'test-router-key')
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  await evaluateDecision(request)
  expect(fetch).not.toHaveBeenCalled()
})
it('rejects malformed probability results', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ recommended_value: 'release', confidence: .9, rationale: 'Test', distribution: [{ id: 'release', probability: .9 }, { id: 'release', probability: .1 }] }) } }] }) }))
  expect((await evaluateDecision(request)).recommendedValue).toBe('')
})
it('identifies valid scores as model-reported, not calibrated', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ recommended_value: 'review', confidence: .7, rationale: 'Review before deployment.', distribution: [{ id: 'release', probability: .3 }, { id: 'review', probability: .7 }] }) } }] }) }))
  const result = await evaluateDecision(request)
  expect(result.recommendedValue).toBe('review')
  expect(result.provider).toContain('not calibrated')
})
