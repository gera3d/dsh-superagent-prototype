# 015 — One decision engine, named response agents, optional auto-run

**Status:** Approved for execution on 2026-11-03 ("go ahead and execute on the plan"). Phase 0 is being handed to the superagent as a GitHub issue; Phases 1-3 wait for Phase 0 review. Key rotation is deliberately deferred.

**Execution constraints (apply to every issue below):**
- Work on a branch and open a PR. Do not merge. Do not restart services, change profiles or activation, or touch secrets/keys.
- Keep the message composer visible. Any UI change needs a regression test for the empty-dock guard in `inline-decision.tsx`.
- Do not amend the resolve-on-send contract (`SharedDecisionV1`) in Phases 0-2.
- Each phase ends with passing unit tests plus a short written report in the PR.

## 1. What is actually going on

Decisions are stored in one place (the SQLite `decision_inbox` table owned by `dsh-superagent`). They are **produced** and **shown** in too many places:

| Piece | Where | Role today |
|---|---|---|
| Superagent capture + evaluator | `src/app/decision-inbox.ts` (~L392-410), `decision-evaluator.ts`, `core/decision.ts` | Regex-extracts "Option A/B" alternatives from the agent's reply, or falls back to **two fixed buttons**. Ranks them with the source session's own model. Writes scores. |
| Next steps / Agent Mini advisor | `dsh-next-steps/src/index.ts`, `suggest.ts` | **Invents** options from a thread digest with its own prompt, its own model route (`anthropic/claude-haiku-5-5`), its own HTTP route and a startup budget. Writes via `publishAdvisor`. |
| Superagent inline card + Decisions tab | `src/client/inline-decision.tsx`, `decisions.tsx` | A second card UI for the same record. |
| Workstream HUD | `dsh-workstream/src/client/handoff.tsx`, `decision-api.ts` | A third consumer with its own copy of the prompt-fallback logic. |
| `dsh-superagent-factory` | git worktree, branch `agent/factory-foundation` | Stale older copy of superagent. Not running, but it is why code appears to live "outside" the superagent. |

So there are **two producers and three card UIs on one record**. The two producers use different models, different rules and different data. Live inbox evidence: rows labelled "Task-specific next steps" carry `confidence 0` and no score distribution (generator output only), while "Explicit chat follow-up" rows carry real scores from the evaluator. 28 decisions are pending and many were never evaluated.

### Why the option count is inconsistent
- Next steps prompt says "Propose **2 to 4**" and `parseSuggestions` hard-slices to 4 (`suggest.ts` L138, L161).
- When alternatives were regex-extracted, Next steps must return *exactly that many* (`index.ts`, "Advisor did not preserve the explicit alternatives"), so 2-3 stays 2-3.
- The capture fallback is two hard-coded buttons (Continue/Discuss or Respond/Clarify).
- `publishAdvisor` accepts any set of 2 or more.
- Result in the live inbox: sets of 2, 3 and 4 options.

### Where a liked option set or a slimmer version can disappear
1. `publishAdvisor` overwrites `choices` wholesale on re-advise or `force` (`decision-inbox.ts` ~L229). The earlier set is not kept anywhere.
2. The hard `.slice(0, 4)` silently drops a 5th option, and the recommended option is re-ordered to first.
3. A newer human message marks the decision `stale` (92 stale in the live inbox). Stale items cannot be staged, so a good set is effectively gone from the UI.
4. **The slim UI:** `dsh-next-steps` commit `25d1781` is the original compact panel (193-line client, screenshots in `dsh-next-steps/artifacts/next-steps/`). The working tree is now an uncommitted, much larger rewrite (dock, bridge, host canonical mode). The slim version is still recoverable with `git show HEAD:src/client/index.tsx`.
5. `origin/superagent-core` has one commit (`f3f6106`) that local `superagent-core` does not, so the two histories have diverged.

### About Jev
Jev is TypeSafe AI's System One model (early access since Sept 15, 2026). It returns typed decisions with calibrated probabilities, not prose. That makes it a good **ranker and auto-run gate**, and a poor generator: it cannot write options or explain itself. TypeSafe's own numbers put it near mid-tier LLM accuracy (~68%), so treat it as vendor-reported.
In this repo Jev is **not integrated**: `provider: 'typesafe-jev'` is rejected as "not implemented", and commit `544c90a` removed earlier *simulated* Jev output. The endpoint details in doc 012 were not verified against TypeSafe's docs. The "Make Progress (Jev-Pilot)" toggle (commit `10d5b63`) was UI only and no auto-resolution code exists today.

## 2. Target design

**One engine, in superagent.** Everything else is a view.

