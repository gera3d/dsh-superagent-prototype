/**
 * Compact specialist avatar + status. Presentation only: the state is derived from native evidence by
 * `core/specialist-activity.ts`; this component never decides that something is "working".
 * Code-native SVG/CSS. Custom art: set `--dsa-spec-art` / pass `art` (a GIF/sprite URL) to replace the glyph.
 */
import { useEffect, useState } from 'react'
import type { Activity } from '../core/specialist-activity.ts'
import type { SpecialistProfile } from '../core/specialist-profile.ts'
import css from './specialist-status.css?raw'

const LABEL: Record<Activity['state'], string> = { idle: 'Idle', investigating: 'Investigating', tools: 'Using tools', testing: 'Testing', waiting: 'Waiting', blocked: 'Blocked', complete: 'Complete', unknown: 'Status unknown' }
const GLYPH: Record<string, string> = { administrator: 'A', senior_developer: 'S', cloudflare_specialist: 'C' }

export function ageText(at: number | undefined, now: number): string {
  if (at === undefined) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`
}

/** Text equivalent used by assistive technology and the tooltip; contains no animation-only information. */
export function statusText(profile: Pick<SpecialistProfile, 'identity'>, activity: Activity, now: number): string {
  const age = ageText(activity.at, now)
  return `${profile.identity.name}: ${LABEL[activity.state]}${activity.stale ? ' (stale)' : ''}${age ? `, updated ${age}` : ''}. ${activity.reason}.`
}

export interface SpecialistStatusProps {
  profile: Pick<SpecialistProfile, 'id' | 'identity' | 'activityStates'>
  activity: Activity
  /** Unavailable-capability note from the recorded attribution; shown as text, never as a control. */
  note?: string
  /** Replaceable custom asset (GIF/sprite URL). Defaults to the built-in SVG glyph. */
  art?: string
  now?: number
}

export function SpecialistStatus({ profile, activity, note, art, now: nowProp }: SpecialistStatusProps) {
  const [tick, setTick] = useState(() => Date.now())
  // Only tick when there is an age to keep honest; the clock never changes the state itself.
  useEffect(() => { if (nowProp !== undefined || activity.at === undefined) return; const timer = setInterval(() => setTick(Date.now()), 15000); return () => clearInterval(timer) }, [nowProp, activity.at])
  const now = nowProp ?? tick
  // A state the profile does not declare cannot be shown; fall back to unknown rather than to a working look.
  const supported = activity.state === 'unknown' || profile.activityStates.includes(activity.state)
  const shown = supported ? activity : { ...activity, state: 'unknown' as const, reason: `State ${activity.state} is not supported by this profile` }
  const text = statusText(profile, shown, now)
  return <div className="dsa-spec" data-state={shown.state} data-stale={shown.stale ? 'true' : 'false'} data-profile={profile.id}>
    <style>{css}</style>
    <span className="dsa-spec__avatar" aria-hidden="true" style={art ? { backgroundImage: `url(${JSON.stringify(art)})` } : undefined}>
      {!art && <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
        <circle className="dsa-spec__ring" cx="12" cy="12" r="10" fill="none" strokeWidth="2" />
        <text className="dsa-spec__glyph" x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700">{GLYPH[profile.id] ?? profile.identity.name.slice(0, 1).toUpperCase()}</text>
      </svg>}
    </span>
    <span className="dsa-spec__text" tabIndex={0} role="status" aria-live="polite" aria-label={text} title={text}>
      <span className="dsa-spec__name">{profile.identity.name}</span>
      <span className="dsa-spec__state">{LABEL[shown.state]}{shown.stale ? ' · stale' : ''}</span>
    </span>
    {note && <span className="dsa-spec__note">{note}</span>}
  </div>
}
