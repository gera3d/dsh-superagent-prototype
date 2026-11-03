/** Interactive Decision Card component displaying Jev recommendations and candidate choices. */
import { useState } from 'react'
import type { DecisionChoice, DecisionEvaluationResult } from '../core/decision.ts'
import { Button, Tag } from './controls.tsx'

export interface DecisionCardProps {
  title?: string
  quote?: string
  recommendation: DecisionEvaluationResult
  choices: DecisionChoice[]
  onExecute?: (choiceId: string) => Promise<unknown> | unknown
  compact?: boolean
}

export function DecisionCard({ title, quote, recommendation, choices, onExecute, compact = false }: DecisionCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [executed, setExecuted] = useState<string | null>(null)

  const handleAction = async (id: string) => {
    setSelected(id)
    if (onExecute) {
      setBusy(true)
      try {
        await onExecute(id)
        setExecuted(id)
      } finally {
        setBusy(false)
      }
    }
  }

  const confidencePct = Math.round(recommendation.confidence * 100)

  return <div className="dt-decision-card" style={{
    background: 'linear-gradient(180deg, #182230 0%, #131922 100%)',
    border: '1px solid #1f4277',
    borderRadius: '10px',
    padding: compact ? '14px' : '18px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4), 0 0 25px rgba(31, 66, 119, 0.2)',
    marginTop: '12px',
    marginBottom: '16px'
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{
          background: '#1f6feb',
          color: 'white',
          fontSize: '10px',
          padding: '2px 6px',
          borderRadius: '4px',
          fontWeight: 700,
          letterSpacing: '0.5px'
        }}>JEV DECISION ENGINE</span>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#79c0ff' }}>{title || 'Next Action Recommendation'}</span>
      </div>
      <span style={{ fontSize: '11px', color: '#8b949e', background: '#161b22', padding: '2px 8px', borderRadius: '4px', border: '1px solid #30363d' }}>
        ⚡ {recommendation.latencyMs}ms via {recommendation.provider}
      </span>
    </div>

    {quote && <div style={{ fontSize: '13px', color: '#f0f6fc', marginBottom: '12px', fontWeight: 500, lineHeight: 1.4 }}>
      {quote}
    </div>}

    <div style={{ fontSize: '12px', color: '#c9d1d9', marginBottom: '14px', lineHeight: 1.4, background: 'rgba(56, 139, 253, 0.08)', padding: '10px 14px', borderRadius: '6px', border: '1px solid rgba(56, 139, 253, 0.2)' }}>
      <strong style={{ color: '#58a6ff' }}>Rationale: </strong>{recommendation.rationale}
    </div>

    {executed ? <div style={{ background: '#161b22', border: '1px solid #238636', borderRadius: '6px', padding: '12px', color: '#3fb950', fontWeight: 600 }}>
      ✅ Action Dispatched: <strong>{choices.find(c => c.id === executed)?.label || executed}</strong>. Superagent received instruction and is executing!
    </div> : <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {choices.map(choice => {
        const isRec = choice.id === recommendation.recommendedValue
        const probObj = recommendation.distribution.find(d => d.id === choice.id)
        const probPct = probObj ? Math.round(probObj.probability * 100) : (isRec ? confidencePct : 5)

        return <div key={choice.id} style={{
          background: isRec ? 'rgba(35, 134, 54, 0.12)' : '#161b22',
          border: isRec ? '1px solid #2ea043' : '1px solid #30363d',
          borderRadius: '8px',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          transition: 'all 0.15s ease'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontWeight: 600, color: '#f0f6fc', fontSize: '12px' }}>{choice.label}</span>
              {isRec && <span style={{
                background: '#238636',
                color: 'white',
                fontSize: '9px',
                padding: '1px 5px',
                borderRadius: '3px',
                fontWeight: 700
              }}>RECOMMENDED</span>}
            </div>
            {choice.description && <span style={{ fontSize: '11px', color: '#8b949e' }}>{choice.description}</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ width: '70px', height: '6px', background: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${probPct}%`, background: isRec ? '#238636' : '#8b949e', borderRadius: '3px' }} />
            </div>
            <span style={{ fontSize: '12px', fontWeight: 600, color: isRec ? '#3fb950' : '#8b949e', minWidth: '32px', textAlign: 'right' }}>
              {probPct}%
            </span>
            <Button variant={isRec ? 'primary' : 'outline'} size="sm" disabled={busy} onClick={() => handleAction(choice.id)}>
              {isRec ? 'Execute' : 'Choose'}
            </Button>
          </div>
        </div>
      })}
    </div>}
  </div>
}
