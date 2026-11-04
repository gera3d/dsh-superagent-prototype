import { expect, it, vi } from 'vitest'
import type { DecisionEvaluationRequest, DecisionModelCall } from '../src/core/decision.ts'
import { decisionsRequest, evaluateDecisionWithFallback, parseDecisionsResponse } from '../src/app/decision-ranker.ts'
import { SettingsSchema } from '../src/policy.ts'

const request: DecisionEvaluationRequest = {
  context: 'Tests pass. Nothing is deployed yet.',
  question: 'Deploy now or review first?',
  choices: [
    { id: 'deploy', label: 'Deploy now', description: 'Ship the tested change.' },
    { id: 'review', label: 'Review first', description: 'Have another person inspect it.' },
  ],
}
const payload = {
  choice: 'review',
  confidence: 0.72,
  probabilities: [
    { value: 'deploy', probability: 0.28 },
    { value: 'review', probability: 0.72 },
  ],
}
const settings = (overrides: Record<string, unknown> = {}) => SettingsSchema.parse({ decisions: {
  provider: 'openai-luna', endpoint: 'https://decisions.example/v1/decisions', apiKeyEnv: 'DECISIONS_KEY', ...overrides,
} }).decisions
const llmReply: DecisionModelCall = async () => ({ text: JSON.stringify({
  recommended_value: 'deploy', confidence: 0.6, rationale: 'The tests cover the change.',
  distribution: [{ id: 'deploy', probability: 0.6 }, { id: 'review', probability: 0.4 }],
}), provider: 'configured / model' })

it('maps one choice question over the options from the thread digest and question', () => {
  const body = decisionsRequest(request, 'gpt-6-luna')
  expect(body.model).toBe('gpt-6-luna')
  expect(body.input).toContain(request.context)
  expect(body.input).toContain(request.question)
  expect(body.questions).toEqual([{
    name: 'next_action',
    type: 'choice',
    instructions: expect.stringContaining(request.question),
    choices: [
      { value: 'deploy', description: 'Deploy now — Ship the tested change.' },
      { value: 'review', description: 'Review first — Have another person inspect it.' },
    ],
  }])
  expect(body.questions[0]!.instructions).toContain('untrusted data')
})

it('maps choice, probabilities and confidence to the recommendation contract', () => {
  const result = parseDecisionsResponse(payload, request, 'openai-luna', 'gpt-6-luna', 12)
  expect(result.recommendedValue).toBe('review')
  expect(result.confidence).toBe(0.72)
  expect(result.distribution).toEqual([{ id: 'deploy', probability: 0.28 }, { id: 'review', probability: 0.72 }])
  expect(result.provider).toContain('OpenAI Decisions API / gpt-6-luna')
  expect(result.provider).toContain('not calibrated')
  expect(result.rationale).toContain('Review first')
  expect(result.latencyMs).toBe(12)
})

it('accepts a single wrapped result and id/probability distribution aliases', () => {
  const result = parseDecisionsResponse({ result: { choice: 'deploy', confidence: 0.55, probabilities: [
    { id: 'deploy', probability: 0.55 }, { id: 'review', probability: 0.45 },
  ] } }, request, 'typesafe-jev', 'jev-latest', 4)
  expect(result.recommendedValue).toBe('deploy')
  expect(result.provider).toContain('TypeSafe Jev Decisions API / jev-latest')
})

it('rejects an unknown choice, an incomplete distribution, or a distribution that does not sum to one', () => {
  expect(() => parseDecisionsResponse({ ...payload, choice: 'ship' }, request, 'openai-luna', 'gpt-6-luna', 1)).toThrow('unknown choice')
  expect(() => parseDecisionsResponse({ ...payload, probabilities: [payload.probabilities[0]] }, request, 'openai-luna', 'gpt-6-luna', 1)).toThrow('incomplete')
  expect(() => parseDecisionsResponse({ ...payload, probabilities: [
    { value: 'deploy', probability: 0.2 }, { value: 'review', probability: 0.2 },
  ] }, request, 'openai-luna', 'gpt-6-luna', 1)).toThrow('invalid distribution')
  expect(() => parseDecisionsResponse({ ...payload, probabilities: [
    { value: 'deploy', probability: 0.2 }, { value: 'deploy', probability: 0.8 },
  ] }, request, 'openai-luna', 'gpt-6-luna', 1)).toThrow('invalid distribution')
})

