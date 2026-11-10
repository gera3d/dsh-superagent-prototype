# Thread-native release handoff, R5 (candidate evidence)

Scope: finding 45251448, job r5. Reviewer R3 rejected 6207ccbc on two root checks.

## Fixes
1. `src/app/delivery-publication.ts`: the regex that inferred requirement coverage from words is removed. Runner HTTP verification records its own passed `verification` evidence with no `requirements`. `src/app/feature-delivery.ts` adds derived `awaitingOperatorEvidence` and no longer re-offers `verify` once automated verification passed; `acceptanceReady` still demands explicit evidence-to-requirement IDs. `recordLiveAttestation` (`src/app/delivery-evidence.ts`) is the in-thread operator path.
2. `src/app/delivery-handoff.ts` + `POST deliveries/:id/prepare|evidence` + `DeliveryCard` panels: executable control, progress, owner, exact missing profile fields.

## Setup prerequisites (not an end-to-end claim)
Profile `publication-runner.json` must carry: `pins.repository`, `pins.prNumber`, `pins.headSha`, `pins.patchSha256`, `patch.path/sha256`, `deliveryScope.environment`, `deliveryScope.refs[]` (primary entry with `baseSha`), `deliveryScope.components`, `deliveryScope.effects`, `scripts.*`, `localEvidence`. Review requires a real GitHub PR head; a local-only candidate cannot be independently reviewed by the Harness.

## Stuck R3 report (ticket bf248fd5, assignment 055a91d0)
Report and claim files exist, no consumed marker. `reply_to_trigger_id` 74cf33a0 is set. In `DshExecutor.workerIdle` an unknown or unreached reply trigger returns silently without consuming; a reached non-human (coordinator) trigger is committed without `answers` (covered by `executor-r3-coordinator-trigger.spec.ts`). Live trigger state was not read here, so which branch applied is unconfirmed. Ready was not inferred from prose.

## Not done
No publish, restart, merge, acceptance or live operation. Codex retains bootstrap deployment and native full-flow qualification.
