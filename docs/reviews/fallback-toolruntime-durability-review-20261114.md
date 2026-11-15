# Bounded fallback: independent real-tool review

Review date: November 14, 2026 Pacific. Original [Sandbox issue217](https://github.com/gera3d/superagent-sandbox/issues/217), source [PR121](https://github.com/gera3d/dsh-superagent-prototype/pull/121), exact source head `0dac5ba2bfdd3367b8633e0796e4f5add24e623e`.

## Verified stage

The draft PR is open and its exact-head CI check is green. The original worker turn ended, but its canonical assignment report is still waiting; no consumed identity-bound ready report was found. The inspected request trajectory used Google Flash. This is not proof of fresh allowance, automatic provider failover, deployment or acceptance.

Independent focused tests invoke the existing SDK's actual ToolRuntime pipeline with the candidate Sessions hook and synthetic in-process effects. They use no provider request, external action, live restart or installed-profile mutation.

| Check | Result |
|---|---|
| Successful synthetic effect records completion; same canonical call ID cannot replay it | Pass |
| Synthetic effect followed by lost acknowledgement records uncertainty; subsequent effect is blocked | Pass |
| Durable intent write fails before dispatch; no synthetic effect may start | **Fail: effect executes once** |

The third case obtains the ledger through the actual executor accessor while the injected store rejects writes, then dispatches through the actual SDK pipeline. The executor persistence callback and ledger notification path swallow persistence failures. Consequently, execution can start without the durable intent required for reliable recovery.

Earlier trial runs had a test-cleanup API mistake; the corrected fixture removes its hook through the returned disposer. The final qualified run is two passing checks and one failing check, not the earlier cleanup failures.

## Next owner and correction

[Original issue continuation](https://github.com/gera3d/superagent-sandbox/issues/217#issuecomment-6886856431) requests one bounded correction: block dispatch if intent persistence fails, preserve an honest blocked/uncertain condition and diagnostic after later persistence failure, and add focused real-tool tests for both boundaries. Retain the two passing cases and existing attempt/conservation/reserve/cooldown controls. File the supported report using the actual current assignment/turn/trigger identity, or state the exact reporting blocker.

The comment was posted for normal intake; it is not evidence of pickup or a Harness queued job. The original fallback owner retains shared runtime files. Source readiness, independent review, CI, canonical report consumption, merge, deployment, native verification and acceptance remain separate. This candidate is withheld from release. Protected native controls and all other owners/gates remain intact.

Only sanitized source-review facts appear here. Detailed fixtures, test logs, machine-private paths and request receipts remain local.
