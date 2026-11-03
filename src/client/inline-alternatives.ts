/** Recognize explicit mutually-exclusive choices, never ordinary task/check lists. */
import type { DecisionChoice } from '../core/decision.ts'

export interface InlineAlternatives { question: string; choices: DecisionChoice[] }
export function parseInlineAlternatives(text: string): InlineAlternatives | undefined {
  const lines = text.split(/\r?\n/)
  let fenced = false
  let question = ''
  let explicit = false
  const choices: DecisionChoice[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^```|^~~~/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    // A heading deliberately declaring alternatives, not a generic next-steps heading.
    if (/^(?:#{1,6}\s*)?(?:\*\*)?(?:alternatives|options|choose one|choose an option)(?:\*\*)?\s*[:?]?$/i.test(line)) {
      if (choices.length) break
      explicit = true
      continue
    }
    if (/\?$/.test(line) && /\b(?:which|choose|prefer|would you|should (?:we|I))\b/i.test(line) && !choices.length) {
      question = line.replace(/^#{1,6}\s*/, '')
      explicit = true
      continue
    }
    if (!explicit) continue
    // Lettered alternatives or explicitly named Option entries; numbered tasks are excluded.
    const match = line.match(/^(?:[-*]\s+)?(?:\*\*)?(?:Option\s+([A-Z1-9])\s*[:.)-]|([A-Z])\s*[.)])(?:\*\*)?\s+(.+)$/i)
    if (match) {
      const label = match[3]!.replace(/\*\*/g, '').trim()
      const id = `option-${(match[1] ?? match[2])!.toLowerCase()}`
      if (choices.some(choice => choice.id === id) || label.length > 1000) return undefined
      choices.push({ id, label })
    } else if (choices.length && line) break
  }
  if (choices.length < 2 || choices.length > 6) return undefined
  return { question: question || 'Which alternative should we take?', choices }
}
