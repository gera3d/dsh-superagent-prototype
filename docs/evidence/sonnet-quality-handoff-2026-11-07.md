# Bounded Sonnet quality escalation — release handoff (candidate, NOT live)

## Identities
- Code repo: `gera3d/dsh-superagent-prototype` (local checkout `repo/`, not pushed, no PR).
- Exact base: `cdbc302a411a60bfda744a8ed3a9678c69287e2f` (= `origin/superagent-core`; `fd889f1` + docs-only commit).
- Source commit: `52af0dfd320b57226669c363af0ba38a1823a4ad` on local branch `agent/finding-task-ba790a3ab96e` (author gera3d). Tree `ffee2b33c15bb3a8f3d1075ee98940fc7fa081fe`.
- Artifacts (this directory):
  - `quality-escalation-exact-base.patch` (git format-patch) sha256 `e5169ad45e42926a05bd50b70c121764359e3fcca978e167c5150c5e0da92b7d`
  - `quality-escalation-exact-base.diff` sha256 `6408e03d5543c1b6b62aec137450af6c52a02160319d8493391b97a5274cea0a`
  - Verified: diff applies cleanly to a scratch worktree at the exact base and yields tree `ffee2b33…` (identical to the commit tree).
- 7 files, +223/−54: `src/model-routing.ts`, `src/app/runtime.ts`, `src/executor/dsh.ts`, `src/policy.ts` (comment), `src/client/locales.ts` (hint text only), `tests/role-models.spec.ts`, `tests/model-fallback.spec.ts`.

## Behavior
1. Quality path (`escalationChain`/`escalationStep`/new `qualityEscalation`): at most one attempt per ticket, counted from the persisted `ticket.escalations` (survives restart/replay). Needs a `failed` worker report with a non-blank summary, `escalatable !== false`, no open question; summary text is never parsed. `maxEscalations` 0 = off; any value >1 still means one.
2. Candidates skip parked providers (`routeSkipReason`, so the conserved OpenAI mark excludes it) and any DeepSeek/economy route (`isFallbackOnlyRoute`). A worker already on Sonnet (also with a different reasoning effort), on a DeepSeek route, or with Sonnet parked gets no escalation → ticket waits for a person. Conserve mode never escalates.
3. Escalation `from` is the route the worker actually runs on (`Executor.currentRoute`: last availability fallback, else Session header), not just the default.
4. Availability path (`unavailableFallbackStep`) is unchanged in order (Google → eligible Anthropic → pinned economy route, e.g. Particle OpenRouter DeepSeek); the last resort is now the configured economy route instead of hard-coded direct DeepSeek (falls back to direct DeepSeek flash only when no economy route is set). It never writes `ticket.escalations`, so quota handling cannot reset or spend the quality attempt. When everything is unavailable the ticket fails closed to a person.
5. No new settings, no quota percentages, no reset detection, no live provider calls (all tests are mocked).

## Verification (actual exits)
| Check | Result |
|---|---|
| First full `vitest run` | exit 1: 2182 passed, 2 skipped; 1 failed suite `tests/inline-decision.spec.tsx` (import `../../dsh-next-steps/...` unresolved — qualification setup gap, not a baseline claim) |
| First `tsc --noEmit` | exit 2: only the 2 unresolved `../../dsh-next-steps` imports (`canonical-next-steps.spec.ts`, `inline-decision.spec.tsx`) |
| First `tsdown` build | exit 0 |
| Companion provided (read-only copy, see below), `vitest run tests/inline-decision.spec.tsx tests/canonical-next-steps.spec.ts` | exit 0: 2 files, 62 tests passed |
| `tsc --noEmit` rerun with companion | exit 0 (before the final string/comment commit) |
| `vitest run tests/panel-execution.spec.tsx tests/role-models.spec.ts` after hint/comment edit | exit 0: 32 passed |
| Final `tsc --noEmit` + `tsdown` on commit `52af0df` | `tsc --noEmit` exit 0; `tsdown` exit 0 (clean tree, HEAD `52af0df`) |

Companion used as a read-only test dependency: copy of `~/Documents/deepseek-harness/default-workspace/dsh-next-steps` (the plugin linked by the superagent profile), HEAD `8fe11feba6cfd4fb484b08773da1d83645dd24ad` **plus uncommitted working-tree changes** (6 files, `git diff HEAD` sha256 `4c90a139ba7415a520cd71b54d027f32d8a8d5b3055ed241c1b7902750b60106`; copied file-set sha256 `f9a88b6c21b0c87db8c64f3d1da26c71f55437233167e6d34cb2343e87a90f20`, excluding `.git`/`node_modules`), placed at `../dsh-next-steps` with `node_modules` symlinked. The live plugin was not modified.

New/updated tests: chain/cap/DeepSeek-exclusion/OpenAI-exclusion/blank-reason/already-Sonnet/Sonnet-parked/conserve/replay (`role-models.spec.ts`); runtime-level one-attempt-then-person, escalation off, quota→Sonnet→pinned DeepSeek without spending the attempt, no re-escalation after quota moved to Sonnet, attempt stays spent after later quota fallback, all-providers-unavailable fails closed with no OpenAI/direct DeepSeek (`model-fallback.spec.ts`). Older tests expecting the 2-step Sol→Sonnet chain were updated to the one-attempt policy.

## Operator notes / residual risks
- Live settings were not touched and still have `maxEscalations: 0` (escalation off). Enabling the feature is a separate operator settings change (set to 1+); OpenAI stays excluded only while its `conserved` subscription mark is kept.
- Behavior change: any existing configuration with `maxEscalations` ≥2 now yields one attempt, and OpenAI/DeepSeek hierarchy entries that are parked/DeepSeek are skipped for quality escalation.
- A restarted worker with no Session header and no recorded fallback falls back to the default route as the quality base.

## Rollback
Revert commit `52af0df` (or do not apply the patch); settings need no migration. Setting `maxEscalations` to 0 disables quality escalation without a code change.

## Release stage
Candidate only: not pushed, no PR, not merged, not deployed, not live. Review owner: the operator (gera3d) as release reviewer; remaining stages: source review → apply/merge to `superagent-core` → build/restart by a person → separate settings change to enable.
