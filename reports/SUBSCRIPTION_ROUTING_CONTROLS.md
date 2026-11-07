# Integrated subscription routing review

The original worker artifact required corrections before release. The integrated version uses a portable direct DeepSeek Flash default, validates activation even when the route is unchanged, rejects a parked economy provider, and fails closed when no eligible managed route remains. The deployed account-specific Particle preset will be configured explicitly, never embedded as a universal settings default.

The same browser-safe routing resolver supplies execution and the settings preview. A request guard applies current availability/conservation to existing managed sessions and rebinds after native model selection. Helper and auto-ranker source/default routes are checked too. Disabling conservation restores saved routes subject to explicit availability marks; clearing marks restores their normal priority. No connections or keys are removed.

Reset dates are manual reminders, retained as entered. They do not automatically re-enable exhausted subscriptions. Requests already in flight are allowed to finish; subsequent managed requests obey the new policy. Explicit external custom ranker endpoints remain independently configured and are outside the managed auto-ranker route.

Validation is recorded in the combined release report and PROJECT_STATUS.md. Worker-level test/typecheck claims are superseded by independently run integration checks. Live verification is a separate release gate.
