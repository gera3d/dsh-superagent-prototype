# Independent release-package integration review

Harness checkpoint `080c70e` (coordinator committed the actual staged R15 edits after the worker command failed) builds on typed-owner checkpoint `c8fe303`. R15 did not prove a production lifecycle and its summary incorrectly claimed a commit. Original canonical report/history remain intact.

Coordinator corrections after the worker ended:
- Validate the passed review record against its exact lease, delivery, action and binding fingerprints, rather than trusting a passed verdict alone.
- Serialize package creation with a visible cross-process lock; refuse a different unsettled delivery's prepared manifest.
- Preserve distinct failed/successful attempt directories and logs; do not delete evidence on retry.
- Recheck source/finding/job/current scope, profile and publication state across checks and before manifest installation.
- Reuse frozen existing dependencies without pnpm's automatic verification/install prompt; reject package/lock drift. Add only explicitly configured existing companion links.
- Use a bounded single-delivery management read for the automatic release identity check, through the existing request fence. This automated fact grants no requirement coverage or operator acceptance.
- Apply existing authorized availability fallback for tool-free independent review/advice. Conserved OpenAI remains excluded; malformed or incomplete review is not availability.
- Suppress native publish during unfinished package preparation. Explicit native publication and live requirement evidence remain required.

The production primitives have separate negative controls for changed source/scope, foreign review, failed checks and concurrent packaging. Existing publication tests exercise actual checked-in apply/build/restart/verify/rollback scripts against disposable targets; external services are stubs and this is not installed acceptance.

One-time infrastructure bootstrap is necessary because the installed runtime cannot yet execute this new per-task packaging path. The remaining compact preparation-progress presentation will be completed by the same canonical Harness finding after bootstrap and used for the real native review/check/package/publish/live-evidence loop. Do not reopen the already accepted quota task or describe bootstrap as full-flow success.

Known boundary: an independent review failure against an ended implementation owner is a recorded blocker, not an automatically reopened worker. Do not hide this boundary or label the new flow universally autonomous.

## Current PR base versus artifact diff base

A cloned worker can branch before later coordinator-only evidence commits. Fresh GitHub base SHA is the review/target pin; the Git merge base defines the worker patch. These must be separate: using the merge base as the PR pin rejects valid review, while diffing directly against the current target would include reverse changes from the coordinator. Candidate lookup now reads the actual configured branch head, fetches that fixed branch's missing objects without changing HEAD, derives the patch from its merge base, and rechecks the actual target pin during package creation. A real Git regression advances the trusted source with a separate evidence commit while the worker retains a stale remote reference; it proves fresh target pin, unchanged worker HEAD/worktree and no evidence-file reversal in the patch.

Final qualification for this correction:16 tests/two finding-release suites plus5 package tests (separate run), unfiltered types and build. The first test run exposed four outdated fake-GitHub expectations after adding a mandatory read; the corrected fixtures distinguish a branch read from mutation. No failed run is described as green.

## Real native attempt and bounded recovery correction

The actual r17 thread's protected Review/test/prepare control opened source PR86 at41bae0a, bound its authentic finding/job/report into delivery auto-86635beac41a7b1cb43ddace32aab11d, and dispatched independent review. It stopped at an in-band provider error; the original implementation ticket remained ended and no publication ran. This is a preserved failed attempt, not a pass.

Recovery source760af8a preserves privacy-safe availability classification from typed in-band LLM errors so the existing authorized fallback ladder can run. Partial text is discarded; ordinary provider errors, malformed replies, output caps and aborts remain blocked. OpenAI stays conserved.

A protected repeated finding action can refresh only the same single-source artifact's target base after a parked read-only review, or a target-change preparation blocker. It preserves original job/PR/head/patch, every earlier evidence and outbox payload, the failed blocker and cumulative retry budgets. Parked read-only leases become superseded history; current bindings get a new review generation. No mutation, prepared publication, active worker, new scope or changed artifact is silently replayed. Negative controls reject delegated authority, changed artifact, active handoff and a parked mutation lease. A target changing after a passed review explicitly returns to review.

Advice receives the real configured native control and phase owner; older generated manual-handoff directions predating that actual handoff become immutable history. A later genuine source turn and unrelated conversation remain pending. Ordinary suggestions still stage text and never press a protected control.

Qualification:150 checks/seven related review/context/store/phase suites, plus10 Git-backed finding-release recovery checks; unfiltered types/build pass. Counts overlap earlier runs and are not a full-suite claim. Initial tests caught a fixture using the same source turn for two requests, and a missing stage reset after target refresh; both were corrected and rerun before deployment. The real thread must still complete review, checks, package, protected publish, actual live evidence and acceptance after installing this correction.

## Actual PR review-base observation and helper role

The second actual native attempt preserved the original read-only failure and refreshed its target, then stopped before a model call: branch superagent-core was83d80c8 while GitHub's PR86 payload still reported base2599d37. Both gh-agent and the connected GitHub tool returned the same PR fact. Earlier branch-tip assumptions were wrong for this observed PR and were not bypassed.

Preparation now reads the actual PR's base SHA after creating/reusing it; package creation rechecks the same PR fact. Artifact patch derivation remains based on Git merge-base and never reverses unrelated branch updates. A regression keeps PR-base observation fixed while advancing the branch and proves no invented target refresh. When the PR base itself changes, the protected target-refresh path still preserves history and budgets.

Independent review/advice also honors an explicitly configured models.helper route before the legacy executor default. Actual settings already designate Anthropic Sonnet5.5 as helper and Google/high as routine executor; no settings, credentials, routes, access or budget were changed. Conservation and the existing availability ladder still apply.

Qualification:24 Git/package checks across three suites and59 capability/routing checks across two other suites, types/build pass. The initial helper-route regression accidentally reset the executor in its own test setup; the corrected full-settings fixture proves the code leaves routine routing unchanged. No new native-flow success is claimed before repeating the same PR86 action.
