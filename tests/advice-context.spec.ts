import { expect, it } from 'vitest'
import { adviceContext } from '../src/app/advice-context.ts'
import type { Ticket } from '../src/core/model.ts'
import type { Delivery } from '../src/app/feature-delivery.ts'

const ticket = { title: 'Cost summary', mandate: { strength: 'explicit', scope: 'Prepare a tested artifact. Worker must not publish.' },
  assignments: [{ report: { state: 'ready', at: 'before-later-turn', summary: 'Artifact ready for review' } }] } as Ticket
const delivery = { id: 'd', revision: 3, stage: 'review', state: 'blocked', scopeBinding: { reason: 'Target unbound' },
  bindings: { repository: 'org/source', sourceIssue: 190, headSha: '', baseSha: '' }, requirements: ['intake:acceptance-requirements-unconfirmed'], evidence: [], workers: [] } as unknown as Delivery
it('keeps the verified-release objective and transfers ownership without granting publication', () => {
  const context = adviceContext(ticket, delivery)
  expect(context).toContain('publication and live verification')
  expect(context).toContain('Every release-package instruction must keep PR-body text outside')
  expect(context).toContain('check the current target head')
  expect(context).toContain('A requested handoff does not clear a scope/approval blocker')
  expect(context).toContain('Worker must not publish')
  expect(context).toContain('finish its whole permitted release package')
  expect(context).toContain('"offeredAction":null')
  expect(context).toContain('"scopeBound":false')
  expect(context).not.toContain('Recommend review and release preparation.')
})
it('marks lagging assignment reports and does not infer verified state from ready prose', () => {
  const context = adviceContext(ticket, delivery)
  expect(context).toContain('may predate later direct conversation turns')
  expect(context).toContain('Do not restart a completed review')
  expect(context).toContain('"accepted":false')
  expect(context).toContain('Unrecorded revisions, checks, capabilities and acceptance are UNKNOWN')
})
it('reports only current offered protected actions and pins evidence to its own head', () => {
  const bound = { ...delivery, scopeBinding: undefined, state: 'awaiting_decision', nextAction: { revision: 3, kind: 'publish', label: 'Publish exact candidate' },
    bindings: { ...delivery.bindings, headSha: 'new-head' }, evidence: [{ kind: 'review', outcome: 'passed', bindings: { headSha: 'old-head' }, recordedAt: 'then' }] } as Delivery
  expect(adviceContext(ticket, bound)).toContain('"kind":"publish"')
  expect(adviceContext(ticket, bound)).toContain('"headSha":"old-head"')
  expect(adviceContext(ticket, { ...bound, nextAction: { ...bound.nextAction!, revision: 2 } })).toContain('"offeredAction":null')
  expect(adviceContext(ticket, { ...bound, state: 'blocked' })).toContain('"offeredAction":null')
})
it('does not force releases on ordinary conversations or include unrelated ticket fields', () => {
  expect(adviceContext()).not.toContain('RELEASE OBJECTIVE:')
  expect(adviceContext()).toContain('ordinary conversation')
  expect(adviceContext({ ...ticket, privateCredential: 'SENSITIVE' } as Ticket, delivery)).not.toContain('SENSITIVE')
})

it('bounds projected source data without reading arbitrary extra fields', () => {
  const long = 'x'.repeat(20000)
  const context = adviceContext({ ...ticket, title: long, mandate: { ...ticket.mandate, scope: long } }, { ...delivery, id: long, blocker: long,
    requirements: Array(100).fill(long), bindings: { ...delivery.bindings, repository: long, headSha: long, baseSha: long, environment: long, refs: Array(100).fill({ repository: long, headSha: long, pr: 1 }) },
    evidence: Array(100).fill({ kind: 'review', outcome: 'passed', bindings: { headSha: long }, recordedAt: long }) })
  expect(context.length).toBeLessThan(12000)
})

