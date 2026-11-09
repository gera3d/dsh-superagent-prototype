/**
 * Bounded Option Quality Evaluation & Lifecycle Verification.
 *
 * Enforces that every recommended and alternate option is:
 * 1. Current-state and evidence grounded (truthful, no false verification or acceptance claims).
 * 2. Strictly relevant and within the approved task scope (rejects unsolicited detours such as
 *    opening unrequested separate findings for native-tool gaps or listing unrelated deliveries,
 *    while preserving explicit authorized requests).
 * 3. Assigned to the correct next owner and permitted capability (coordinator/Codex review with
 *    manual bridge, no worker self-review, no fictional dispatch API; safe truthful denials are respected).
 * 4. Distinct and actionable (scores only rank choices, never certify usefulness).
 * 5. Respectful of delivery boundaries (unbound deliveries identify exact missing inputs and owner;
 *    no premature publication, deployment, or acceptance advice).
 * 6. Free from stale repeat commands on completed/resolved work (safe prohibitions and non-repeat
 *    confirmations are preserved).
 */
import type { DecisionChoice } from '../core/decision.ts'
import type { AdviceOption } from './specialist-advice.ts'

export type QualityIssueCode =
  | 'unrelated-task-detour'
  | 'worker-self-review'
  | 'fictional-dispatch'
  | 'blanket-rerun'
  | 'false-verification-claim'
  | 'stale-completed-work'
  | 'unbound-delivery-bypass'
  | 'duplicate-choice'

export interface OptionQualityIssue {
  code: QualityIssueCode
  optionId: string
  message: string
}

export interface OptionQualityContext {
  taskTitle?: string
  taskScope?: string
  ticketId?: string
  findingId?: string
  findingState?: string
  findingBlocker?: string
  isFindingResolved?: boolean
  deliveryId?: string
  deliveryState?: string
  deliveryScopeBound?: boolean
  deliveryMissingBinding?: string
  isDeliveryAccepted?: boolean
  isReadyUnreviewed?: boolean
  hasNewerFailureOrPending?: boolean
  hasNestedProviderEvidence?: boolean
  workflowContext?: string
}

export interface OptionAuditResult {
  valid: boolean
  issues: OptionQualityIssue[]
  validChoices: (DecisionChoice | AdviceOption)[]
  invalidChoices: (DecisionChoice | AdviceOption)[]
}

/**
 * Derives an OptionQualityContext from raw workflow context and available metadata.
 */
