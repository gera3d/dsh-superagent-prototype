/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { DotChat } from './dot-chat.tsx'
import { executeApprovedDotAction } from './dot-execution.ts'
import { dotContext, type DotWorkspaceSource } from './dot-context.ts'
import { InlineDecision } from './inline-decision.tsx'
import { PublicationDock, SharedLifecycleCard } from './publication-cards.tsx'
import { createDecisionSubmission } from './decision-submission.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { BrandLogoMark, BrandWordmark } from './branding-mark.tsx'
import { AllowanceHeaderBadge, AllowanceSidebarBody, ALLOWANCE_TAB_ID, ALLOWANCE_TAB_KIND, AllowanceIcon, type AllowanceClientContext } from './account-allowance.tsx'
import { en, zh } from './locales.ts'
import type { T } from './text.ts'
import { DecisionHandoffDock } from './decision-handoff.tsx'
import { WorkerReportFallback, workerReportDefinition, workerReportView } from './worker-report-fallback.tsx'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  const getDotContext = useCallback(() => dotContext(ctx.sessions,
    ctx.get('workspaces' as never) as DotWorkspaceSource | undefined), [ctx])
  return <App t={t} openSession={openSession} deploymentForm={form} dotChat={<DotChat getContext={getDotContext}
    executeAction={(action, approvedContext, signal) => executeApprovedDotAction(ctx.sessions, action, approvedContext, getDotContext, signal, openSession)}
    openSession={openSession} />} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace', 'conversation', 'uiConversation']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.uiConversation.events.register(workerReportDefinition()))
  ctx.effect(() => ctx.uiConversation.views.register(workerReportView()))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-superagent.worker-report', order: 7,
  }, props => <WorkerReportFallback ctx={ctx} sessionId={props.session.sessionId} running={props.session.running} removed={props.session.removed} />))
  ctx.effect(() => ctx.provide('publicationCards', { render: (item, onTicket) => <SharedLifecycleCard item={item} onTicket={onTicket} /> }))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-superagent.publications', order: 8,
  }, props => <PublicationDock sessionId={props.session.sessionId} removed={props.session.removed} />))
  const submissionBridge = createDecisionSubmission(ctx)
  ctx.effect(() => { const unprovide = ctx.provide('decisionSubmission', submissionBridge); return () => { unprovide(); submissionBridge.dispose() } })
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-superagent.decision-handoff', order: 5,
  }, props => <DecisionHandoffDock key={props.session.sessionId} {...props} bridge={submissionBridge} />))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'dsh-superagent.inline-decision', order: 10,
  }, props => <InlineDecision {...props} submissionBridge={submissionBridge} />))
  // Compact account allowance badge beside chat in conversation session header
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'dsh-superagent.account-allowance', order: 15,
  }, () => <AllowanceHeaderBadge ctx={ctx as AllowanceClientContext} t={t} />))
  // Detailed allowance pane registered in the documented Right Sidebar slot when available
  if (typeof (ctx as any).inject === 'function') {
    (ctx as any).inject(['sidebarRightTabs'], (scope: ClientContext) => {
      scope.effect(() => (scope as any).sidebarRightTabs.register({
        id: ALLOWANCE_TAB_ID, kind: ALLOWANCE_TAB_KIND, priority: 'extension',
        title: () => t('allowanceTitle'),
        guide: [{ id: 'allowance', order: 25, title: () => t('allowanceTitle'), description: () => t('allowanceLocalNote'), icon: AllowanceIcon }],
      }))
      scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab', key: ALLOWANCE_TAB_ID, locale: NS,
      }, () => <AllowanceSidebarBody t={t} />))
    })
  }
  // `sidebar.brand.mark` is a single slot: the official brand plugin already occupies priority 0, so claim a lower
  // rank to shadow it instead of throwing on a duplicate registration (lowest priority renders).
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark', priority: -1,
  }, props => <BrandLogoMark {...props} />))
  // `sidebar.brand.name` holds the DeepSeek wordmark next to the mark. Shadow it at priority -1 to render
  // our component (or null when hidden, leaving the spot empty).
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', priority: -1,
  }, props => <BrandWordmark {...props} />))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
