# Project sections

Status: first increment, implemented but not applied to any real project. Design source: `gera3d/superagent-sandbox` issue #108 and merged PR #110 (`sections/design-note.md`, `docs/019-stage7-sections.md`, `scripts/project-sections.py`). That design is a proof of concept; this document records what the native increment reuses and where it stops.

## Current contract

- A **project** is a DSH workspace id, taken from the same read-only workspace snapshot Dot uses (`src/client/dot-context.ts`). No project record is created.
- A **task** is a reference to an existing record: a superagent Ticket (`kind: ticket`, checked against the Ticket store) or a DSH Session (`kind: session`, checked for shape only; the Session catalog is browser-side). No task, queue or Session is duplicated or created.
- A **section** has an immutable id (`sec_…`), a name unique within its project, one icon from a fixed set of eight (`door-open`, `zap`, `masks`, `sliders`, `bell`, `video`, `compass`, `flask`), an optional goal and an optional **base thread**: an existing Session id, related only; nothing starts or messages it. A Session is the base thread of at most one section.
- A task is in at most one section of a project. Moves are validated (known task, section of the same project, section capacity) and idempotent; moving a task out of every section leaves the Ticket untouched.
- Storage is four SQLite tables created lazily on the existing Store connection (`section`, `section_member`, `section_proposal`, `section_event`); all writes run in savepoints. Nothing else changes.

## Taxonomy approval

A proposal (`POST sections/propose`) is inert: it creates no section and moves no task. A person approves it once (`POST sections/approve`); the approval materializes exactly that proposal and fails whole if any referenced Ticket no longer exists. A newer proposal supersedes an older pending one. A project that already has sections takes no new proposal; later changes are individual validated renames, moves and base-thread links. Every section-changing route requires the same-origin local-operator envelope as findings and progress.

## Steering

`Press forward` and `Make it better` are **preview only**. They report which Tickets an existing control could act on (retry eligibility, waiting for a person, running) or echo the instruction, always with `execution_authorized: false`. They start, retry, stop and message nothing, store no instruction and never bypass a Ticket's own mandate, approval gates or the locked escalation list. Executing a section remains with the per-Ticket controls until a later increment binds an explicit, authority-checked path.

## Interface

`GET sections?project=`, `POST sections/{propose,approve,reject,move}`, `POST sections/:id/{update,base-thread,press-forward,make-better}`; panel tab `Sections` (`/sections`, query `project`, `section`).

## Not in this increment

- Creating a proposal from the panel (proposals arrive through the API, for example from Dot).
- Section icons on the DSH sidebar session rows (`sidebar.session.row.leading` slot): needs native verification.
- Label/status parsing (`[Section] action | status`) and automatic categorization of tasks.
- Running a section's ready tasks.
- Applying any structure to a real project: that needs the person's approval and native acceptance.

## Rollback

Revert the commit. The four tables are additive and unread by anything else; leaving them in place is harmless, or drop them.
