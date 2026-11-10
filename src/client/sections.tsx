/** Sections tab: per-project overview of named sections, then one section's base-thread view. Organizes existing tasks; starts nothing. */
import { useEffect, useState } from 'react'
import type { ApiResponse } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, Input, Pill, Tag } from './controls.tsx'
import type { DotContext } from './dot-chat.tsx'
import { useAction, usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { Hint, LoadState, PageHead, SessionButton } from './widgets.tsx'
import { ConfirmButton, Section } from './widgets.tsx'

type Overview = ApiResponse<'GET sections'>
type SectionRow = Overview['sections'][number]
type Preview = ApiResponse<'POST sections/:id/press-forward'> | ApiResponse<'POST sections/:id/make-better'>

function Glyph({ icon }: { icon: SectionRow['icon'] }) {
  return <span className="dt-section-glyph" style={{ color: icon.color }} data-icon={icon.name} aria-hidden="true">{icon.glyph}</span>
}
export function progressText(t: ReturnType<typeof usePanel>['t'], progress: SectionRow['progress']) {
  const parts = [t('sectionProgress', { done: progress.ended, total: progress.total })]
  if (progress.person) parts.push(t('sectionNeedsYou', { count: progress.person }))
  if (progress.working) parts.push(t('sectionRunning', { count: progress.working }))
  return parts.join(' · ')
}

export function SectionsPage({ project, section, getContext }: { project?: string | undefined; section?: string | undefined; getContext?: () => Promise<DotContext> }) {
  const { t, navigate } = usePanel()
  const [context, setContext] = useState<DotContext>()
  const [problem, setProblem] = useState<string>()
  useEffect(() => {
    let live = true
    getContext?.().then(value => { if (live) setContext(value) }, failure => { if (live) setProblem(failure instanceof Error ? failure.message : String(failure)) })
    return () => { live = false }
  }, [getContext])
  const chosen = project ?? context?.projects[0]?.id
  const go = (next: { project?: string; section?: string }) => navigate({ page: 'sections', query: next }, true)
  return <>
    <Hint>{t('sectionsIntro')}</Hint>
    {problem && <p className="dt-error" role="alert">{problem}</p>}
    {context && <div className="dt-filters" role="group" aria-label={t('sectionsProject')}>
      {context.projects.map(item => <Pill key={item.id} active={item.id === chosen} onClick={() => go({ project: item.id })}>{item.title}</Pill>)}
    </div>}
    {context && !context.projects.length && <Hint>{t('sectionsNoProjects')}</Hint>}
    {chosen && (section ? <SectionPage key={`${chosen}/${section}`} project={chosen} id={section} context={context} />
      : <ProjectOverview key={chosen} project={chosen} />)}
  </>
}

function ProjectOverview({ project }: { project: string }) {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET sections', { query: { project } }), [project])
  const decide = useAction((verb: 'approve' | 'reject', proposalId: string) => call(`POST sections/${verb}`, { body: { project, proposalId } }), { reload })
  return <>
    <LoadState error={error} loading={!data} />
    {data?.proposal && <div className="dt-row dt-att" data-testid="sections-proposal">
      <div className="dt-row-main">
        <div className="dt-row-title">{t('sectionsProposal')}</div>
        <Hint>{t('sectionsProposalHint')}</Hint>
        <ul className="dt-list">{data.proposal.sections.map(draft => <li key={draft.name} className="dt-row">
          <span className="dt-row-title">{draft.name}</span><Tag>{draft.icon}</Tag><span className="dt-hint">{t('sectionsTaskCount', { count: draft.members.length })}</span>
        </li>)}</ul>
        <div className="dt-row-meta dt-row-buttons">
          <ConfirmButton variant="outline" icon="decision" label={t('sectionsApprove')} title={t('sectionsApprove')} message={t('sectionsApproveConfirm')}
            onConfirm={() => decide.run('approve', data.proposal!.id)} />
          <ConfirmButton variant="outline" icon="dismiss" label={t('sectionsReject')} title={t('sectionsReject')} message={t('sectionsRejectConfirm')}
            onConfirm={() => decide.run('reject', data.proposal!.id)} />
        </div>
      </div>
    </div>}
    {data && data.structure === 'none' && <Hint>{t('sectionsNone')}</Hint>}
    {data && data.sections.length > 0 && <>
      <Section title={t('sectionsOverview')} count={t('sectionProgress', { done: data.totals.ended, total: data.totals.total })}>
        <ul className="dt-list">{data.sections.map(item => <li key={item.id} className="dt-row dt-link">
          <Glyph icon={item.icon} />
          <div className="dt-row-main">
            <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'sections', query: { project, section: item.id } })}>{item.name}</button></div>
            <div className="dt-row-meta"><span>{progressText(t, item.progress)}</span></div>
          </div>
          {item.baseThread && <div className="dt-row-actions"><SessionButton variant="outline" sessionId={item.baseThread} label={t('sectionBaseThread')} /></div>}
        </li>)}</ul>
      </Section>
      {data.unassigned.total > 0 && <Section title={t('sectionsUnassigned')} count={data.unassigned.total}>
        <ul className="dt-list">{data.unassigned.items.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
      </Section>}
    </>}
  </>
}

