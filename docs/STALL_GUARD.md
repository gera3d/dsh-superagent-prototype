# Stall guard (prototype design)

Scope: `superagent-core` only; no live apply, restart, model defaults or credential changes.

## Recovery

Persist a guard checkpoint on the ticket when its current assignment becomes idle after a fallback note or status-only input. Eligible tickets have no PR, no ready/dropped report and no outstanding human hold, failed delivery or blocked/failed report. Use native assignment idle state, not a UI label or model output claiming completion. Send one durable resume input: the status request is over; continue the original issue under the existing mandate. The saved checkpoint prevents repeated wakes across periodic passes and process reloads.

After a configurable idle wait (`executor.stallWaitSeconds` in the existing settings API, default 180 seconds, range 1–86400), expose a quiet stuck decision with Retry and Open issue. New progress or work in flight suppresses escalation; stopped/ended tickets never wake. Retry accepts this otherwise-ineligible idle case and launches a fresh assignment with the original task, not merely the status request.

## Delivery cards

Project a quiet done decision only for a ready report with a bound PR. Offer Try it and Changes needed. Merge must be available only with verified documentation-only PR files; unknown or non-documentation changes require Try it first. Merge opens GitHub for a human to review and merge; it never runs a merge command. Try it opens PR files for isolated inspection; Changes needed opens the ticket for feedback, without sending a message. Server-side actions revalidate ticket state and PR eligibility, rather than trusting client labels. Existing inbox questions keep their staging semantics; lifecycle controls are explicit actions, not silently submitted chat.

## Verification and rollback

Use deterministic clock tests for detection, exactly-once wake, escalation, progress suppression, human holds and retry. Exercise lifecycle cards and action safety; capture the same inbox scenario at 1440×913 before and after. No sound notification is introduced. Rollback: revert the single feature commit and rebuild the prototype; retained optional checkpoints are inert on the base revision.
