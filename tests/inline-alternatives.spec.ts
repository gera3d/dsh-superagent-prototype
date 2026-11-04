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
  it('supports indented sub-bullets under explicitly named options', () => {
    const text = `## Alternatives
- **Option A:** Rebase onto main
  - Keeps git history linear and clean
  - Requires force pushing feature branch
- **Option B:** Create a merge commit
  - Preserves true chronological commit order
  - Leaves merge bubbles in commit graph`
    expect(parseInlineAlternatives(text)).toEqual({
      question: 'Which alternative should we take?',
      choices: [
        { id: 'option-a', label: 'Rebase onto main' },
        { id: 'option-b', label: 'Create a merge commit' },
      ],
    })
  })
  it('supports indented sub-bullets under lettered alternatives with a question', () => {
    const text = `Which approach should we take?
A. Keep the API compatible
   * Deprecate old fields gradually
   * Add telemetry warnings
B. Ship a breaking API
   * Drop deprecated endpoints immediately
   * Simpler implementation`
    expect(parseInlineAlternatives(text)).toEqual({
      question: 'Which approach should we take?',
      choices: [
        { id: 'option-a', label: 'Keep the API compatible' },
        { id: 'option-b', label: 'Ship a breaking API' },
      ],
    })
  })
  it('preserves options with sub-bullets when followed by unindented commentary', () => {
    const text = `## Options
- Option 1: SQLite
  - Embedded and zero config
  - Single writer
- Option 2: Postgres
  - Distributed and multi-writer
  - Requires database container

Please let me know which direction you prefer.`
    expect(parseInlineAlternatives(text)?.choices).toEqual([
      { id: 'option-1', label: 'SQLite' },
      { id: 'option-2', label: 'Postgres' },
    ])
  })
  it('does not confuse indented sub-bullets that mention option names with new choices', () => {
    const text = `## Alternatives
- **Option A:** Fast prototype
  - Option A requires less engineering time
  - Option B was also considered but rejected
- **Option B:** Full rewrite
  - Option B has higher upfront cost`
    expect(parseInlineAlternatives(text)?.choices).toEqual([
      { id: 'option-a', label: 'Fast prototype' },
      { id: 'option-b', label: 'Full rewrite' },
    ])
  })
})