it('carries the bounded server-derived prepared-publication proof and separates source, artifact and target', () => {
  const prepared = { id: 'manifest', ticketId: 'worker', decisionId: 'decision', repository: 'org/sandbox', pr: 191, headSha: 'c'.repeat(40),
    patchSha256: 'd'.repeat(64), environment: 'dsh@127.0.0.1:3082', preparedAt: '2026-11-07T16:05:47.972Z', scopeSha256: 'e'.repeat(64),
    components: ['dsh-superagent'], effects: ['Restart the exact existing profile'], refs: [{ repository: 'org/sandbox', pr: 191, headSha: 'c'.repeat(40), baseSha: 'a'.repeat(40) },
      { repository: 'org/prototype', pr: 45, headSha: 'b'.repeat(40), baseSha: 'f'.repeat(40) }],
    proof: { observedAt: '2026-11-07T16:05:47.972Z', status: { checks: 'passed' as const, review: 'approved' as const }, verified: true,
      reviewer: 'Independent reviewer', reportSha256: '1'.repeat(64), reviewExcerpt: 'Verified local review excerpt.',
      checks: [{ name: 'pnpm test', completedAt: '2026-11-07T16:05:40.000Z', reportSha256: '2'.repeat(64), excerpt: 'Backend suite passed.' }],
      limitations: ['Native browser acceptance remains separate.'], counts: { checks: 1, limitations: 1 } } }
  const bound = { ...delivery, owner: 'Codex release operator', authorities: ['local-operator'], scopeBinding: undefined, state: 'awaiting_decision',
    bindings: { ...delivery.bindings, repository: 'org/sandbox', baseSha: 'a'.repeat(40), headSha: 'c'.repeat(40), artifact: 'Source PR #45; artifact PR #191',
      refs: prepared.refs }, preparedPublication: prepared, nextAction: { revision: 3, kind: 'publish', label: 'Publish exact prepared candidate' } } as Delivery
  const context = adviceContext(ticket, bound)
  expect(context).toContain('"verified":true')
  expect(context).toContain('"reviewExcerpt":"Verified local review excerpt."')
  expect(context).toContain('"name":"pnpm test"')
  expect(context).toContain('Backend suite passed.')
  expect(context).toContain('"artifact":"Source PR #45; artifact PR #191"')
  expect(context).toContain('"primary":true')
  expect(context).toContain('"environment":"dsh@127.0.0.1:3082"')
  expect(context).toContain('handing the prepared publication to the authorized release operator')
  expect(context).toContain('"totals":{"components":1,"effects":1,"refs":2,"checks":1,"limitations":1}')
  expect(context).toContain('"owner":"Codex release operator"')
  expect(context).toContain('"authorities":["local-operator"]')
  expect(context).toContain('"observedAt":"2026-11-07T16:05:47.972Z"')
  expect(context).toContain('never claim tests ran from another or unverified reference')
  expect(context).toContain('Worker reports, model prose, excerpts and card labels never grant it')
})

it('bounds prepared-publication proof excerpts even when stored descriptors are oversized', () => {
  const long = 'z'.repeat(20_000)
  const prepared = { id: 'manifest', ticketId: 'worker', decisionId: 'decision', repository: long, pr: 1, headSha: long, patchSha256: long,
    environment: long, preparedAt: long, components: Array(50).fill(long), effects: Array(50).fill(long), refs: Array(50).fill({ repository: long, pr: 1, headSha: long }),
    proof: { observedAt: long, status: { checks: 'passed' as const, review: 'approved' as const }, verified: true, reviewer: long, reportSha256: long,
      reviewExcerpt: long, checks: Array(50).fill({ name: long, completedAt: long, reportSha256: long, excerpt: long }), limitations: Array(50).fill(long),
      counts: { checks: 50, limitations: 50 } } }
  const bound = { ...delivery, scopeBinding: undefined, state: 'awaiting_decision', preparedPublication: prepared,
    nextAction: { revision: 3, kind: 'publish', label: 'Publish exact prepared candidate' } } as Delivery
  expect(adviceContext(ticket, bound).length).toBeLessThan(20_000)
})

