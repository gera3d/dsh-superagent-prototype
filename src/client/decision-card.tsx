/** Human-reviewed alternatives; selecting never implies a message was sent or work executed. */
import { useState } from 'react'
import type { DecisionChoice, DecisionEvaluationResult } from '../core/decision.ts'
import { Button } from './controls.tsx'

export interface DecisionCardProps {
  title?: string
  quote?: string
  recommendation: DecisionEvaluationResult
  choices: DecisionChoice[]
  onExecute?: (choiceId: string) => Promise<unknown> | unknown
  compact?: boolean
}
export function DecisionCard({ title, quote, recommendation, choices, onExecute, compact = false }: DecisionCardProps) {
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const choose = async (id: string) => {
    if (!onExecute || busy) return
    setBusy(true); setError(undefined)
    try {
      const result = await onExecute(id)
      if (result !== false) setSelected(id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className="dt-decision-card" aria-label={title || 'Decision alternatives'} style={{ border: '1px solid #526177', borderRadius: 8, padding: compact ? 12 : 16, margin: '12px 0', color: 'inherit' }}>
    <strong>{title || 'Choose an alternative'}</strong>
    {quote && <p>{quote}</p>}
    <p>{recommendation.rationale}</p>
    <small>Evaluator: {recommendation.provider}. Suggestions are not authorization.</small>
    {error && <p role="alert">{error}</p>}
    {selected && <p role="status">Choice recorded: {choices.find(choice => choice.id === selected)?.label || selected}. This does not confirm execution.</p>}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      {choices.map(choice => <div key={choice.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, border: '1px solid #526177', borderRadius: 6, padding: 10 }}>
        <div><strong>{choice.label}</strong>{choice.id === recommendation.recommendedValue && <small> · Suggested</small>}
          {choice.description && <div>{choice.description}</div>}
        </div>
        {onExecute && <Button variant="outline" size="sm" disabled={busy || !!selected} onClick={() => { void choose(choice.id) }}>Choose</Button>}
      </div>)}
    </div>
  </section>
}