function SectionPage({ project, id, context }: { project: string; id: string; context: DotContext | undefined }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET sections', { query: { project } }), [project])
  const [preview, setPreview] = useState<Preview>()
  const [instruction, setInstruction] = useState('')
  const section = data?.sections.find(item => item.id === id)
  const move = useAction((kind: 'ticket' | 'session', member: string, to: string | null) => call('POST sections/move', { body: { project, member: { kind, id: member }, to } }), { reload })
  const link = useAction((sessionId: string | null) => call('POST sections/:id/base-thread', { id, body: { sessionId } }), { reload })
  const forward = useAction(async () => { setPreview(await call('POST sections/:id/press-forward', { id })) })
  const better = useAction(async () => { setPreview(await call('POST sections/:id/make-better', { id, body: { instruction } })) })
  const threads = (context?.threads ?? []).filter(thread => thread.projectId === project)
  return <>
    <PageHead title={section ? <><Glyph icon={section.icon} /> {section.name}</> : t('sectionsOverview')} />
    <LoadState error={error} loading={!data} />
    {data && !section && <Hint>{t('sectionMissing')}</Hint>}
    {section && <>
      <div className="dt-row-meta"><span>{progressText(t, section.progress)}</span></div>
      {section.goal && <p className="dt-hint" data-testid="section-goal">{section.goal}</p>}
      <Section title={t('sectionBaseThread')}>
        <div className="dt-row-meta dt-row-buttons">
          {section.baseThread ? <>
            <SessionButton variant="outline" sessionId={section.baseThread} />
            <Button variant="ghost" size="sm" icon={<Icon name="unsubscribe" size={14} />} disabled={link.busy} onClick={() => { void link.run(null) }}>{t('sectionUnlink')}</Button>
          </> : <>
            <Hint>{t('sectionNoBaseThread')}</Hint>
            {threads.length > 0 && <select className="dt-select" aria-label={t('sectionLinkThread')} value="" disabled={link.busy}
              onChange={event => { if (event.target.value) void link.run(event.target.value) }}>
              <option value="">{t('sectionLinkThread')}</option>
              {threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
            </select>}
          </>}
        </div>
      </Section>
      <Section title={t('sectionTasks')} count={section.tasks.length}>
        {section.tasks.length ? <div className="dt-list">{section.tasks.map(task => {
          const target = <select className="dt-select dt-move" aria-label={t('sectionMoveTo')} value={id} disabled={move.busy}
            onChange={event => { void move.run(task.kind, task.id, event.target.value === '' ? null : event.target.value) }}>
            {data!.sections.map(other => <option key={other.id} value={other.id}>{other.name}</option>)}
            <option value="">{t('sectionsUnassigned')}</option>
          </select>
          return task.ticket ? <div key={`${task.kind}:${task.id}`} className="dt-task"><ul className="dt-list"><TicketLine ticket={task.ticket} /></ul>{target}</div>
            : <div key={`${task.kind}:${task.id}`} className="dt-row dt-task"><div className="dt-row-main">
              <div className="dt-row-title">{task.id}</div>
              <div className="dt-row-meta"><Tag tone="quiet">{task.kind === 'session' ? t('sectionTaskSession') : t('sectionTaskUnknown')}</Tag></div>
            </div>{task.kind === 'session' && <SessionButton variant="outline" sessionId={task.id} />}{target}</div>
        })}</div> : <Hint>{t('none')}</Hint>}
      </Section>
      <Section title={t('sectionSteering')} hint={t('sectionSteeringHint')}>
        <div className="dt-row-meta dt-row-buttons">
          <Button variant="outline" size="sm" icon={<Icon name="play" size={14} />} disabled={forward.busy} onClick={() => { void forward.run() }}>{t('sectionPressForward')}</Button>
          <Input value={instruction} placeholder={t('sectionMakeBetterPlaceholder')} aria-label={t('sectionMakeBetter')} onChange={event => setInstruction(event.target.value)} />
          <Button variant="outline" size="sm" icon={<Icon name="star" size={14} />} disabled={better.busy || !instruction.trim()} onClick={() => { void better.run() }}>{t('sectionMakeBetter')}</Button>
        </div>
        {preview && <div className="dt-row" role="status" data-testid="steering-preview">
          <Tag tone="warning">{t('sectionPreviewOnly')}</Tag> <span className="dt-hint">{preview.note}</span>
        </div>}
      </Section>
    </>}
  </>
}
