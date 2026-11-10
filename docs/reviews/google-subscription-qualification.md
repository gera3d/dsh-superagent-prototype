# Google subscription qualification and MCP coordination

Current result: **Google not qualified; blocked by the existing weekly reserve, which the user explicitly chose to keep.** Native pool has100% rolling allowance but2.9801391% weekly remaining. Installed dsh-agy-link0.4.100 rejects<=5% weekly remaining; no active Google cooldown or sign-in error is present. The isolated installed-function check reproduces that exact denial and allows5.1% in a counterfactual. No live quota policy was changed. Weekly reset snapshot:2026-11-14T22:42:10Z. The generic native cooldown message counts all ineligible accounts, and its earlier rolling reset is not proof weekly eligibility will return then.

## Actual Harness attempts

- Original finding f526782b-1443-4342-b811-3cba5188f455/r1, ticketb2efbd4f140c102b3a6a25a1fea719e7: the native confirmation actually landed at06:44:45Z despite the subsequent UI scrolling/input failure. The earlier pending-dispatch checkpoint overstated that blocker and is superseded. Google was unavailable; configured fallback completed three real local round trips on Sonnet. Its final CLI ready report/hash/consumed marker matched native state. **Not a Google pass.**
- Same finding/r3, ticket26b9ea4d4f5d3728e5eed7c89fa5b6dc, assignmentc7b90960e755e5ceb6a4323295fe64e0: dispatched entirely through MCP retry/confirm, using the existing approval. Google was rejected before a usable answer; Sonnet completed tools. Final ready used the actual native orchestrator_report tool; its summary matches canonical assignment and finding SHA256. A separate progress CLI file was not consumed; do not conflate the two reporting transports or claim progress/ready CLI coverage on Google.

Both native request-context sequences show Google then Sonnet; no OpenAI worker route was selected. Source finding is blockedrevision4, unaccepted, preserving both jobs and reports. The actual current native finding card truthfully shows NOT a Google pass.

## MCP gap fixed and live-tested

[PR91](https://github.com/gera3d/dsh-superagent-prototype/pull/91), exact source4afa7c51838d2dbd4494b60cdfb8f91ea7d0c875, is merged and the existing local adapter updated with rollback.132 MCP checks,11 production coordination-guard checks and Node syntax check pass. The backend was already installed/enabled; only the adapter omitted its route. New coordinate_finding transports an existing finding ID and absolute private instruction path. The backend still checks current UID,mode0600,expiry,exact revision,prior native approval lineage and matching original choice. No browser authority headers, canonical DB edits, first-approval grant, evidence acceptance, publish, settings or permission change.

Actual MCP retry_scope advancedrev2→3; confirm queued the same approved scope and produced the realr3 worker. Replaying the old instruction was refused as stale; no competing worker was created. **Already-approved routine retries no longer depend on screen input. First approval, protected publication and final evidence acceptance remain explicit existing gates.**

## Next owner and limits

The user chose Keep the5% reserve. Codex owns continuation through the existing MCP path only after actual Google eligibility returns. Do not retry at every hourly check, clear cooldown, change threshold, add accounts, alter routing or mistake Sonnet fallback for a Google pass. No new automation was created. Existing source/project scopes stay accepted.

Saved executor Google/high revision43, models revision18, max3 and OpenAI conservation remain unchanged. Final load0running/0queued; all10 health components ready. This verifies native failure classification, existing subscription fallback, local tools/reporting on Sonnet and screen-independent approved coordination; it does not certify a Google response, first-response latency, throughput or future quota.

Evidence: [R1](../evidence/google-qualification-attempt1.json), [R3](../evidence/google-qualification-attempt2.json), [sanitized live pool](../evidence/google-native-pool-sanitized.json), [installed eligibility check](../evidence/google-local-quota-gate-check.json), [guarded adapter installation](../evidence/google-mcp-coordination-installed.json), [stale replay refusal](../evidence/google-mcp-stale-replay-rejection.json), [current checkpoint](../evidence/google-qualification-current-checkpoint.json).
