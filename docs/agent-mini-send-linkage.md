# Agent-Mini native Send linkage repair

## Confirmed defect

Ordinary non-slash Send in the installed DSH composer uses a detached send and remains in `plain` phase. Only slash-command arbitration enters `adjudicating`. The original bridge armed submission intent from that phase; native optimistic clearing therefore looked like an edit/discard. Tests had incorrectly simulated an adjudicating phase for ordinary text.

## Repair and authority boundary

The installed browser composer now exposes a session-scoped `observeSubmissions` API. It notifies synchronously before optimistic clearing and asynchronous reference serialization, providing the frozen complete input snapshot and actual click/Enter source. Analytics remains intact. This is a native facade extension, not a runtime monkey-patch of Send or inference from matching text. Observers unsubscribe on view/session teardown.

The bridge registers this observer when retaining the source composer, validates the owned staging attempt, editor revision, full draft, and attachments, and captures the pending-request baseline before Send. It binds only the subsequent new native request identity with the exact previously fingerprinted serialized text. A native clear does not discard this explicit intent. Failed pre-request serialization restores and re-proves the document instead of discarding it.

The runtime still requires durable matching user-message/RPC proof before setting `resolved` and `resolutionBasis: submitted`. HTTP acceptance, identical text alone, a different tab, a manual clear, or disappearance of a local echo cannot resolve a decision. Stale history is not resurrected.

## Deployment caveat

This installation needed a small native composer browser-artifact extension because the shipped public input facade had no before-Send observer. The addon deliberately refuses new staging if the observer is unavailable, asking for an app refresh instead of silently returning to phase inference. A DSH package update may replace this extension; it must be preserved/upstreamed before relying on the addon with that update.

The native implementation patch is saved in [native-composer-send-observer.patch](<../.artifacts/native-composer-send-observer.patch>). Its public method is also declared in the installed input contract and facade declarations. The patched module is the `@deepseek-ai/dsh-client-ui-conversation` browser entry inside the current DSH installation. Only browser artifacts were updated; no backend restart or model configuration change is required.

## Checks

- [Bridge regression tests](<../tests/decision-submission-client.spec.ts>): ordinary plain-mode sends, deferred session notifications, clear-before-reference-echo, failure restoration, exact native IDs, unrelated identical echoes/manual clears, attachment preservation, retry/reload, and fail-closed older facades.
- [Native artifact contract test](<../tests/native-composer-send-observer.spec.ts>): opt in with `DSH_NATIVE_COMPOSER_BUNDLE` pointing to the installed conversation browser entry. It checks actual observer methods, immutable snapshots, unsubscription, preserved analytics, and notification ordering before sink/reference serialization.
- [Card regressions](<../tests/inline-decision.spec.tsx>) and runtime provider/submission tests continue to check pending-on-stage and resolution only after durable submission proof.

## Live retest — passed

On 2026-11-03 at approximately 18:59 America/Los_Angeles, an isolated diagnostic conversation exercised the exact original report-only draft. Its prompt fingerprint was `sha256:3c30f96fdf00afa76bb6205552f4ad4606be849c7e2fed3006d65bcd4ab04f22`, identical to the failed attempt. The diagnostic choice was explicitly seeded through `DecisionInbox.publishAdvisor`, labelled as a user-selected regression fixture rather than model evaluation; no submission state was manufactured.

- Session: `session-67512e80-8582-4501-8d0e-23cab69d0b77`; decision: `chat-45351984bf9147a778f259028d3f924a`; staged attempt: `a0f0aaa4-ff2e-4f41-8b51-593d00c93ad8`.
- Actual card selection returned stage HTTP 200. An explicit native Send click produced submission-binding HTTP 200, native prompt HTTP 200, and subsequent confirmation HTTP 200. No discard-staging request occurred for this attempt.
- Runtime: `status: resolved`, `resolutionBasis: submitted`, choice `option-a`, submission `940759a1-5273-49ca-9f90-ed971a4b744d`, durable message `40c038d7-fcc7-4ec3-9538-1e3b5b90db82`, sequence 25.
- The composer emptied; the diagnostic agent acknowledged `REPORT-DRAFT-RECEIVED`. No report execution or external work was requested from this diagnostic agent.
- After a page refresh and reopening the diagnostic conversation, the same runtime proof remained resolved and the card displayed **Previous choice confirmed submitted**. The receipt remains visible even when a newer pending card is displayed. No alerts or `Unknown operation` were visible.
- Final focused validation: 105 tests passed, TypeScript passed, and the browser-only build passed. No backend restart was used.

The original stale decision remains unchanged; this test did not retroactively certify its failed submission.
