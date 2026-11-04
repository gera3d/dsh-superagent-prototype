# Model hierarchy and escalation

This document describes the deployment's model hierarchy: which models are starred, which route each job type starts on,
what makes a failed task escalate to a stronger model, how each escalation is recorded, and where the number of escalations
is capped. It builds on [003 Execution](003-execution.md) and [006 Deployment](006-deployment.md).

## The hierarchy

The deployment's most-used models, cheapest first, are:

| Route | Provider | Model | Why it is here |
| --- | --- | --- | --- |
| 1 | `antigravity` | `gemini-3.8-flash` | Plenty of quota; starts every task. |
| 2 | `openai-codex` | `gpt-6.1-sol` | First escalation when the cheap model cannot finish. |
| 3 | `anthropic` | `claude-sonnet-5-5` | Last and strongest step. |

The order is the escalation order. A route may also name a `reasoningEffort`; two entries that differ only in effort are
different routes.

The routes come from the DSH provider list that the panel reads with `GET models`, but the settings store provider and model
identifiers, not catalog objects. Saving a route resolves it through the live provider (`ctx.llm.resolveCallConfig`), so a
typo or an unavailable provider refuses the save instead of failing at escalation time. No credential is stored in settings.

## Settings

The hierarchy is the `models` settings block:

```json
{
  "hierarchy": [
    { "provider": "antigravity", "model": "gemini-3.8-flash", "starred": true },
    { "provider": "openai-codex", "model": "gpt-6.1-sol", "starred": true },
    { "provider": "anthropic", "model": "claude-sonnet-5-5", "starred": true }
  ],
  "maxEscalations": 2
}
```

- **Starred models** are the entries with `"starred": true`. They are the deployment's most-used routes; the panel lists
  them for quick choice and keeps the hierarchy order explicit.
- **The default model per job type** stays in the existing settings blocks: `eval.model` for the Assessor (the main Session)
  and `executor.model` for the Executor (worker Sessions). When a block's model is empty, that job type starts on the first
  starred route, else the first hierarchy route. Empty everywhere leaves the DSH default in place.
- **`maxEscalations`** bounds how many stronger models one ticket may move through automatically. The default is `2`, which
  is exactly Gemini 3.8 Flash → GPT 6.1 Sol → Claude Sonnet 5.5. `0` disables automatic escalation.

The panel edits the hierarchy under **Settings → Execution**, beside the Executor model. The Assessor model remains under
**Settings → Eval**. Both blocks name their job type's starting route; the shared hierarchy and the cap have their own block
because both job types use the same starred list.

## Routing

For a ticket on the Executor job type, the route sequence is:

1. the route the `executor` block names, or the first starred route when it names none;
2. every hierarchy route after that one, in order;
3. no further route once the ticket's recorded escalations reach `maxEscalations`.

A configured starting route that is absent from the hierarchy starts an implicit chain: the whole hierarchy follows it.
This keeps a deployment working when it names a model outside the shared list.

The Assessor job type starts on `eval.model`, or the first starred route when unset. Assessments run in the main Session, so
they do not move along the hierarchy: a timed-out or failed assessment is a human/main-Session condition, not a ticket that
can be retried on another model with its worktree and history.

## What counts as failed or not good enough

Escalation is deliberately narrower than "anything went wrong":

- **Escalates:** a worker's `failed` report that carries no question for a person, arrives while no attention question is
  open, and is not marked by the Executor as non-escalatable. A `failed` report means the worker could not finish the
  assignment; a stronger model retries the same ticket, worktree and history.
- **Does not escalate:** `blocked` (a person must decide or grant access), `failed` with a question (a person must answer),
  `ready`, `progress`, `waiting` and `dropped`. The Executor marks its own launch, prepare, setup and provider failures
  non-escalatable: changing the model does not fix a missing directory, a broken prepare command, or an exhausted
  transient-retry budget. Provider failures that are passing are retried three times with backoff before any report, as
  [003 Execution](003-execution.md) describes.

A person can still retry any stalled ticket with the existing ticket retry, independently of this automatic path.

## Recording an escalation

Every escalation is durable on the ticket as `ticket.escalations`, oldest first:

```json
{
  "at": "2026-11-04T08:20:00.000Z",
  "fromAssignmentId": "…",
  "assignmentId": "…",
  "from": { "provider": "antigravity", "model": "gemini-3.8-flash" },
  "to": { "provider": "openai-codex", "model": "gpt-6.1-sol" },
  "reason": "the model could not finish",
  "appliedAt": "2026-11-04T08:20:01.000Z"
}
```

- The failed Assignment ends with reason `escalated`; a new Assignment is created and its id is the escalation's
  `assignmentId`.
- The new Assignment's launch message names the old and new routes and the failed report's summary, and tells the worker to
  continue from the worktree and history rather than restart. Inputs the failed Assignment did not take are handed to the
  new one.
- Before the new Assignment's first turn the Executor selects the stronger route on the worker's Session
  (`sessionController.selectModel`) and stamps `appliedAt`. A Session the Executor had to recreate starts on the escalated
  route directly.
- If the route cannot be selected, the ticket reports `failed` with that reason and does not escalate again; a person
  decides next.
- `orchestrator_read ticket/<id>` shows the escalation list, so the main Session and the worker see the history.

The cap counts entries in `ticket.escalations`; it does not reset on a person's retry, so a ticket cannot loop through models
indefinitely. Once the cap or the end of the hierarchy is reached, a further failure waits for a person exactly as before.

## Safety boundaries

- The hierarchy contains routes only: no secret, token or credential is written to settings or to the ticket.
- Escalation never changes the ticket's Mandate, scope, rules or reviewers.
- Automatic escalation does not restart the host, enable auto-merge or open a PR by itself; it only changes the model that
  executes the ticket's next Assignment.
- Changing the hierarchy or the cap does not invalidate existing Decisions, because `policyVersion` covers authorization,
  not model choice.

## Tests

- `tests/role-models.spec.ts` covers the pure routing: job defaults, starred order, chain construction, starting routes
  outside the hierarchy, and the cap.
- `tests/settings.spec.ts` covers saving and validating the `models` block through the provider.
- `tests/core-engine.spec.ts` covers the domain rule: a worker's eligible `failed` report records one escalation, starts a
  new Assignment and stops at the cap; a question, a blocked report and a non-escalatable failure do not escalate.
- `tests/runtime-concurrency.spec.ts` covers the Executor applying the stronger route to the worker's Session before the
  relaunch, recording it, and waiting for a person after the cap.
- `tests/panel-execution.spec.tsx` covers adding, starring, reordering and saving the hierarchy.