```
agent turn completes
  -> Decision Engine (superagent)
       1. Source gate        (completed human-task turn only, as today)
       2. Generate           (Response Agent's generator model) -> 6+ candidates
       3. Normalize          (dedupe, validate, backfill) -> at least 4 shown
       4. Rank               (Jev if configured, else LLM evaluator) -> calibrated scores
       5. Explain            (short rationale from the generator, never from Jev)
       6. Persist            (one record, versioned option sets)
  -> views: Agent Mini card, Decisions tab, Workstream HUD (read + stage only)
```

### Option contract (hard rules, enforced in code, not only in the prompt)
- **Minimum 4 options, maximum 6 shown.** Generator asked for 6-8. If fewer than 4 survive validation, run one repair call; if still short, add clearly labelled generic fallbacks (wrap up / verify / extend goal / ask a question) so the card is never below 4.
- Nothing is pruned. Options beyond the shown set stay on the record as `hiddenOptions` ("More options").
- **Option-set revisions:** each regenerate appends `optionSets[n]` instead of overwriting. The user can pin or restore an earlier set.
- Extracted explicit alternatives (Option A/B in the agent's own reply) are kept verbatim *and* padded to 4 with generated ones, marked as "added".
- Display mode `slim | full` per Response Agent. `slim` = the original `25d1781` layout (label + one line).

### Response Agent profiles
A saved profile that says how the "second agent" behaves for a thread:

```
name: "Dev lead"
generator:   { provider, model, maxOutputTokens }
ranker:      { kind: "jev" | "llm" | "none", model?, minConfidence }
role prompt: "Review the worker like a senior dev; rebuke nonsense, demand evidence…"
tools:       [ read-only repo / test status / git diff … ]   (default none)
optionCount: { min: 4, max: 6 }
display:     "slim" | "full"
autoRun:     { enabled, maxTurns, minConfidence, stopOn: [...] }
```
- Several named profiles (Dev lead, Fast helper, Reviewer, …). A thread picks one; default is a global profile.
- Stored in superagent settings next to `policy / eval / executor` as a new block, edited in the Settings UI and through the MCP server (`save_settings`).
- This replaces the separate `dsh-next-steps` model config and the evaluator's "use the source session's model" rule.

### Auto-run to 100% (opt-in per thread)
A per-thread **Auto** switch. Loop: agent finishes → engine produces ranked options → if top option's confidence ≥ threshold and the action is allowed, stage and **send** it → agent continues → repeat until a "done" judge says the goal is complete.
Guardrails (all required): max turns, min confidence, a stop button, an audit trail of every auto-sent message, and a hard block on destructive or irreversible suggestions (deploys, deletes, pushes, spending, secrets). It pauses and asks you when confidence is low, the agent reports an error loop, or two turns make no progress.
Rebuke behaviour is a profile feature: a "Dev lead" profile's role prompt and evidence rules can tell the worker it is wrong and why.

**Contract impact:** the frozen resolve-on-send contract says a *human* confirmed Send resolves a decision. Auto-send needs a deliberate amendment (for example `resolutionPolicy: 'auto_send'` with its own proof fields) and a server-side way to inject the user message. Today the bridge only observes the native Send button, so this is real new work and needs explicit approval.

## 2b. Ranker: OpenAI Decisions API first, Jev swappable, LLM fallback

Verified 2026-11-03: `POST /v1/decisions`, GA Oct 22 2026, model `gpt-6-luna`, about $0.10 per million input tokens with no output charge. No streaming and no tools. Gateways (RouteLLM, LLM Gateway) serve the same request shape and accept `jev-latest` (text only), so Jev is a model-name swap rather than a new driver.

Request mapping (one `choice` question over the candidate options):
```
{ model, input: <thread digest + latest agent turn>,
  questions: [{ name: "next_action", type: "choice",
    instructions: <role prompt + goal>,
    choices: [{ value: <optionId>, description: <label + one line> }, ...] }] }
```
Response mapping: `choice` becomes the recommended option; `probabilities[]` become the per-option score distribution; `confidence` feeds the auto-run gate. A second `predicate` question ("is the goal 100% complete?") is the done-judge for Phase 3.

Fallback order: configured Decisions model -> existing LLM evaluator -> unranked (generator order, confidence 0, labelled "unranked"). Provider and key come from settings; no call is made until the user confirms which key to use. The existing provider enum (`auto | typesafe-jev | openai-luna | deepseek`) is reused; `openai-luna` becomes the first real driver.

## 3. Plan in phases

**Phase 0 (small, safe, can ship first)**
- Change the prompt to 4-6 options and replace `.slice(0, 4)` with the shared min/max rule.
- Add the 4-option backfill and stop the two-button fallback.
- Stop `publishAdvisor` from overwriting: append an option-set revision.
- Commit the current `dsh-next-steps` work so the slim `25d1781` and the new dock are separate commits; resolve the `origin/superagent-core` divergence; mark `dsh-superagent-factory` as archived.

**Phase 1 — Consolidate the producer**
- Move generation into the superagent engine. `dsh-next-steps` keeps only its client card and calls the engine (`/next-steps/api/suggest` becomes a thin proxy). Delete its own model config and prompt.
- One shared prompt/profile; one place for the 28 never-evaluated backlog.
- Workstream and the Decisions tab import the same prompt-fallback helper instead of copying it.

**Phase 2 — Profiles + Jev ranker**
- Response Agent profile block, settings UI, MCP tools.
- Jev driver behind the existing `provider` field, with `llm` fallback. Needs a TypeSafe account and the real API docs; no calls until you approve a key.
- Show Jev's calibrated score as the badge; show the LLM rationale as the "why".

**Phase 3 — Auto-run**
- Contract amendment, server-side send, loop controller, guardrails, audit view, kill switch. Test against an isolated sandbox session first.

### Issue breakdown and acceptance criteria

**Issue P0 - Option contract and no-loss history (ships first)**
- Prompt asks for 4-6; shared `OPTION_MIN=4`, `OPTION_MAX=6` constants replace `.slice(0, 4)`; extra options kept as `hiddenOptions`.
- Backfill to 4 with labelled generic options; remove the two-button fallback.
- `publishAdvisor` appends `optionSets[n]` instead of overwriting `choices`; latest set is the shown one.
- Commit the slim `25d1781` panel and the dock rewrite as separate commits (no history rewriting); archive note for `dsh-superagent-factory`; report (do not force-fix) the `origin/superagent-core` divergence.
- Acceptance: every path yields at least 4 options; regenerate never deletes a prior set; composer still renders; full test suite passes.
- Rollback: revert the PR; no schema destructive change (additive columns only).

**Phase 0 worker brief (read this before starting)**
- The real code is NOT in the GitHub sandbox repo. It lives in the local git repos `dsh-superagent` and `dsh-next-steps` under `/Users/gerayeremin/Documents/deepseek-harness/default-workspace/`.
- Never edit those live checkouts. For each repo create a fresh git worktree on a new branch (e.g. `agent/decisions-p0`) under your own work directory. Do not build, restart or reload the running harness.
- Files: `dsh-next-steps/src/suggest.ts` (prompt says "2 to 4", `.slice(0, 4)` near L138/L161), `dsh-superagent/src/app/decision-inbox.ts` (two-button fallback ~L392-410, `publishAdvisor` overwrite ~L218-243).
- Extracted explicit alternatives stay verbatim and are padded to 4, with padding marked as added. Beyond-max options are kept as `hiddenOptions`. Schema changes additive only.
- In the `dsh-next-steps` worktree keep the slim panel (`25d1781`) and the uncommitted dock rewrite as two separate commits. No history rewriting, nothing deleted.
- Report only (do not fix): `dsh-superagent-factory` is a stale worktree (branch `agent/factory-foundation`); local `superagent-core` lacks `origin/superagent-core` commit `f3f6106`.
- Do not amend `SharedDecisionV1`. Keep and test the empty-dock guard in `src/client/inline-decision.tsx` (`if (!items.length && !creating && !failure && !notice) return null`).
- Deliver: a PR to the sandbox repo with a written report (worktree paths, branch names, files changed per repo, exact test commands and results; say so if a build tool is missing). Do not merge.

**Issue P1 - Single producer.** Next steps becomes a view that calls the superagent engine; delete its separate model config and prompt; Workstream and Decisions tab share one fallback helper; evaluate the never-scored backlog once.
**Issue P2 - Response Agent profiles + Decisions-API ranker.** Settings block, UI, MCP `save_settings`, `openai-luna` driver, LLM fallback, slim/full display per profile.
**Issue P3 - Opt-in auto-run.** Contract amendment, server-side send, loop controller, guardrails, audit trail, kill switch; isolated sandbox session first.

**Tests to add:** option count ≥ 4 for every path (extracted, offer, question, no-advice), no pruning on regenerate, option-set history restore, single producer per source (no duplicate evaluation), stale decisions never auto-sent, auto-run stop conditions.

## 4. Decisions needed

1. Confirm the engine lives in superagent and Next steps becomes view-only.
2. Which slim version did you like: the original compact panel (`25d1781`) or an earlier option set? I can restore either; both are recoverable.
3. Do you have a TypeSafe/Jev API key or early-access account? Without it the ranker falls back to an LLM.
4. Auto-run: which actions may it send without asking (continue, verify, run tests) and which must always pause?
5. Should a profile also choose which model runs the *worker*, or only the helper?
