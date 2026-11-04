import { describe, expect, it, vi } from 'vitest'
import { extractJsonObject } from '../src/app/dot-json.ts'

function validate(value: unknown): { answer: string; rationale?: string } {
  const object = value as Record<string, unknown>
  if (typeof object.answer !== 'string') throw new Error('Secret schema detail')
  if (object.rationale !== undefined && typeof object.rationale !== 'string') throw new Error('Invalid rationale')
  return object as { answer: string; rationale?: string }
}

const correct = { answer: 'second', rationale: 'A small change is safer.' }

describe('extractJsonObject', () => {
  it('extracts a strict JSON object from prose and fenced code', () => {
    expect(extractJsonObject(`Here is the result:\n\`\`\`json\n${JSON.stringify(correct)}\n\`\`\`\nDone.`, validate)).toEqual(correct)
    expect(extractJsonObject(`Result: ${JSON.stringify(correct)} End.`, validate)).toEqual(correct)
  })

  it('ignores braces in rationale and handles escaped quotes and backslashes', () => {
    const value = { answer: 'second', rationale: 'Keep {this} and } that {; "quoted"; C:\\temp\\; \\"still quoted"' }
    expect(extractJsonObject(JSON.stringify(value), validate)).toEqual(value)
  })

  it('skips unrelated braces, malformed JSON, and schema-invalid objects', () => {
    const text = `Use {placeholders}. {"answer":} {"wrong":"schema"} ${JSON.stringify(correct)} {"answer":"later"}`
    expect(extractJsonObject(text, validate)).toEqual(correct)
  })

  it('returns the first schema-valid candidate and preserves the validator result', () => {
    const validator = vi.fn((value: unknown) => ({ selected: (value as { answer: string }).answer }))
    expect(extractJsonObject('{"answer":"first"} {"answer":"second"}', validator)).toEqual({ selected: 'first' })
    expect(validator).toHaveBeenCalledTimes(1)
  })

  it('does not take nested objects from a schema-invalid outer object', () => {
    expect(extractJsonObject(`{"nested":{"answer":"wrong"}} ${JSON.stringify(correct)}`, validate)).toEqual(correct)
    expect(() => extractJsonObject('{"nested":{"answer":"wrong"}}', validate)).toThrow('No complete schema-valid JSON object found')
  })

  it.each([
    '{"answer":"missing close"',
    '{"answer":"unterminated}',
    '{"nested":{"answer":"not a complete outer object"}',
    '{"answer":"trailing comma",}',
    "{'answer':'single quotes'}",
    '{answer:"unquoted key"}',
    '{"answer":undefined}',
    '{"answer":"comment" /* no */}',
    '{"answer":NaN}',
    '{"answer":[1,2}}',
  ])('rejects malformed or truncated JSON: %s', text => {
    expect(() => extractJsonObject(text, validate)).toThrow()
  })

  it.each(['', 'No JSON here.', 'null', '42', 'true', '[]', '[{"answer":"nested"}]', '"{}"'])('rejects non-object output: %s', text => {
    const validator = vi.fn(() => true)
    expect(() => extractJsonObject(text, validator)).toThrow('No JSON object found')
    expect(validator).not.toHaveBeenCalled()
  })

  it('skips arrays without extracting their objects and continues to a later object', () => {
    expect(extractJsonObject(`[{"answer":"nested"}] ${JSON.stringify(correct)}`, validate)).toEqual(correct)
  })

  it('does not invent missing schema fields or expose validator/model secrets', () => {
    const secret = 'MODEL_SECRET_123'
    let message = ''
    try {
      extractJsonObject(`{"rationale":"${secret}"}`, () => { throw new Error(secret) })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toBe('No complete schema-valid JSON object found')
    expect(message).not.toContain(secret)
    expect(message.length).toBeLessThan(100)
    expect(() => extractJsonObject(`{"answer":${secret}}`, validate)).toThrow('No complete schema-valid JSON object found')
  })

  it('accepts 64,000 characters but rejects larger input before validation', () => {
    const json = JSON.stringify(correct)
    const boundary = json + ' '.repeat(64_000 - json.length)
    expect(extractJsonObject(boundary, validate)).toEqual(correct)
    const validator = vi.fn(validate)
    expect(() => extractJsonObject(boundary + ' ', validator)).toThrow('size limit')
    expect(validator).not.toHaveBeenCalled()
  })

  it('accepts depth 128 and rejects depth 129 including nested arrays', () => {
    const nested = (depth: number) => '{"answer":"ok","nested":' + '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1) + '}'
    expect(extractJsonObject(nested(128), validate).answer).toBe('ok')
    expect(() => extractJsonObject(nested(129), validate)).toThrow('depth limit')
    expect(() => extractJsonObject('{'.repeat(129), validate)).toThrow('depth limit')
  })

  it('does not count brackets inside strings toward nesting depth', () => {
    const value = { answer: 'ok', rationale: '{['.repeat(200) }
    expect(extractJsonObject(JSON.stringify(value), validate)).toEqual(value)
  })
})
