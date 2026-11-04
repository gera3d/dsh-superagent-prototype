/**
 * Phase 0 option-set contract: a decision card always shows at least
 * {@link OPTION_MIN} and at most {@link OPTION_MAX} options, and options beyond
 * the shown maximum are retained on the record instead of being pruned.
 *
 * Fallback options exist only to satisfy the minimum. They are marked
 * `added: true` so views and later phases can distinguish them from options a
 * source or advisor actually proposed.
 */
import type { DecisionChoice } from './decision.ts'

export const OPTION_MIN = 4
export const OPTION_MAX = 6

/** Clearly labelled generic options used only when fewer than OPTION_MIN survive. */
export const FALLBACK_OPTIONS: readonly DecisionChoice[] = [
  { id: 'added-wrap-up', label: 'Wrap up and summarize',
    description: 'Close the thread with a clear record.',
    prompt: 'Wrap up this work: summarize what changed, what was verified, and what risks remain.' },
  { id: 'added-verify', label: 'Verify the result',
    description: 'Confirm the work still holds before moving on.',
    prompt: 'Verify the result before we continue: run the relevant checks and report the exact commands and output.' },
  { id: 'added-extend-goal', label: 'Extend the goal',
    description: 'Keep momentum on the next related step.',
    prompt: 'Take the next useful step beyond the current goal. Explain what you plan to change before doing it.' },
  { id: 'added-ask-question', label: 'Ask a clarifying question',
    description: 'Resolve the biggest uncertainty first.',
    prompt: 'Before acting, ask me the one question that would most change the plan.' },
]

/**
 * Normalize any option source into the shown set plus unpruned hidden options.
 * Deduplicates by id and case-insensitive label, pads short sets to OPTION_MIN
 * with marked fallbacks, and keeps everything beyond OPTION_MAX as hidden.
 */
export function normalizeChoices(input: readonly DecisionChoice[]): { choices: DecisionChoice[]; hiddenOptions: DecisionChoice[] } {
  const seenIds = new Set<string>()
  const seenLabels = new Set<string>()
  const unique: DecisionChoice[] = []
  for (const choice of input) {
    const id = typeof choice?.id === 'string' ? choice.id.trim() : ''
    const label = typeof choice?.label === 'string' ? choice.label.trim() : ''
    if (!id || !label) continue
    const key = label.toLowerCase()
    if (seenIds.has(id) || seenLabels.has(key)) continue
    seenIds.add(id); seenLabels.add(key)
    unique.push({ ...choice, id, label })
  }
  for (const fallback of FALLBACK_OPTIONS) {
    if (unique.length >= OPTION_MIN) break
    const key = fallback.label.toLowerCase()
    if (seenLabels.has(key)) continue
    let id = fallback.id
    for (let suffix = 2; seenIds.has(id); suffix++) id = `${fallback.id}-${suffix}`
    seenIds.add(id); seenLabels.add(key)
    unique.push({ ...fallback, id, added: true })
  }
  return { choices: unique.slice(0, OPTION_MAX), hiddenOptions: unique.slice(OPTION_MAX) }
}
