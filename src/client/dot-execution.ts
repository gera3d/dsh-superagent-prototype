/** Execution boundary: call only from an explicit, per-plan UI Approve handler. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { DotAction } from '../app/dot.ts'
import type { DotContext } from './dot-chat.tsx'

export type DotExecutionReceipt = { status: 'succeeded' | 'failed'; sessionId?: string; message: string }

/** One approved action, one attempt. Never replay create/prompt after an uncertain outcome. */
export async function executeApprovedDotAction(
  sessions: ISessions,
  action: DotAction,
  approvedContext: DotContext,
  getContext: () => Promise<DotContext>,
  signal: AbortSignal,
  openSession: (id: string) => Promise<void>,
): Promise<DotExecutionReceipt> {
  let sessionId: string | undefined
  let stage: 'catalog' | 'create' | 'prompt' | 'open' = 'catalog'
  const failed = (message: string): DotExecutionReceipt => ({ status: 'failed', ...(sessionId ? { sessionId } : {}), message })
  const aborted = () => failed('Action cancelled. No further action was attempted.')
  try {
    if (signal.aborted) return aborted()
    if (!action || typeof action !== 'object' || typeof action.why !== 'string') return failed('Invalid action. Request a new plan.')
    if (action.type !== 'start_thread' && action.type !== 'message_thread' && action.type !== 'open_thread')
      return failed('Unknown action. Request a new plan.')
    if (action.type !== 'open_thread' && (typeof action.prompt !== 'string' || !action.prompt.trim()))
      return failed('The approved prompt is empty or invalid.')
    if (action.type === 'start_thread' ? typeof action.projectId !== 'string' || !action.projectId.trim()
      : typeof action.sessionId !== 'string' || !action.sessionId.trim()) return failed('Invalid action target. Request a new plan.')

    // Refresh read-only authority immediately before any mutation; never trust a model's ids/paths.
    const current = await getContext()
    if (signal.aborted) return aborted()
    if (action.type === 'start_thread') {
      const approved = approvedContext.projects.find(project => project.id === action.projectId)
      const project = current.projects.find(project => project.id === action.projectId)
      if (!approved || !project || typeof project.path !== 'string' || !project.path.trim() || approved.path !== project.path)
        return failed('The approved project is missing or its path changed. Request a new plan.')
      if (project.id.startsWith('cwd:') && project.id !== `cwd:${project.path}`)
        return failed('The approved fallback project path is invalid. Request a new plan.')
      if (signal.aborted) return aborted()
      stage = 'create'
      sessionId = await sessions.create(project.id.startsWith('cwd:')
        ? { cwd: project.path } : { workspaceId: project.id as WorkspaceId })
      if (signal.aborted) return aborted()
    } else {
      if (!approvedContext.threads.some(thread => thread.id === action.sessionId)
        || !current.threads.some(thread => thread.id === action.sessionId))
        return failed('The approved thread is no longer available. Request a new plan.')
      sessionId = action.sessionId
    }
    if (signal.aborted) return aborted()
    if (action.type === 'open_thread') {
      stage = 'open'
      await openSession(sessionId!)
      return { status: 'succeeded', sessionId, message: 'Thread opened.' }
    }

    stage = 'prompt'
    const text = action.prompt
    return await sessions.using(sessionId as SessionId, { source: 'controllerOperation', signal }, async (ref): Promise<DotExecutionReceipt> => {
      const { session } = await ref.ready
      if (signal.aborted) return aborted()
      const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
      try {
        if (signal.aborted) { submission.abandon(); return aborted() }
        const result = await session.prompt([{ type: 'text', text }], 'queue', signal, submission.requestId)
        if (!result.ok) {
          submission.abandon()
          return failed('The thread did not accept the queued prompt. It was not retried; check the thread before trying again.')
        }
        return { status: 'succeeded', sessionId, message: 'Prompt queued in the thread.' }
      } catch {
        // Includes serialization failures before the RPC. abandon is idempotent after settlement.
        submission.abandon()
        return signal.aborted ? aborted() : failed('The prompt could not be confirmed. It was not retried; check the thread before trying again.')
      }
    })
  } catch {
    if (signal.aborted) return aborted()
    if (stage === 'create') return failed('Thread creation could not be confirmed. It was not retried; check the thread list before trying again.')
    if (stage === 'prompt') return failed('The thread could not be prepared for the prompt. It was not retried.')
    if (stage === 'open') return failed('The thread could not be opened.')
    return failed('The current project and thread catalog could not be verified. No action was executed.')
  }
}