export function deriveOptionQualityContext(
  workflowContext?: string,
  overrides: Partial<OptionQualityContext> = {},
): OptionQualityContext {
  const text = workflowContext ?? ''

  // Attempt structured extraction from FACTS JSON block
  let facts: any = null
  const factsMatch = text.match(/FACTS below are bounded recorded data[^{]*(\{[\s\S]*\})\s*$/)
  if (factsMatch && factsMatch[1]) {
    try {
      facts = JSON.parse(factsMatch[1])
    } catch {}
  }

  const isFindingResolved = overrides.isFindingResolved
    ?? (facts?.finding?.state === 'resolved'
      || Boolean(facts?.finding?.resolution)
      || /\bFINDING RESOLVED: this finding is already verified and resolved\b/i.test(text)
      || /\b"resolution":\s*\{\s*"outcome":\s*"verified"\b/i.test(text))

  const isDeliveryAccepted = overrides.isDeliveryAccepted
    ?? (facts?.delivery?.state === 'accepted'
      || Boolean(facts?.delivery?.acceptance)
      || Boolean(facts?.delivery?.accepted)
      || /\bRELEASE COMPLETE: this delivery is already verified and accepted\b/i.test(text)
      || /\b"state":\s*"accepted"\b/i.test(text))

  const isReadyUnreviewed = overrides.isReadyUnreviewed
    ?? (/\bCANONICAL FINDING REVIEW OBJECTIVE\b/i.test(text)
      || /\bThe implementation worker has reported a candidate ready for independent review\b/i.test(text)
      || /\bThe review handoff candidate is ready\b/i.test(text)
      || /\bawaiting independent review\b/i.test(text))

  // Derive hasNewerFailureOrPending structurally from facts (actual bounded schema)
  let factsReportFailureOrPending = false
  if (facts?.task?.assignmentReport) {
    const reportState = facts.task.assignmentReport.state
    const reportSummary = facts.task.assignmentReport.summary ?? ''
    if (reportState === 'waiting' || reportState === 'failed' || reportState === 'blocked') {
      factsReportFailureOrPending = true
    } else if (/\b(?:build\s+failed|tests?\s+pending|failed|failure|error|unverified)\b/i.test(reportSummary)) {
      factsReportFailureOrPending = true
    }
  }

  if (Array.isArray(facts?.finding?.reports) && facts.finding.reports.length > 0) {
    const reports = [...facts.finding.reports]
    const hasTimestamps = reports.every((r: any) => r.at && Number.isFinite(Date.parse(r.at)))
    if (hasTimestamps) {
      reports.sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at))
    }
    const latest = reports[reports.length - 1]
    if (latest && (latest.state === 'failed' || latest.state === 'waiting' || latest.state === 'blocked' || latest.state === 'pending')) {
      factsReportFailureOrPending = true
    }
    const lastReadyIndex = reports.findLastIndex((r: any) => r.state === 'ready' || r.state === 'verified')
    const lastFailedIndex = reports.findLastIndex((r: any) => r.state === 'failed' || r.state === 'waiting' || r.state === 'blocked' || r.state === 'pending')
    if (lastFailedIndex > lastReadyIndex) {
      factsReportFailureOrPending = true
    }
  }

  const hasNewerFailureOrPending = overrides.hasNewerFailureOrPending
    ?? (factsReportFailureOrPending ? true : undefined)
    ?? (/\bnewer failure or pending\b/i.test(text)
      || /\bnewer failure\/pending signals override\b/i.test(text)
      || /\bprevious ready evidence is not current\b/i.test(text))

  const hasNestedProviderEvidence = overrides.hasNestedProviderEvidence
    ?? (/\bzero outer tool calls means nested-provider coverage unknown\b/i.test(text)
      || /\bnested-provider evidence\b/i.test(text))

  // Facts use delivery.scopeBound/missingBinding and finding.currentJob, not invented scopeBinding.bound/missing
  const deliveryScopeBound = overrides.deliveryScopeBound
    ?? (typeof facts?.delivery?.scopeBound === 'boolean'
      ? facts.delivery.scopeBound
      : (facts?.delivery?.scopeBinding
        ? facts.delivery.scopeBinding.bound
        : (/\bUNBOUND DELIVERY GATE\b/i.test(text) || /\bblocked on missing scope binding inputs\b/i.test(text) ? false : undefined)))

  const deliveryMissingBinding = overrides.deliveryMissingBinding
    ?? (typeof facts?.delivery?.missingBinding === 'string'
      ? facts.delivery.missingBinding
      : (Array.isArray(facts?.delivery?.missingBinding)
        ? facts.delivery.missingBinding.join(', ')
        : (facts?.delivery?.scopeBinding?.missing
          ? facts.delivery.scopeBinding.missing.join(', ')
          : text.match(/missing scope binding inputs \(([^)]+)\)/i)?.[1])))

  const taskTitle = overrides.taskTitle ?? facts?.task?.title
  const taskScope = overrides.taskScope ?? facts?.task?.mandate?.scope ?? (
    text.match(/task scope:\s*([^\n.]+)/i)?.[1]
  )

  const currentJob = facts?.finding?.currentJob ?? facts?.finding?.job
  const ticketId = overrides.ticketId ?? (facts?.task?.ended ? undefined : (currentJob?.ticketId ?? facts?.task?.ticketId))

  return {
    taskTitle,
    taskScope,
    ticketId,
    findingId: overrides.findingId ?? facts?.finding?.id,
    findingState: overrides.findingState ?? facts?.finding?.state,
    findingBlocker: overrides.findingBlocker ?? facts?.finding?.blocker,
    isFindingResolved,
    deliveryId: overrides.deliveryId ?? facts?.delivery?.id,
    deliveryState: overrides.deliveryState ?? facts?.delivery?.state,
    deliveryScopeBound,
    deliveryMissingBinding,
    isDeliveryAccepted,
    isReadyUnreviewed,
    hasNewerFailureOrPending,
    hasNestedProviderEvidence,
    workflowContext: text,
  }
}

