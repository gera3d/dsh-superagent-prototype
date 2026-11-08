# Independent qualification — Sonnet bounded quality candidate 52af0df (2026-11-07)
Candidate 52af0dfd320b57226669c363af0ba38a1823a4ad (tree ffee2b33c15bb3a8f3d1075ee98940fc7fa081fe), base cdbc302a411a60bfda744a8ed3a9678c69287e2f, fresh clone of gera3d/dsh-superagent-prototype, pnpm install --frozen-lockfile. superagent-core 7600848 = base + docs-only (3 files), not an ancestor-descendant of the candidate; no code overlap.

VERDICT: code review PASS, no code blocker. Release-gate caveat: committed-tree full suite exit = 1 (2 timeout failures in delivery-evidence.spec.ts / decision-submission-client.spec.ts, unrelated to the 7 changed files; delivery-evidence reproduces on the EXACT BASE too). Types exit 0, build exit 0.

## Evidence (this dir)
- full-vitest.log: committed-tree full `vitest run`, EXIT=1: 122 files passed, 2 failed, 2 skipped; 2227 tests passed, 2 failed (5000ms timeouts), 2 skipped. Run once; not replaced.
- rerun-two-timeouts.log: those two files alone: decision-submission-client passed; delivery-evidence still timed out (1 failed/80 passed).
- base-control-delivery-evidence-{1,2}.log: EXACT BASE cdbc302, delivery-evidence.spec.ts alone, 2x EXIT=1, 2 failed/27 passed each (same 5s timeout; the spec spawns 7 node child processes). cand-delivery-evidence-{1,2}.log: candidate 2x EXIT=1, 2 and 1 failed. => load/time-dependent, pre-existing, independent of candidate.
- focused-candidate.log: role-models, model-fallback, panel-execution specs EXIT=0, 46 passed.
- tsc.log: tsc --noEmit EXIT=0 (with companion). build.log: tsdown EXIT=0.
- exact-base.diff sha256 6408e03d5543c1b6b62aec137450af6c52a02160319d8493391b97a5274cea0a; exact-base.patch sha256 e5169ad45e42926a05bd50b70c121764359e3fcca978e167c5150c5e0da92b7d (match handoff). `git apply` of the diff on a clean cdbc302 worktree gives tree ffee2b33… = candidate tree. 7 files, +223/-54.
- Installed source (~/Documents/deepseek-harness/default-workspace/dsh-superagent, HEAD dbf9410 + 168 dirty paths, base commit not in its history): copied (no .git/node_modules/lib/artifacts) to scratch, snapshot tree 5c3f85bdec538e2a79270dbfb8be2e20e0781cd3; `git apply --check` OK; applying changes exactly the same 7 files, each byte-identical to the candidate version (installed copies of those files equal base). No unrelated changes. Installed original untouched.
- Companion dsh-next-steps (read-only copy at ../dsh-next-steps, node_modules symlinked): HEAD 8fe11feba6cfd4fb484b08773da1d83645dd24ad + uncommitted working-tree changes (6 modified files + 16 untracked); `git diff HEAD` sha256 4c90a139ba7415a520cd71b54d027f32d8a8d5b3055ed241c1b7902750b60106 (equals the earlier handoff); copy file-set sha256 (find|sort|shasum) 530616a29d4c0535f13aa75ffdacda6f92a4864215603730526b157b646728c4; diff -rq vs source identical. The qualifying suite depends on this uncommitted companion state (canonical-next-steps, inline-decision specs), so it must exist at ../dsh-next-steps for the full suite/tsc.

## Behavior review (code + meaningful mocked tests, all passing)
- One persisted attempt: qualityEscalation counts ticket.escalations (persisted), cap min(maxEscalations,1); maxEscalations 0 off; >1 still one; replay/restart find it spent; blank summary -> none.
- Availability vs quota: unavailableFallbackStep never writes ticket.escalations; executor marks availability failures escalatable:false; quota Flash->Sonnet->pinned DeepSeek leaves 0 escalations; quality attempt stays spent after later fallback; all-unavailable fails closed.
- Actual route: Executor.currentRoute = last fallback else Session header (reasoning-effort-insensitive match); already-on-Sonnet / DeepSeek -> no escalation.
- OpenAI conserved excluded via routeSkipReason; DeepSeek/economy routes excluded via isFallbackOnlyRoute; conserve mode never escalates.
## Limits (not fixed, by design)
- Bounded finding tickets: Assignments.report ends blocked/failed/dropped finding tickets before escalation and skips escalation for source==='finding' (src/core/assignments.ts). Guard kept; this candidate gives finding jobs no automatic Sonnet attempt.
- A worker whose default/current route is DeepSeek gets no quality upgrade (returns to a person).
- Live maxEscalations is 0 (feature off) until a separate operator settings change. Behavior change: maxEscalations>=2 now means one attempt.
- Google no-first-response loop and independent reviewer scheduling NOT fixed.
- Restarted worker with no Session header and no in-memory fallback uses default route as base.
- No live/settings/source/deploy/merge actions taken. Release ownership: Codex (root).
