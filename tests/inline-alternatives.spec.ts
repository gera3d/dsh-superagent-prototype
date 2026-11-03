import { describe, expect, it } from 'vitest'
import { parseInlineAlternatives } from '../src/client/inline-alternatives.ts'

describe('explicit inline decision alternatives', () => {
  it('recognizes a question with lettered alternatives', () => {
    expect(parseInlineAlternatives('Which approach should we take?\nA. Keep the API compatible\nB. Ship a breaking API'))
      .toEqual({ question: 'Which approach should we take?', choices: [
        { id: 'option-a', label: 'Keep the API compatible' }, { id: 'option-b', label: 'Ship a breaking API' },
      ] })
  })
  it('accepts explicitly named options under an alternatives heading', () => {
    expect(parseInlineAlternatives('## Alternatives\n- **Option A:** Keep the existing backend\n- **Option B:** Replace the backend')?.choices).toHaveLength(2)
  })
  it('never turns a sequential task list into choices', () => {
    expect(parseInlineAlternatives('Next steps:\n1. Run tests\n2. Build\n3. Deploy')).toBeUndefined()
    expect(parseInlineAlternatives('## Options\n1. Run tests\n2. Build')).toBeUndefined()
  })
  it('ignores code fences and requires at least two unique alternatives', () => {
    expect(parseInlineAlternatives('```\nOptions\nA. Alpha\nB. Beta\n```')).toBeUndefined()
    expect(parseInlineAlternatives('Options\nA. Alpha')).toBeUndefined()
    expect(parseInlineAlternatives('Options\nA. Alpha\nA. Beta')).toBeUndefined()
  })
})
