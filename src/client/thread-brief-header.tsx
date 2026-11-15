/**
 * Thread Brief Header: compact sticky header displaying objective, completion criteria, state, and next action (Issue #216).
 * Coexists with model fallback routing: retains dynamic current-model indicator and persistent fallback event history.
 */
import { useState, type ReactNode } from 'react'
import { Button, DisclosureRow, Icon, Tag } from './controls.tsx'
import { When } from './widgets.tsx'
import type {
  ThreadBriefView,
  ThreadBriefCriterion,
  ThreadBriefScopeItem,
  ThreadBriefProposal,
  FallbackEventItem,
} from '../core/thread-brief.ts'

export type {
  ThreadBriefView,
  ThreadBriefCriterion,
  ThreadBriefScopeItem,
  ThreadBriefProposal,
  FallbackEventItem,
}

export function ThreadBriefHeader({
  brief,
  currentModel,
  fallbackEvents,
  onConfirmProposal,
}: {
  brief: ThreadBriefView
  currentModel?: string
  fallbackEvents?: FallbackEventItem[]
  onConfirmProposal?: (proposalId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const activeModel = currentModel || brief.model_context?.current_model || 'unknown'
  const isModelKnown = activeModel !== 'unknown' && activeModel !== 'unavailable'
  const events = fallbackEvents || brief.model_context?.fallback_events || []
  const proposals = brief.pending_proposals || []
  const satisfiedCount = brief.criteria.filter(c => c.status === 'satisfied').length

  return (
    <div
      className={`dt-thread-brief-bar ${expanded ? 'dt-brief-expanded' : 'dt-brief-compact'}`}
      data-testid="thread-brief-header"
      style={{
        border: '1px solid var(--dsw-border-subtle, #333)',
        borderRadius: '6px',
        padding: '8px 12px',
        marginBottom: '12px',
        background: 'var(--dsw-surface-raised, #18181b)',
      }}
    >
      {/* Pinned Top Bar: Always visible above transcript */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
          <Tag tone="info">Rev {brief.revision_id}</Tag>
          <strong
            style={{
              fontSize: '13px',
              color: 'var(--dsw-text, #eee)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '380px',
            }}
            title={brief.objective}
          >
            {brief.objective}
          </strong>
          <span style={{ fontSize: '11px', color: 'var(--dsw-text-muted, #888)' }}>
            [{brief.current_state}]
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Dynamic Model Indicator */}
          <Tag tone={events.length > 0 ? 'warning' : 'outline'} title={`Active Model: ${activeModel}`}>
            <span style={{ fontSize: '11px' }}>
              {isModelKnown ? activeModel : 'model: unavailable'}
            </span>
          </Tag>

          {/* Criteria Satisfaction Badge */}
          <Tag tone={satisfiedCount === brief.criteria.length ? 'success' : 'neutral'}>
            <span style={{ fontSize: '11px' }}>
              {satisfiedCount}/{brief.criteria.length} Criteria
            </span>
          </Tag>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            data-testid="brief-toggle-btn"
          >
            {expanded ? 'Hide Details' : 'View Details'}
          </Button>
        </div>
      </div>

      {/* Expandable Body: Exposes immutable original ask, criteria, scope, proposals & fallback details */}
      {expanded && (
        <div
          data-testid="brief-expanded-body"
          style={{
            marginTop: '10px',
            paddingTop: '10px',
            borderTop: '1px solid var(--dsw-border-subtle, #333)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {/* Next Action & State */}
          <div style={{ fontSize: '12px', display: 'flex', gap: '16px' }}>
            <div>
              <span style={{ color: 'var(--dsw-text-muted, #888)' }}>Next Action: </span>
              <strong>{brief.next_action}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--dsw-text-muted, #888)' }}>Task Status: </span>
              <Tag tone={brief.task_status === 'open' ? 'info' : 'neutral'}>{brief.task_status}</Tag>
            </div>
          </div>

          {/* Verbatim Original Ask (Immutable) */}
          <div style={{ background: 'var(--dsw-surface-sunken, #121214)', padding: '6px 10px', borderRadius: '4px' }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--dsw-text-muted, #888)', letterSpacing: '0.5px' }}>
              Verbatim Original Request (Immutable)
            </span>
            <pre
              data-testid="verbatim-original-ask"
              style={{
                margin: '4px 0 0 0',
                fontSize: '12px',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--dsw-text-subtle, #ccc)',
              }}
            >
              {brief.raw_original_ask}
            </pre>
          </div>

          {/* Criteria with Verified Evidence & Status */}
          <div>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '12px', color: 'var(--dsw-text-muted, #888)' }}>
              Definition of Done & Completion Criteria
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {brief.criteria.map(crit => (
                <div
                  key={crit.id}
                  data-testid={`criterion-${crit.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: '8px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    background: 'var(--dsw-surface-sunken, #121214)',
                    fontSize: '12px',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <code>[{crit.id}]</code>
                      <span>{crit.description}</span>
                      {crit.is_inferred && !crit.confirmed && (
                        <Tag tone="outline"><span style={{ fontSize: '10px' }}>Inferred (Unconfirmed)</span></Tag>
                      )}
                      {crit.confirmed && (
                        <Tag tone="neutral"><span style={{ fontSize: '10px' }}>Confirmed</span></Tag>
                      )}
                    </div>
                    {crit.evidence && (
                      <div
                        data-testid={`evidence-${crit.id}`}
                        style={{
                          marginTop: '4px',
                          fontSize: '11px',
                          color: 'var(--dsw-tone-success-text, #4ade80)',
                          background: 'rgba(74, 222, 128, 0.05)',
                          padding: '2px 6px',
                          borderRadius: '3px',
                        }}
                      >
                        ✓ Evidence ({crit.evidence.type}): {crit.evidence.summary} [{crit.evidence.reference}]
                      </div>
                    )}
                  </div>
                  <Tag
                    tone={
                      crit.status === 'satisfied'
                        ? 'success'
                        : crit.status === 'in_progress'
                        ? 'warning'
                        : 'outline'
                    }
                  >
                    <span style={{ fontSize: '11px' }}>{crit.status}</span>
                  </Tag>
                </div>
              ))}
            </div>
          </div>

          {/* Scope Items */}
          <div>
            <h4 style={{ margin: '0 0 6px 0', fontSize: '12px', color: 'var(--dsw-text-muted, #888)' }}>Scope Boundary</h4>
            <ul style={{ margin: '0', paddingLeft: '18px', fontSize: '12px' }}>
              {brief.scope.map((s, idx) => (
                <li key={idx} style={{ marginBottom: '2px' }}>
                  {s.text}{' '}
                  {s.is_inferred && !s.confirmed ? (
                    <Tag tone="outline"><span style={{ fontSize: '10px' }}>Inferred</span></Tag>
                  ) : (
                    <Tag tone="neutral"><span style={{ fontSize: '10px' }}>Confirmed</span></Tag>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {/* Pending Proposals (Unconfirmed Scope Staging) */}
          {proposals.length > 0 && (
            <div style={{ border: '1px dashed var(--dsw-border-subtle, #555)', borderRadius: '4px', padding: '6px 8px' }}>
              <h4 style={{ margin: '0 0 6px 0', fontSize: '12px', color: 'var(--dsw-tone-warning-text, #f59e0b)' }}>
                Pending Proposals ({proposals.length})
              </h4>
              {proposals.map(prop => (
                <div key={prop.proposal_id} style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{prop.description}</strong> by <em>{prop.proposed_by}</em>
                  </div>
                  {onConfirmProposal && prop.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onConfirmProposal(prop.proposal_id)}
                      data-testid={`confirm-proposal-${prop.proposal_id}`}
                    >
                      Confirm Proposal
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Fallback Events History (Coexistence with Model Fallback Routing) */}
          <div style={{ background: 'var(--dsw-surface-sunken, #121214)', padding: '6px 10px', borderRadius: '4px' }}>
            <span style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--dsw-text-muted, #888)', letterSpacing: '0.5px' }}>
              Model Fallback & Routing Telemetry
            </span>
            {events.length > 0 ? (
              <ul style={{ margin: '4px 0 0 0', paddingLeft: '18px', fontSize: '11px' }}>
                {events.map((ev, idx) => (
                  <li key={idx}>
                    {ev.timestamp && <When at={ev.timestamp} />}{' '}
                    <strong>{ev.requested_model}</strong> ➔ <strong>{ev.substituted_model}</strong>: {ev.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: '2px 0 0 0', fontSize: '11px', opacity: 0.6 }}>
                Primary model healthy; no fallback events recorded.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
