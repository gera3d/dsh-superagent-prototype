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
  context?: string
  unavailableReason?: string
  onEvaluate?: () => Promise<unknown>
}
export function DecisionCard({ title, quote, context, unavailableReason, recommendation, choices, onExecute, onEvaluate, compact = false }: DecisionCardProps) {
  const [evaluating, setEvaluating] = useState(false)
  const suggested = choices.find(choice => choice.id === recommendation.recommendedValue)
  const evaluate = async () => {
    if (!onEvaluate || evaluating || busy || selected !== undefined) return
    setEvaluating(true); setError(undefined)
    try { await onEvaluate() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setEvaluating(false) }
  }
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const completed = selected !== undefined
  const locked = busy || evaluating || completed
  const startNewDecision = () => {
    if (busy || evaluating) return
    setSelected(undefined)
    setError(undefined)
  }
  const choose = async (id: string) => {
    if (!onExecute || locked) return
    setBusy(true); setError(undefined)
    try {
      const result = await onExecute(id)
      if (result !== false) setSelected(id)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <section className="dt-decision-card" data-state={completed ? 'completed' : 'pending'} aria-label={title || 'Decision alternatives'} style={{ border: '1px solid #526177', borderRadius: 8, padding: compact ? 12 : 16, margin: '12px 0', color: 'inherit', background: completed ? 'rgba(128, 128, 128, 0.12)' : undefined }}>
    <style>{`
      .dt-decision-card .dt-btn:disabled {
        opacity: 0.5; cursor: not-allowed; box-shadow: none;
        background: rgba(128, 128, 128, 0.12); color: inherit;
      }
      .dt-decision-card[data-state="completed"] .dt-decision-option:not([data-chosen="true"]) { opacity: 0.55; }
    `}</style>
    <div><small>{completed ? 'Decision completed · choice recorded' : 'Decision question'}</small><h3 style={{ margin: '4px 0 12px' }}>{title || 'Choose an alternative'}</h3></div>
    {quote && <p>{quote}</p>}
    {context?.trim() ? <section aria-label="Source context" style={{ marginBottom: 16 }}>
      <strong>What led to this question</strong>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{context.length > 700 ? `${context.slice(0, 700)}…` : context}</p>
      {context.length > 700 && <details><summary>Read full source context</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflowY: 'auto' }}>{context}</p></details>}
      <small>Source excerpt, not independently verified evidence.</small>
    </section> : !compact && <p>No source context was saved. Review the source conversation before choosing.</p>}
    <aside aria-label="Recommendation" style={{ borderLeft: `3px solid ${suggested ? '#3fb950' : '#8b949e'}`, padding: '8px 12px', marginBottom: 12 }}>
      <strong>{suggested ? `Recommended: ${suggested.label}` : 'No recommendation yet'}</strong>
      <p>{suggested ? recommendation.rationale : unavailableReason || recommendation.rationale || 'This decision has not been evaluated.'}</p>
      {suggested && <small>Evaluator: {recommendation.provider}. Suggestions are not authorization.</small>}
      {onEvaluate && <Button variant="outline" size="sm" disabled={locked} onClick={() => { void evaluate() }}>{evaluating ? 'Evaluating…' : suggested ? 'Refresh' : 'Get recommendation'}</Button>}
    </aside>
    {error && <p role="alert">{error}</p>}
    {completed && <div>
      <p role="status">Choice recorded: {choices.find(choice => choice.id === selected)?.label || selected}. This does not confirm execution. Options and refresh are disabled.</p>
      <Button variant="outline" size="sm" disabled={busy || evaluating} onClick={startNewDecision}>Start new decision</Button>
      <p><small>Resets this card only; does not undo the recorded choice or any action.</small></p>
    </div>}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      {choices.map(choice => {
        const dist = recommendation.distribution?.find(d => d.id === choice.id)
        const probability = dist ? dist.probability : (choice.id === recommendation.recommendedValue && recommendation.confidence ? recommendation.confidence : undefined)
        const percent = probability !== undefined && Number.isFinite(probability) && probability > 0 ? Math.round(probability * 100) : undefined

        return <div key={choice.id} className="dt-decision-option" data-chosen={selected === choice.id ? 'true' : undefined} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, border: selected === choice.id ? '2px solid #3fb950' : '1px solid #526177', background: selected === choice.id ? 'rgba(63, 185, 80, 0.12)' : undefined, borderRadius: 6, padding: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{choice.label}</strong>
              {percent !== undefined && (
                <span className="dt-badge" style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 700,
                  background: choice.id === recommendation.recommendedValue ? 'rgba(63, 185, 80, 0.25)' : 'rgba(128, 128, 128, 0.2)',
                  color: choice.id === recommendation.recommendedValue ? '#3fb950' : '#8b949e',
                  border: choice.id === recommendation.recommendedValue ? '1px solid rgba(63, 185, 80, 0.4)' : '1px solid rgba(128, 128, 128, 0.3)'
                }}>
                  {percent}%
                </span>
              )}
              {selected === choice.id && <small> · ✓ Chosen</small>}
              {choice.id === recommendation.recommendedValue && <small> · Suggested</small>}
            </div>
            {choice.description && <div>{choice.description}</div>}
            {choice.prompt && <details style={{ marginTop: 6 }}><summary>Preview response</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{choice.prompt}</p></details>}
          </div>
          {onExecute && <Button variant="outline" size="sm" disabled={locked} onClick={() => { void choose(choice.id) }}>{selected === choice.id ? 'Recorded' : 'Choose'}</Button>}
        </div>
      })}
    </div>
  </section>
}
