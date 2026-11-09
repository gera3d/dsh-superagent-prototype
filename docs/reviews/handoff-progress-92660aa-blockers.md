# R11 exact-head independent review — release withheld

Candidate `92660aa70120dfe655181ab4267e2d5e41214d55`, actual Harness report hash `27a671e3b05e3b5a`. Worker76 focused tests/6 suites, types and build pass; independent executable audit **2 failed /2**.

1. `adviceContext` treats merged progress with deployment pending as deployment completed. Actual output simultaneously says deploy next and forbids deployment. Keep merged -> deploy, deployed -> native verify, verified -> protected acceptance, resolved -> no advice. Do not infer an earlier stage completed from later failed/pending facts or unrelated job/head.
2. Native claim -> record deployed progress -> publish original lease succeeds with pre-review advice and marks it with the NEW progress revision. Reject a generation whose progress changes in flight; never stamp old generation with new progress. Bind capture/lease to authoritative workflow state and revalidate atomically at publish and stage.

Copy the executable docs/reviews/handoff-progress-92660aa.audit.spec.ts to tests/root-handoff-review.audit.spec.ts and run it; uses production methods in in-memory databases. Original root dependency auto-install and syntax setup failures are not product failures; the saved final audit executed both assertions.

Also complete the requested real plugin path test. Current new test manually appends `:p<seq>` to draftRevision even though native producer does not, and manually supplies fresh correct options. That does not prove the existing plugin calls helper again. Exercise actual native host with mocked backend/helper, unchanged session-event digest, authoritative progress change, normal claim/publish order, and verify a new helper request/current options. Ensure regular inbox reconciliation does not invalidate the source so claim cannot replace it. Preserve old choices/history; no direct DB editing, no autosend, no scope/authority changes.

Reuse current isolated r11 repo and installed-baseline companion copy. Do not rediscover historical attempts or repeat the full suite. Fix these precise boundaries and return exact commit(s), cumulative patch and identity-bound structured report. No live edit/deploy; Codex owns release. Existing history projection remains live.