/**
 * Checks if a task scope or title explicitly prohibits an action (negative scope).
 */
function isScopeProhibiting(scopeText: string, regex: RegExp): boolean {
  const clauses = scopeText.split(/(?<=[.!?;\n])\s+|;\s*/)
  for (const clause of clauses) {
    if (regex.test(clause)) {
      if (/\b(?:do\s+not|never|no|without|prohibit\w*|bar\w*|avoid\w*|exclude\w*|not\s+to|before\s+anything\s+is)\b/i.test(clause)) {
        return true
      }
    }
  }
  return false
}

function isActionProhibitedByScope(context: OptionQualityContext, actionRegex: RegExp): boolean {
  const sources = [context.taskScope, context.taskTitle].filter(Boolean) as string[]
  for (const src of sources) {
    if (isScopeProhibiting(src, actionRegex)) return true
  }
  return false
}

/**
 * Checks if an action is affirmatively authorized within approved task scope or title,
 * and not governed by an explicit prohibition clause.
 */
function isAuthorizedInScope(context: OptionQualityContext, regex: RegExp): boolean {
  const sources = [context.taskScope, context.taskTitle].filter(Boolean) as string[]
  for (const src of sources) {
    if (regex.test(src)) {
      if (isScopeProhibiting(src, regex)) {
        return false
      }
      return true
    }
  }
  return false
}

/**
 * Checks if a statement is a truthful denial of a capability/API rather than claiming it exists.
 * Example: "There is no automatic dispatch API to Codex; explain the manual handoff."
 */
function isTruthfulCapabilityDenial(text: string): boolean {
  return /\b(?:no automated|no automatic|there is no automatic|not available|manually|manual handoff|explicitly dispatch|no notification route)\b/i.test(text)
}

/**
 * Evaluates a single decision option against current lifecycle, task scope, and capability standards.
 * Returns null if the option is valid, or an OptionQualityIssue if a defect is found.
 */