it('ranks with the configured Decisions API first and does not call the evaluator', async () => {
  const send = vi.fn(async () => Response.json(payload))
  const call = vi.fn(llmReply)
  const result = await evaluateDecisionWithFallback(request, {
    decisions: settings(), env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call,
  })
  expect(result.recommendedValue).toBe('review')
  expect(call).not.toHaveBeenCalled()
  expect(send).toHaveBeenCalledOnce()
  const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://decisions.example/v1/decisions')
  expect(init.method).toBe('POST')
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
})

it('falls back to the existing evaluator when the Decisions API fails', async () => {
  const send = vi.fn(async () => new Response('unavailable', { status: 503 }))
  const call = vi.fn(llmReply)
  const result = await evaluateDecisionWithFallback(request, {
    decisions: settings(), env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call,
  })
  expect(result).toMatchObject({ recommendedValue: 'deploy', confidence: 0.6 })
  expect(result.provider).toContain('configured / model')
  expect(call).toHaveBeenCalledOnce()
})

it('ends unranked in generator order when both rankers fail', async () => {
  const send = vi.fn(async () => { throw new Error('network down') })
  const call = vi.fn(async () => { throw new Error('model down') })
  const result = await evaluateDecisionWithFallback(request, {
    decisions: settings(), env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call,
  })
  expect(result).toMatchObject({ recommendedValue: '', confidence: 0, distribution: [], provider: 'unranked' })
  expect(result.rationale).toContain('Unranked')
  expect(request.choices.map(choice => choice.id)).toEqual(['deploy', 'review'])
})

it('makes no Decisions API call until settings name a driver and its key exists', async () => {
  const send = vi.fn(async () => Response.json(payload))
  const call = vi.fn(llmReply)
  const auto = await evaluateDecisionWithFallback(request, { decisions: settings({ provider: 'auto' }),
    env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call })
  expect(auto.provider).toContain('configured / model')
  const noKey = await evaluateDecisionWithFallback(request, { decisions: settings(), env: {},
    fetch: send as unknown as typeof fetch, call })
  expect(noKey.provider).toContain('configured / model')
  const deepseek = await evaluateDecisionWithFallback(request, { decisions: settings({ provider: 'deepseek' }),
    env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call })
  expect(deepseek.provider).toContain('configured / model')
  expect(send).not.toHaveBeenCalled()
  expect(call).toHaveBeenCalledTimes(3)
})

it('lets one request name an explicit provider while settings stay automatic', async () => {
  const send = vi.fn(async () => Response.json(payload))
  const result = await evaluateDecisionWithFallback({ ...request, provider: 'openai-luna' }, {
    decisions: SettingsSchema.parse({ decisions: { apiKeyEnv: 'OPENAI_API_KEY' } }).decisions,
    env: { OPENAI_API_KEY: 'test-key' }, fetch: send as unknown as typeof fetch,
  })
  expect(result.recommendedValue).toBe('review')
  expect(send).toHaveBeenCalledOnce()
})

it('reports an unusable request as unavailable without calling a ranker', async () => {
  const send = vi.fn()
  const call = vi.fn()
  const result = await evaluateDecisionWithFallback({ ...request, choices: [{ id: 'one', label: 'One' }] }, {
    decisions: settings(), env: { DECISIONS_KEY: 'test-key' }, fetch: send as unknown as typeof fetch, call,
  })
  expect(result.recommendedValue).toBe('')
  expect(result.provider).toBe('Recommendation unavailable')
  expect(send).not.toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()
})

it('keeps the ranker off by default and validates its block', () => {
  expect(SettingsSchema.parse({}).decisions).toEqual({ provider: 'auto', model: '', endpoint: '', apiKeyEnv: '', timeoutMs: 15_000 })
  expect(SettingsSchema.parse({ decisions: { provider: 'typesafe-jev', apiKeyEnv: 'JEV_KEY' } }).decisions)
    .toMatchObject({ provider: 'typesafe-jev', apiKeyEnv: 'JEV_KEY' })
  expect(() => SettingsSchema.parse({ decisions: { endpoint: 'not a url' } })).toThrow()
  expect(() => SettingsSchema.parse({ decisions: { endpoint: 'javascript:alert(1)' } })).toThrow()
  expect(() => SettingsSchema.parse({ decisions: { apiKeyEnv: 'not a name!' } })).toThrow()
})
