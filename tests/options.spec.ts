import { expect, it } from 'vitest'
import { FALLBACK_OPTIONS, normalizeChoices, OPTION_MAX, OPTION_MIN } from '../src/core/options.ts'

it('keeps four to six options and pads short sets with marked fallbacks', () => {
  const two = normalizeChoices([{ id: 'a', label: 'Do A' }, { id: 'b', label: 'Do B' }])
  expect(two.choices).toHaveLength(OPTION_MIN)
  expect(two.choices.slice(0, 2)).toEqual([{ id: 'a', label: 'Do A' }, { id: 'b', label: 'Do B' }])
  expect(two.choices.slice(2)).toEqual(FALLBACK_OPTIONS.slice(0, 2).map(option => ({ ...option, added: true })))
  expect(two.hiddenOptions).toEqual([])
})

it('retains options beyond the shown maximum as hidden', () => {
  const input = Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, label: `Choice ${index}` }))
  const { choices, hiddenOptions } = normalizeChoices(input)
  expect(choices).toHaveLength(OPTION_MAX)
  expect(hiddenOptions.map(choice => choice.id)).toEqual(['c6', 'c7'])
})

it('deduplicates ids and case-insensitive labels and never repeats a fallback', () => {
  const { choices } = normalizeChoices([
    { id: 'wrap', label: 'Wrap up and summarize' },
    { id: 'wrap', label: 'Duplicate id' },
    { id: 'other', label: 'WRAP UP AND SUMMARIZE' },
    { id: 'ship', label: 'Ship it' },
  ])
  expect(choices.map(choice => choice.label)).toEqual(['Wrap up and summarize', 'Ship it', 'Verify the result', 'Extend the goal'])
})