export function evaluateOptionQuality(
  option: { id?: string; label: string; prompt?: string; description?: string },
  context: OptionQualityContext = {},
): OptionQualityIssue | null {
  const id = option.id ?? 'unknown'
  const text = `${option.label}\n${option.prompt ?? ''}\n${option.description ?? ''}`.trim()

  // 1. Unsolicited Task Detour
  // Opening a new/separate finding for a native-tool gap when not requested
  if (/\b(?:draft|log|open|create|file)\b[^.\n]*?\b(?:separate|another)\b[^.\n]*?\b(?:finding|issue|ticket)\b/i.test(text)
    || /\b(?:native[- ]tool\s+gap|tool\s+gap)\b/i.test(text)) {
    // Check if describing a stale suggestion rather than commanding an action
    const isDescribingStaleSuggestion = /\b(?:suggestion\s+to\s+open|is\s+stale|superseded|no\s+reauthorization)\b/i.test(text)
    if (!isDescribingStaleSuggestion && !isAuthorizedInScope(context, /\b(?:native[- ]tool|tool\s+gap|new\s+(?:issue|finding|ticket)|separate\s+(?:issue|finding|ticket))\b/i)) {
      return {
        code: 'unrelated-task-detour',
        optionId: id,
        message: `Option "${option.label}" proposes an unsolicited task detour (opening a separate finding for a native-tool gap outside approved task scope).`,
      }
    }
  }

  // Prohibition violation: option attempts to execute filing/sending an issue when scope prohibits filing without review
  if (/\b(?:file|send|submit)\b[^.\n;]*?\b(?:issue|finding|ticket)\b/i.test(text)
    || /\b(?:file|send|submit)\s+it\b/i.test(text)) {
    const isOptionProhibiting = /\b(?:do\s+not|never|without|no)\b[^.\n;]*?\b(?:file|send|submit)\b/i.test(text)
    if (!isOptionProhibiting && isActionProhibitedByScope(context, /\b(?:file|send|submit)\b/i)) {
      return {
        code: 'unrelated-task-detour',
        optionId: id,
        message: `Option "${option.label}" proposes filing or submitting an issue when scope prohibits filing without review.`,
      }
    }
  }

  // Listing or querying unrelated blocked deliveries outside the approved task
  if (/\b(?:list|inspect|audit|check)\b[^.\n]*?\b(?:blocked|other|unrelated)\s+deliveries\b/i.test(text)
    || /\bdeliveries\s+blocked\s+on\s+missing\s+operator-confirmed\s+scope\b/i.test(text)
    || /\bauto-[0-9a-f]{8}\b/i.test(text)) {
    if (!isAuthorizedInScope(context, /\b(?:blocked\s+deliveries|auto-[0-9a-f]{8})\b/i)) {
      return {
        code: 'unrelated-task-detour',
        optionId: id,
        message: `Option "${option.label}" proposes querying or listing unrelated blocked deliveries outside the approved task scope.`,
      }
    }
  }

  // 2. Stale Completed Work
  // Ordering repeat tests, verification, or reopening on completed/resolved findings
  if (context.isFindingResolved || context.isDeliveryAccepted) {
    const repeatPattern = /\b(?:(?:re-?run|repeat)\b[^.\n;]*?\b(?:tests?|verification|checks?)|reopen\b[^.\n;]*?\bfinding|retry\b[^.\n;]*?\bticket)\b/i
    if (repeatPattern.test(text)) {
      const clauses = text.split(/(?<=[.!?;\n])\s+|;\s*/)
      let hasUnprohibitedRepeat = false
      for (const clause of clauses) {
        if (repeatPattern.test(clause)) {
          const isProhibited = /\b(?:do\s+not|never)\b[^.\n;]*?\b(?:re-?run|repeat|reopen|retry)\b/i.test(clause)
            || /\bwithout\b[^.\n;]*?\b(?:repeating|re-?running|reopening|retrying)\b/i.test(clause)
            || /\bno\s+(?:further\s+)?(?:re-?run|repeat|reopening|retry|verification|tests?|action)\b/i.test(clause)
            || /\b(?:stop\s+here\s+and\s+take\s+no|no\s+further\s+(?:implementation|tests?|verification|review|action))\b/i.test(clause)
            || /\b(?:no\s+reauthorization\s+or\s+retry\s+is\s+required)\b/i.test(clause)
          if (!isProhibited) {
            hasUnprohibitedRepeat = true
            break
          }
        }
      }
      if (hasUnprohibitedRepeat) {
        return {
          code: 'stale-completed-work',
          optionId: id,
          message: `Option "${option.label}" directs repeating verification or reopening a finding on already resolved/accepted scope.`,
        }
      }
    }
  }

  // 3. Worker Self-Review
  // The worker cannot independently review, accept, merge, or deploy its own candidate
  const selfReviewPattern = /\b(?:worker|you|implementer|self)\b[^.\n]*?\b(?:review|accept|merge|deploy)\b[^.\n]*?\b(?:candidate|patch|work)\b/i
  if ((selfReviewPattern.test(text) || /\bindependently\s+review\s+(?:your|its|own)\s+candidate\b/i.test(text) || /\bself-review\b/i.test(text))
    && !/\b(?:cannot|must\s+not|do\s+not|never)\b[^.\n]*?\b(?:review|accept|merge|deploy)\b/i.test(text)) {
    return {
      code: 'worker-self-review',
      optionId: id,
      message: `Option "${option.label}" advises worker self-review or self-acceptance; coordinator owns independent review and release.`,
    }
  }

  // 4. Fictional Dispatch
  // Claiming an automatic dispatch API / notification API exists to call Codex
  const fictionalDispatchPattern = /\b(?:call\s+(?:the\s+)?(?:notification|dispatch)\s+api|prompt\s+(?:automatically\s+)?(?:notifies|invokes|dispatches)\s+codex|automatically\s+dispatch\s+to\s+codex)\b/i
  if (fictionalDispatchPattern.test(text) && !isTruthfulCapabilityDenial(text)) {
    return {
      code: 'fictional-dispatch',
      optionId: id,
      message: `Option "${option.label}" claims a fictional automated notification or dispatch API to Codex; handoff must be stated manually.`,
    }
  }

  // 5. Blanket Rerun (ignoring nested-provider evidence)
  // Demanding a blanket rerun of full test suites/tsc/tsdown based solely on zero outer tool calls
  if (/\b(?:0|zero)\s+tool\s+calls\b[^.\n]*?\b(?:re-?run|run\s+tsc\s+--noEmit,\s*the\s+build\s+and\s+the\s+full\s+test\s+suite)\b/i.test(text)
    || (/\brun\s+tsc\s+--noEmit,\s*the\s+build\s+and\s+the\s+full\s+test\s+suite\b/i.test(text) && /\b0\s+tool\s+calls\b/i.test(text))) {
    return {
      code: 'blanket-rerun',
      optionId: id,
      message: `Option "${option.label}" requests a blanket full-suite rerun ignoring nested-provider evidence instead of targeted missing checks.`,
    }
  }

  // 6. Unbound Delivery Bypass
  // Proposing publication, deployment, or acceptance when delivery is unbound
  if (context.deliveryScopeBound === false) {
    const bypassPattern = /\b(?:publish|deploy|accept|merge)\b[^.\n]*?\b(?:candidate|delivery)\b/i
    if (bypassPattern.test(text) && !/\b(?:do\s+not|never|cannot|must\s+not)\b[^.\n]*?\b(?:publish|deploy|accept|merge)\b/i.test(text)) {
      return {
        code: 'unbound-delivery-bypass',
        optionId: id,
        message: `Option "${option.label}" suggests publication, deployment, or acceptance for an unbound delivery lacking confirmed scope binding.`,
      }
    }
  }

  // 7. False Verification Claim
  // Claiming pass/verification when newer evidence records failure or pending tests
  if (context.hasNewerFailureOrPending) {
    if (/\b(?:tests\s+passed|verification\s+complete|ready\s+for\s+acceptance)\b/i.test(text)
      && !/\b(?:do\s+not|not|unverified)\b/i.test(text)) {
      return {
        code: 'false-verification-claim',
        optionId: id,
        message: `Option "${option.label}" claims verification completion when newer reports indicate test failure or pending investigation.`,
      }
    }
  }

  return null
}