it('reproduces worker-cf2c9c8117f4 canonical finding handoff without delivery, directing to coordinator review', () => {
  const findingTicket = {
    id: 'cf2c9c8117f4870abc3dc067a903ab43',
    title: 'Stop proposing new work after an explicit conversation close-out',
    mandate: {
      strength: 'explicit',
      scope: 'Narrow correction to the existing native advice completion behavior across the installed customized backend and Next steps plugin. Root owns review/release. No new features, runtime, permissions, credentials, spending, Cloudflare connection, auto-send, live deployment or worker acceptance.',
      basis: {
        via: 'addressed',
        addressed: 'direct',
        source: 'finding',
        sender: 'local-operator',
        scope: { repository: 'gera3d/superagent-sandbox', findingId: 'e6d9e1da-9c21-494a-b418-35afdbe02a9a', jobId: 'finding:e6d9e1da-9c21-494a-b418-35afdbe02a9a:r4', bounded: true },
      },
    },
    assignments: [{
      report: {
        state: 'waiting',
        at: '2026-11-08T15:42:20.717Z',
        summary: 'Round-3 correction complete. Checkpoint patches generated in checkpoint/. NEXT: Root operator review of the linked patches in checkpoint/ to decide final release acceptance.',
      },
    }],
  } as unknown as Ticket

  const findingRecord = {
    id: 'e6d9e1da-9c21-494a-b418-35afdbe02a9a',
    dedupKey: 'explicit-chat-completion-must-not-propose-new-scope-v1',
    revision: 5,
    state: 'running',
    title: 'Stop proposing new work after an explicit conversation close-out',
    scope: 'Narrow correction to native advice completion behavior',
    owner: 'Codex release coordinator; Harness execution worker',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    job: { id: 'finding:e6d9e1da-9c21-494a-b418-35afdbe02a9a:r4', ticketId: 'cf2c9c8117f4870abc3dc067a903ab43', assignmentId: '55659d5ad22cc213a5be94aba0419bff' },
    reports: [{
      state: 'evidence',
      at: '2026-11-08T15:42:20.717Z',
      jobId: 'finding:e6d9e1da-9c21-494a-b418-35afdbe02a9a:r4',
      reference: 'checkpoint/05-backend-conditional-closeout-fix.patch',
      nextDecision: 'Await root operator review of the linked patches in checkpoint/',
    }],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(findingTicket, undefined, undefined, findingRecord)
  expect(context).toContain('CANONICAL FINDING REVIEW OBJECTIVE:')
  expect(context).toContain('The implementation worker has reported a candidate ready for independent review')
  expect(context).toContain('Readiness is not proof that tests ran or passed')
  expect(context).toContain('independent review and release by the authorized coordinator (Codex release coordinator / Root operator')
  expect(context).toContain('Do not default to user patch walkthrough, duplicate implementation or test runs, or unconditional accept/deploy')
  expect(context).toContain('The implementation worker cannot independently review, accept, merge or deploy its own candidate')
  expect(context).toContain('no automated notification route to Codex is configured; state the handoff to the coordinator explicitly')
  expect(context).toContain('"isCurrentJob":true')
  expect(context).toContain('"isPriorJob":false')
  expect(context).not.toContain('do not impose a release workflow on an ordinary conversation')
  expect(context).not.toContain('RELEASE OBJECTIVE:')
})

it('distinguishes current versus prior assignment for finding jobs', () => {
  const priorTicket = {
    id: 'e2b1dddc51f78965de0aa8cfd6aad40a',
    title: 'Prior job ticket',
    mandate: { strength: 'explicit', scope: 'Old scope' },
    assignments: [{ report: { state: 'ready', at: 'earlier', summary: 'Old candidate' } }],
  } as unknown as Ticket

  const findingWithPriors = {
    id: 'e6d9e1da-9c21-494a-b418-35afdbe02a9a',
    revision: 5,
    state: 'running',
    title: 'Stop proposing new work',
    owner: 'Codex release coordinator; Harness execution worker',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    job: { id: 'finding:e6d9e1da-9c21-494a-b418-35afdbe02a9a:r4', ticketId: 'cf2c9c8117f4870abc3dc067a903ab43' },
    priorJobs: [{ id: 'finding:e6d9e1da-9c21-494a-b418-35afdbe02a9a:r1', ticketId: 'e2b1dddc51f78965de0aa8cfd6aad40a' }],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(priorTicket, undefined, undefined, findingWithPriors)
  expect(context).toContain('STALE PRIOR ASSIGNMENT:')
  expect(context).toContain('Do not recommend implementation, review or release actions based on stale prior assignment state')
  expect(context).toContain('"isCurrentJob":false')
  expect(context).toContain('"isPriorJob":true')
})

it('states completion plainly for resolved findings without repeat recommendations', () => {
  const ticket = {
    id: 'ticket-1',
    title: 'Resolved task',
    mandate: { strength: 'explicit', scope: 'Fix something' },
    assignments: [],
  } as unknown as Ticket

  const resolvedFinding = {
    id: 'finding-1',
    revision: 6,
    state: 'resolved',
    title: 'Resolved defect',
    owner: 'team',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    job: { id: 'finding-1:r5', ticketId: 'ticket-1' },
    resolution: { outcome: 'verified', at: '2026-11-08T16:00:00.000Z', actor: 'local-operator', jobId: 'finding-1:r5' },
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(ticket, undefined, undefined, resolvedFinding)
  expect(context).toContain('FINDING RESOLVED: this finding is already verified and resolved')
  expect(context).toContain('Do not recommend repeating implementation, tests, review, or reopening')
  expect(context).toContain('State completion plainly')
  expect(context).toContain('"resolution":{"outcome":"verified"')
})

it('proves changing the actual Characters UI-backed setting changes the effective persona and context', async () => {
  const { effectiveAdvisorCharacter } = await import('../src/app/settings.ts')
  const settings = {
    characters: {
      items: [
        {
          id: 'senior-developer',
          name: 'Custom Reviewer',
          specialty: 'High-Integrity Verification',
          brief: 'Enforces strict test proofs and verifies candidate boundaries before handoff.',
          tools: ['vitest', 'git diff'],
          mode: 'suggest' as const,
          enabled: true,
        },
      ],
      activeCharacterId: 'senior-developer',
      defaultCharacterId: 'senior_developer',
      characters: [
        {
          id: 'senior_developer',
          name: 'Old Senior Developer',
          specialty: 'Old Specialty',
          brief: 'Old Brief',
          standards: ['Never deploy without tests'],
          permissionToDisagree: true,
          inclinedTools: ['vitest'],
          mode: 'suggest_only' as const,
          apiKeyEnv: '',
          enabled: true,
        },
      ],
    },
  }

  const persona = effectiveAdvisorCharacter(settings)
  expect(persona.name).toBe('Custom Reviewer')
  expect(persona.specialty).toBe('High-Integrity Verification')
  expect(persona.brief).toContain('Enforces strict test proofs')

  const context = adviceContext(undefined, undefined, undefined, undefined, persona)
  expect(context).toContain('ADVISOR POLICY: You are Custom Reviewer, specialized in High-Integrity Verification')
  expect(context).toContain('Enforces strict test proofs and verifies candidate boundaries before handoff')
  expect(context).toContain('"advisor":{"name":"Custom Reviewer","specialty":"High-Integrity Verification"')
})

it('propagates custom brief from live settings shape through prepareSpecialist and helper-context', async () => {
  const { SettingsSchema, DEFAULT_CHARACTERS } = await import('../src/policy.ts')
  const { effectiveAdvisorCharacter } = await import('../src/app/settings.ts')
  const { seedProfiles } = await import('../src/core/specialist-profile.ts')
  const { prepareSpecialist } = await import('../src/app/specialist-advice.ts')

  const parsedSettings = JSON.parse(JSON.stringify(SettingsSchema.parse({})))
  const seniorItem = parsedSettings.characters.items.find((i: any) => i.id === 'senior-developer')!
  seniorItem.brief = 'AUDIT_MARKER_END_TO_END_CHARACTER_BRIEF'

  const persona = effectiveAdvisorCharacter(parsedSettings)

  expect(persona.brief).toContain('AUDIT_MARKER_END_TO_END_CHARACTER_BRIEF')

  const profiles = seedProfiles(persona)
  const prepared = prepareSpecialist({
    profiles,
    settings: parsedSettings as any,
    task: 'Review candidate diff and regression tests',
  })

  expect(prepared.status).toBe('prepared')
  if (prepared.status === 'prepared') {
    expect(prepared.system).toContain('AUDIT_MARKER_END_TO_END_CHARACTER_BRIEF')
  }
})

it('supports actual ended finding awaiting coordinator review without prohibiting review', () => {
  const endedTicket = {
    id: 'ticket-ended-1',
    title: 'Recommend the actual review handoff for completed finding work',
    state: 'ended',
    stage: 'ended',
    ended: { at: '2026-11-08T19:29:49.861Z', by: 'human', outcome: 'stopped' },
    mandate: {
      strength: 'explicit',
      scope: 'Narrow shared advisor context correction for canonical finding-owned implementation jobs and native fallback.',
      basis: {
        via: 'addressed',
        addressed: 'direct',
        source: 'finding',
        sender: 'local-operator',
        scope: { repository: 'gera3d/superagent-sandbox', findingId: 'finding-ended-1', jobId: 'finding-ended-1:r1', bounded: true },
      },
    },
    assignments: [{
      id: 'assignment-ended-1',
      state: 'ended',
      report: { state: 'waiting', summary: 'Verification complete in isolated repo. Patches generated in checkpoint/.', at: '2026-11-08' },
    }],
  } as unknown as Ticket

  const blockedEndedFinding = {
    id: 'finding-ended-1',
    revision: 2,
    state: 'blocked',
    title: 'Recommend the actual review handoff for completed finding work',
    owner: 'Harness implementation worker; Codex reviewer and release coordinator',
    scope: 'Narrow shared advisor context correction',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    blocker: 'Assignment ended without a qualifying report; review/verification required: ticket/ticket-ended-1/report/assignment-ended-1. End, idle or merge is not resolution.',
    job: { id: 'finding-ended-1:r1', ticketId: 'ticket-ended-1', assignmentId: 'assignment-ended-1' },
    reports: [{
      state: 'evidence',
      at: '2026-11-08T19:19:32.230Z',
      jobId: 'finding-ended-1:r1',
      reference: 'ticket/ticket-ended-1/report/assignment-ended-1',
      nextDecision: 'Await root operator review',
    }],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(endedTicket, undefined, undefined, blockedEndedFinding)
  expect(context).toContain('CANONICAL FINDING REVIEW OBJECTIVE:')
  expect(context).toContain('coordinator')
  expect(context).not.toContain('do not recommend proceeding with review')
  expect(context).not.toContain('FINDING BLOCKED: active work on this finding is currently blocked.')
})

it('prohibits proceeding with review when an active finding has a true implementation blocker', () => {
  const activeTicket = {
    id: 'ticket-active-blocker',
    title: 'Fix issue',
    state: 'running',
    stage: 'running',
    mandate: {
      strength: 'explicit',
      scope: 'Fix issue',
      basis: {
        via: 'addressed',
        source: 'finding',
        scope: { findingId: 'finding-blocker-1', jobId: 'finding-blocker-1:r1' },
      },
    },
    assignments: [{
      id: 'assignment-active',
      state: 'running',
      report: { state: 'blocked', summary: 'Compiler crashed due to missing glibc', at: '2026-11-08' },
    }],
  } as unknown as Ticket

  const blockedFinding = {
    id: 'finding-blocker-1',
    revision: 1,
    state: 'blocked',
    title: 'Fix issue',
    owner: 'Harness worker',
    scope: 'Fix issue',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    blocker: 'Compiler crashed due to missing glibc in worker sandbox environment',
    job: { id: 'finding-blocker-1:r1', ticketId: 'ticket-active-blocker', assignmentId: 'assignment-active' },
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(activeTicket, undefined, undefined, blockedFinding)
  expect(context).toContain('FINDING BLOCKED: active work on this finding is currently blocked.')
  expect(context).toContain('Address the recorded blocker; do not recommend proceeding with review or deployment until the blocker is resolved.')
  expect(context).not.toContain('CANONICAL FINDING REVIEW OBJECTIVE:')
})

it('does not claim testing complete when worker report is waiting and tests have not run', () => {
  const waitingTicket = {
    id: 'ticket-waiting-1',
    title: 'Investigate problem',
    state: 'running',
    stage: 'running',
    mandate: {
      strength: 'explicit',
      scope: 'Investigate problem',
      basis: {
        via: 'addressed',
        source: 'finding',
        scope: { findingId: 'finding-waiting-1', jobId: 'finding-waiting-1:r1' },
      },
    },
    assignments: [{
      id: 'assignment-waiting-1',
      state: 'running',
      report: { state: 'waiting', summary: 'Still investigating; tests have not run', at: '2026-11-08' },
    }],
  } as unknown as Ticket

  const runningFinding = {
    id: 'finding-waiting-1',
    revision: 1,
    state: 'running',
    title: 'Investigate problem',
    owner: 'Harness worker; Codex coordinator',
    scope: 'Investigate problem',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    job: { id: 'finding-waiting-1:r1', ticketId: 'ticket-waiting-1', assignmentId: 'assignment-waiting-1' },
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(waitingTicket, undefined, undefined, runningFinding)
  expect(context).toContain('CANONICAL FINDING OBJECTIVE: complete the authorized finding implementation and verification in an isolated worktree.')
  expect(context).not.toContain('has reported candidate testing complete')
  expect(context).not.toContain('CANONICAL FINDING REVIEW OBJECTIVE:')
})

it('reflects actual Google nested evidence and treats zero outer tool calls as unknown coverage rather than absent tests', () => {
  const nestedUsageTicket = {
    id: 'ticket-nested-1',
    title: 'Google nested provider ticket',
    state: 'ended',
    stage: 'ended',
    ended: { at: '2026-11-08T19:29:49.861Z', by: 'human', outcome: 'stopped' },
    mandate: {
      strength: 'explicit',
      scope: 'Fix issue',
      basis: {
        via: 'addressed',
        source: 'finding',
        scope: { findingId: 'finding-nested-1', jobId: 'finding-nested-1:r1' },
      },
    },
    usage: {
      sessionId: 'worker-nested-1',
      routes: [{ provider: 'antigravity', model: 'gemini-3.8-flash', attempts: 1 }],
      totals: { uncachedInputTokens: 2453, outputTokens: 1160, totalTokens: 176068, cacheReadTokens: 172455 },
      coverage: { attempts: 1, reported: 1, cacheRead: 'exact' as const, cacheWrite: 'unreported' as const, attribution: 'complete' as const },
    },
    assignments: [{
      id: 'assignment-nested-1',
      state: 'ended',
      report: { state: 'waiting', summary: 'Candidate implemented. Sequential vitest suites passed.', at: '2026-11-08' },
    }],
  } as unknown as Ticket

  const findingWithReports = {
    id: 'finding-nested-1',
    revision: 1,
    state: 'blocked',
    title: 'Fix issue',
    owner: 'Harness worker; Codex coordinator',
    scope: 'Fix issue',
    kind: 'fix',
    repository: 'gera3d/superagent-sandbox',
    blocker: 'Assignment ended without a qualifying report; review/verification required: ticket/ticket-nested-1/report/assignment-nested-1. End, idle or merge is not resolution.',
    job: { id: 'finding-nested-1:r1', ticketId: 'ticket-nested-1', assignmentId: 'assignment-nested-1' },
    reports: [{
      state: 'evidence',
      at: '2026-11-08T19:19:32.230Z',
      jobId: 'finding-nested-1:r1',
      reference: 'ticket/ticket-nested-1/report/assignment-nested-1',
      nextDecision: 'Await root operator review',
    }],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(nestedUsageTicket, undefined, undefined, findingWithReports)
  expect(context).toContain('"provider":"antigravity"')
  expect(context).toContain('"model":"gemini-3.8-flash"')
  expect(context).toContain('"attribution":"complete"')
  expect(context).toContain('Evidence semantics: zero outer tool calls means nested-provider coverage unknown, not tests absent.')
  expect(context).toContain('Check saved logs/artifacts and exact head before proposing targeted missing checks')
  expect(context).toContain('no reflexive full reruns or fictional dispatch')
})

it('does not treat an unverified current progress evidence row as completed testing (negative fixture)', () => {
  const ticket = {
    id: 'ticket-unverified-1',
    title: 'Advisor repair',
    mandate: { strength: 'explicit', scope: 'Bounded implementation. Codex reviews.' },
    assignments: [{
      id: 'assignment-unverified-1',
      state: 'working',
      report: { state: 'waiting', at: '2026-11-08T23:00:00Z', summary: 'Build failed. Tests pending.' },
    }],
  } as unknown as Ticket

  const finding = {
    id: 'finding-unverified-1',
    revision: 1,
    state: 'running',
    title: 'Advisor repair',
    owner: 'Codex',
    scope: 'Bounded repair',
    kind: 'fix',
    repository: 'owner/repo',
    job: { id: 'job-unverified-1', ticketId: 'ticket-unverified-1', assignmentId: 'assignment-unverified-1' },
    reports: [{
      state: 'evidence',
      jobId: 'job-unverified-1',
      at: '2026-11-08T23:00:00Z',
      reference: 'ticket/ticket-unverified-1/report/assignment-unverified-1',
      evidence: 'Unverified progress only',
      nextDecision: 'Wait',
    }],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(ticket, undefined, undefined, finding)
  expect(context).not.toContain('has reported candidate testing complete')
  expect(context).toContain('CANONICAL FINDING OBJECTIVE: complete the authorized finding implementation and verification in an isolated worktree.')
})

it('supersedes older ready evidence when a newer report indicates build failure or pending tests', () => {
  const ticket = {
    id: 'ticket-superseded-ready',
    title: 'Advisor repair',
    state: 'ended',
    stage: 'ended',
    ended: { at: '2026-11-08T23:30:00Z', by: 'human', outcome: 'stopped' },
    mandate: { strength: 'explicit', scope: 'Bounded implementation. Codex reviews.' },
    assignments: [{
      id: 'assignment-superseded',
      state: 'ended',
      report: { state: 'waiting', at: '2026-11-08T23:20:00Z', summary: 'Build failed. Tests pending in second test cycle.' },
    }],
  } as unknown as Ticket

  const finding = {
    id: 'finding-superseded',
    revision: 3,
    state: 'blocked',
    blocker: 'Assignment ended without a qualifying report; review/verification required: ticket/ticket-superseded-ready/report/assignment-superseded. End, idle or merge is not resolution.',
    title: 'Advisor repair',
    owner: 'Codex reviewer and release coordinator / root operator',
    scope: 'Bounded repair',
    kind: 'fix',
    repository: 'owner/repo',
    job: { id: 'job-superseded', ticketId: 'ticket-superseded-ready', assignmentId: 'assignment-superseded' },
    reports: [
      {
        state: 'ready',
        jobId: 'job-superseded',
        at: '2026-11-08T22:00:00Z',
        reference: 'checkpoint/01-old-pass.patch',
        evidence: 'Earlier test suite passed 90 tests',
        nextDecision: 'Review old candidate',
      },
      {
        state: 'evidence',
        jobId: 'job-superseded',
        at: '2026-11-08T23:20:00Z',
        reference: 'ticket/ticket-superseded-ready/report/assignment-superseded',
        evidence: 'Native review/correction is in progress; previous ready evidence is not current. Build failed.',
        nextDecision: 'Wait',
      },
    ],
  } as unknown as import('../src/app/finding.ts').Finding

  const context = adviceContext(ticket, undefined, undefined, finding)
  expect(context).not.toContain('has reported candidate testing complete')
  expect(context).toContain('CANONICAL FINDING REVIEW OBJECTIVE: advance candidate evidence to actual coordinator review and release verification.')
  expect(context).toContain('candidate evidence is awaiting independent review and release by the authorized coordinator')
})
it('names the configured native finding control instead of a manual Codex handoff, without granting publish', () => {
  const t = { ...ticket, id: 'current', ended: { by: 'executor', outcome: 'ready' }, assignments: [{ id: 'a', state: 'ended', report: { state: 'ready', at: '2026-11-10T00:00:00Z', summary: 'Candidate ready' } }] } as unknown as Ticket
  const f = { id: 'f', revision: 2, state: 'blocked', title: 'Feature', scope: 'Existing feature', owner: 'Harness', kind: 'fix', requirements: ['works'], repository: 'org/source', job: { id: 'j', ticketId: 'current', assignmentId: 'a' }, reports: [{ jobId: 'j', state: 'ready', at: '2026-11-10T00:00:00Z', reference: 'ticket/current/report/a', evidence: 'candidate', nextDecision: 'review' }] } as unknown as import('../src/app/finding.ts').Finding
  const context = adviceContext(t, undefined, undefined, f, undefined, { findingRelease: true })
  expect(context).toContain('NATIVE FINDING RELEASE OBJECTIVE')
  expect(context).toContain('Review, test & prepare release')
  expect(context).toContain('"nativeFindingRelease":true')
  expect(context).toContain('Publishing and final live acceptance remain separate exact native confirmations')
  expect(context).not.toContain('Action capability distinction: no automated notification route to Codex is configured')
  expect(adviceContext(t, undefined, undefined, f)).not.toContain('NATIVE FINDING RELEASE OBJECTIVE')
  expect(adviceContext(t, undefined, undefined, { ...f, state: 'resolved' }, undefined, { findingRelease: true })).not.toContain('NATIVE FINDING RELEASE OBJECTIVE')
})
it('uses recorded delivery controls and ownership after native release handoff', () => {
  const d = { ...delivery, scopeBinding: undefined, release: { findingId: 'f', ticketId: 't' }, state: 'blocked', reconciliation: { label: 'Reconcile recorded handoff', revision: 3 } } as unknown as Delivery
  const context = adviceContext(ticket, d)
  expect(context).toContain('NATIVE DELIVERY RELEASE OBJECTIVE')
  expect(context).toContain('no user direction or duplicate job is needed')
  expect(context).toContain('"label":"Reconcile recorded handoff"')
  expect(context).not.toContain('requesting root / coordinator review')
})
