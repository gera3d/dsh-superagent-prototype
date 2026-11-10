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