/**
 * Audits an entire option set, checking every choice for quality defects and uniqueness.
 */
export function auditOptionSet(
  choices: readonly (DecisionChoice | AdviceOption)[],
  context: OptionQualityContext = {},
): OptionAuditResult {
  const issues: OptionQualityIssue[] = []
  const invalidIds = new Set<string>()

  for (const choice of choices) {
    const issue = evaluateOptionQuality(choice, context)
    if (issue) {
      issues.push(issue)
      invalidIds.add(choice.id)
    }
  }

  // Check for duplicate choices within the set
  const seenLabels = new Set<string>()
  for (const choice of choices) {
    const norm = choice.label.trim().toLowerCase()
    if (seenLabels.has(norm)) {
      issues.push({
        code: 'duplicate-choice',
        optionId: choice.id,
        message: `Option "${choice.label}" is a duplicate of another choice in the set.`,
      })
      invalidIds.add(choice.id)
    }
    seenLabels.add(norm)
  }

  return {
    valid: issues.length === 0,
    issues,
    validChoices: choices.filter(c => !invalidIds.has(c.id)),
    invalidChoices: choices.filter(c => invalidIds.has(c.id)),
  }
}

/**
 * Filters out invalid options and supplies high-quality in-scope alternatives when needed.
 * Does not invent tests in ordinary chats or inject pending choices into resolved scopes.
 */
