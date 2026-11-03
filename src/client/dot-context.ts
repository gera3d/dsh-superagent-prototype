/** Read-only snapshot of actual DSH projects and Sessions for Dot planning. No Session retain, prompt or create calls. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { DotContext } from './dot-chat.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DotThread } from '../app/dot.ts'

export interface DotWorkspaceSource {
  list: { getSnapshot(): { items: readonly { workspaceId: string; title: string; path: string; sessionIds: readonly string[] }[] } }
}

export async function dotContext(sessions: ISessions, workspaces?: DotWorkspaceSource): Promise<DotContext> {
  if (sessions.list.getSnapshot().phase !== 'ready') await sessions.refresh()
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new Error('The DSH thread catalog is not ready. Please retry.')
  const projects = (workspaces?.list.getSnapshot().items ?? []).map(p => ({ id: p.workspaceId, title: p.title, path: p.path }))
  const membership = new Map<string, string>()
  for (const workspace of workspaces?.list.getSnapshot().items ?? []) {
    for (const id of workspace.sessionIds) membership.set(id, workspace.workspaceId)
  }
  const threads: DotThread[] = list.ids.flatMap((id: SessionId) => {
    const session = list.byId[id]
    if (!session || session.blank) return []
    let projectId = membership.get(id) ?? projects.find(p => p.path === session.cwd)?.id
    if (!projectId && session.cwd) {
      projectId = `cwd:${session.cwd}`
      if (!projects.some(p => p.id === projectId)) projects.push({ id: projectId,
        title: session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? session.cwd, path: session.cwd })
    }
    const values = list.projectionsBySession?.[id]?.values as Record<string, unknown> | undefined
    const questions = values?.userQuestions as { active?: unknown[] } | undefined
    return [{ id, title: session.title || session.displayTitle || 'Untitled thread', projectId,
      running: session.running, waiting: Array.isArray(questions?.active) ? questions.active.length : 0, updatedAt: session.updatedAt }]
  }).sort((a: DotThread, b: DotThread) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt)
  return { projects, threads }
}