export function filterQualityOptions(
  options: AdviceOption[],
  context: OptionQualityContext = {},
): AdviceOption[] {
  const audit = auditOptionSet(options, context)
  let clean = options.filter(opt => !audit.invalidChoices.some(bad => bad.id === opt.id))

  // If completed/resolved finding or accepted delivery with no new request:
  // "Accepted parent with no newer human request produces completion/history and no pending actionable advice"
  if (context.isFindingResolved || context.isDeliveryAccepted) {
    // If all options were invalid or none were supplied, return empty (no pending advice on completed scope)
    if (clean.length === 0) {
      return []
    }
    // If clean options exist (e.g. historical summaries/prohibitions), preserve them without injecting artificial filler
    return clean.slice(0, 4)
  }

  // If the recommended option was filtered out, reassign recommendation to the top clean choice
  if (!clean.some(opt => opt.recommended) && clean.length > 0) {
    clean[0] = { ...clean[0]!, recommended: true }
  }

  // If fewer than 2 valid options remain on active work, supplement with bounded in-scope alternatives
  if (clean.length < 2) {
    const existingIds = new Set(clean.map(o => o.id))

    if (context.isReadyUnreviewed) {
      if (!existingIds.has('next-audit-evidence')) {
        clean.push({
          id: 'next-audit-evidence',
          label: 'Audit saved evidence before review',
          prompt: 'Before coordinator review, inspect the saved logs and artifacts in checkpoint/. Confirm exact-head test evidence and that only authorized files were modified. Do not execute new test runs or make code changes.',
          why: 'Verify recorded candidate evidence before coordinator dispatch.',
          recommended: clean.length === 0,
        })
      }
      if (clean.length < 2 && !existingIds.has('next-diff-check')) {
        clean.push({
          id: 'next-diff-check',
          label: 'Targeted diff scope check',
          prompt: 'Read-only: review the diff of the isolated candidate against the finding scope. Confirm it touches only authorized paths, contains no credentials or permissions changes, and does not alter the release pipeline. Do not edit, merge, or deploy.',
          why: 'Verify candidate diff is strictly bounded to finding scope.',
          recommended: false,
        })
      }
    } else if (context.deliveryScopeBound === false) {
      if (!existingIds.has('next-gather-scope')) {
        clean.push({
          id: 'next-gather-scope',
          label: 'Identify missing scope binding inputs',
          prompt: `Read-only: identify the exact missing scope binding inputs (${context.deliveryMissingBinding || 'source issue, target repository, base/head SHA, or acceptance criteria'}) and which responsible human owner or evidence-gatherer can provide them. Do not publish, deploy, or accept.`,
          why: 'Gather required missing inputs for unbound delivery gate without bypassing approval.',
          recommended: clean.length === 0,
        })
      }
    } else {
      // Ordinary conversation: offer conversational next step, do not invent fake tests/work
      if (!existingIds.has('next-clarify-step')) {
        clean.push({
          id: 'next-clarify-step',
          label: 'Clarify next step with user',
          prompt: 'Summarize the current discussion and ask the user for specific instructions on how they would like to proceed.',
          why: 'Advance the conversation naturally without inventing unauthorized tasks or tests.',
          recommended: clean.length === 0,
        })
      }
    }
  }

  // Ensure exactly one recommended option
  if (clean.length > 0) {
    if (!clean.some(o => o.recommended)) {
      clean[0] = { ...clean[0]!, recommended: true }
    } else if (clean.filter(o => o.recommended).length > 1) {
      let seenRecommended = false
      clean = clean.map(o => {
        if (o.recommended) {
          if (!seenRecommended) {
            seenRecommended = true
            return o
          }
          return { ...o, recommended: false }
        }
        return o
      })
    }
  }

  return clean.slice(0, 4)
}
