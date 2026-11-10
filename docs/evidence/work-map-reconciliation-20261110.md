> Historical worker proposal observed 08:07–08:20Z on November10. Its batch stages and external issue classifications are not the current checkpoint and have not all been independently revalidated. No proposed closure is approved or executed here. Use the CURRENT CHECKPOINT in PROJECT_STATUS.md for live state.

# Work map and backlog reconciliation — November 10, 2026

Read-only reconciliation for finding `60a99ec9-4328-41c1-93cc-dbbe6569e234` r1 (ticket `ecc57b7b6ef827705bb7ebe881718a88`, assignment `cfd1d36113d7f3cd3fc2c8d7f639edd7`).
Observed 2026-11-10 00:07–00:20 PST (08:07–08:20Z). Documentation/proposal only: no issue, PR, finding, job, setting or live file was changed.

## Observation pins

| Item | Value |
|---|---|
| `dsh-superagent-prototype` `superagent-core` | `0ce84a6be57e1b9f97e3de0e7b39d838406bea1e` (23:55:01 PST Nov 9) |
| `PROJECT_STATUS.md` base | blob `4b68b9f8df0e94532fb45ff8dc461a26ec76c177`, sha256 `4700ce91…9e45d4`, 611 lines; byte-identical to `/Users/gerayeremin/Documents/Projects/Manage-Builder/PROJECT_STATUS.md` |
| `superagent-sandbox` `main` | `7665d764ff8c170fcc09f10cc3e33c8b7462e30e` |
| `dsh-plugins` `main` | `d4f5c3e7acebfa9d340fd0c0c7a8addd0293a7e7` |
| Batch receipts | `/Users/gerayeremin/Documents/Projects/Manage-Builder/overnight-batch-20261110/{assignments,confirmed-batch,final-pickup,provider-proof}.json` (`final-pickup.json` at 2026-11-10T07:55:16Z: 3 running / 0 executor-queued / max 3) |

Not independently re-measured here: live health, provider quota, the queue state of batch items 4–5 after 07:55Z.

## Why the status document misleads

`PROJECT_STATUS.md` already opens with the correct “Current overnight batch” section and a line saying everything below is history. The problem is the body below that line: five sections are still titled **Current verified checkpoint / Active approved work / Remaining open work / Current evidence and limits**, two of them with the same title, and the oldest say “no remaining approved implementation”, “1 running (handoff R15)” and “publication diagnostics … not dispatched”. Those were true at their dated snapshot and are contradicted by the current batch (items 1–6). A reader or an automated summarizer who stops at a heading reads them as live.

Separately, the live checkout `~/Documents/deepseek-harness/default-workspace/dsh-superagent/PROJECT_STATUS.md` is an **untracked 39-line file dated Nov 6 18:27** (“Final full suite 2154 passed … No implementation remains”), and that checkout is on `superagent-core` at `dbf9410`, i.e. behind canonical. It must not be copied over the canonical 611-line document. Proposal: leave it untouched (live tree) and treat the canonical `origin/superagent-core` / Manage-Builder copy as the only source.

## Current work map (single checkpoint)

### Overnight batch — all six findings (original IDs preserved)

| # | Finding | Job / owner | Stage observed | Evidence |
|---|---|---|---|---|
| 1 | `dd8d3ab1-7941-43f2-b498-4a82a27c9bb2` Recover failed independent review after worker ended | r1, ticket `23e2930f2e20a79b9b7a6b08277adf29`, assignment `dbf67972c3660cda93275c071694fdaa`; Harness implements, Codex coordinator reviews/releases | **running**; branch `agent/finding-task-23e2930f2e20` has 1 commit `c87912787e6986ff92ec8144f89ac2e2d69220ad` (00:02 PST), no PR seen | `git log origin/agent/finding-task-23e2930f2e20` |
| 2 | `c844ce8f-7c80-407c-a237-9dd53d62f3c3` Composio action-failure integration | r1, ticket `81f39e075967b209bb2da33cdeebb9ea`, assignment `b7a29614de084f5006202e2253aecc3f` | **running**; no branch/PR seen. Prototype issue #2 holds an earlier offline-reproduction finding (nested action failure preserved as ordinary result data) | `gh issue view 2 -R gera3d/dsh-superagent-prototype` |
| 3 | `e1dfd442-bb88-409e-bef0-b2db569dca79` Worker prompt / tool-output waste | r1, ticket `97dc3af26b0375da5a5d9637272f81dd`, assignment `a4dfdfc44526a097f67a1cdeaf0c5367` | **running; draft PR** [prototype #92](https://github.com/gera3d/dsh-superagent-prototype/pull/92) head `9a16934acb95979bdd70468800268210b97ce8c3`, +273/−9, “Nothing is live” | PR body |
| 4 | `fbd4db89-0485-4e9d-a805-cac220390100` First integrated project-sections increment | r1, FIFO | **queued, no ticket** at 07:55Z | `final-pickup.json` |
| 5 | `f1d6590a-5aff-4b9a-9440-65033a5c250f` Sanitized publication phase/failure diagnostics | r1, FIFO | **queued, no ticket** at 07:55Z | `final-pickup.json` |
| 6 | `60a99ec9-4328-41c1-93cc-dbbe6569e234` Status / backlog reconciliation (this item) | r1, ticket `ecc57b7b6ef827705bb7ebe881718a88`, assignment `cfd1d36113d7f3cd3fc2c8d7f639edd7` | **running → this report**; the top table still says “queued; no ticket yet” | — |

Separate and unchanged: Google qualification `f526782b-1443-4342-b811-3cba5188f455` — **blocked, unqualified** (r3 ticket `26b9ea4d4f5d3728e5eed7c89fa5b6dc`; r1 retained). Per the status document: native pool 2.98% weekly remaining, adapter rejects ≤ 5%, user chose “Keep the 5% reserve”. It stays blocked until real eligibility returns above the unchanged reserve; no forced retry.

Provider/limits baseline (from `provider-proof.json` and the status document, not re-measured): max 3, executor rev 43 / models rev 18 / coordination rev 3, OpenAI conserved, Google→Sonnet 5.5 fallback on the three batch sessions.

### Merge ≠ live

A merged PR is recorded below as “merged”. Live completion is claimed only where the status document cites installed postimages/native verification/protected acceptance (PR33, 77–91 range, thread-native handoff PR86, legacy reconciliation PR80, cost PR79, GitHub quota PR82). Other merges are marked **merged — live effect not independently evidenced here**.

## Classification of every open item inspected

Legend: **C** completed/accepted · **N** completed, narrower scope than the issue text · **S** superseded · **U** genuinely unfinished · **B** blocked · **V** unverified.

### `gera3d/superagent-sandbox` open issues (34)

| Issue | Class | Evidence |
|---|---|---|
| #3 context indicator test | C | PR #4 merged `8d6fd63e7`; `TEST_CONTEXT.md` on main |
| #5 Composio MCP doc | C | PR #6 merged `b679e3e46`; `COMPOSIO_INTEGRATION.md` on main |
| #11 Anthropic/OpenAI providers | N | `MULTI_MODEL_INTEGRATION.md` on main; Anthropic Sonnet 5.5 route actually exercised in the batch. OpenAI credentials/route unexercised and intentionally conserved; last comment asked the owner for keys → remainder **V/B on owner** |
| #13 Chrome DevTools MCP live attach | C (PR scope) | PR #15 merged `be219ff7e`; guide + script on main; comment records live GitHub/Gmail attach; needed a DSH restart — live config effect **V** |
| #14 token optimization | U | `TOKEN_OPTIMIZATION_GUIDE.md` is **not** on main (404); active draft prototype #92 (batch item 3) |
| #16 Decisions API / tab | C | Implementation comment cites `8cffe94`, an ancestor of `superagent-core` (checked); Decisions tab/contract evolved through #157 and `docs/017-canonical-decision-contract.md` |
| #54 autopilot | N | Review/apply slice delivered (PRs #45, #59, #70, #72, #74, #88 merged). Status doc: conversation autopilot is opt-in and “no global autopilot” — the issue's wider ambition is **S by explicit owner constraint** |
| #80 stage 1 front door | C | Diagnosis only; #87 comment: timeout from orchestrator loop, “no settings or code change needed” |
| #84 acceptance test, five requests | V | Comment 2 says PASS; comment 3 says PASS premature (only one PR existed) and asks to keep open and re-measure; no later measurement found → **keep open** |
| #86 model audit | N | Read-only audit comment delivered; PRs #49, #94 merged. “Gemini 3.8 Flash everywhere” is **S** by current routing (Google reserve → Sonnet fallback, conserve settings) |
| #87 path-to-ready tracking | S | Stages 1–6 PRs merged (#88, #95, #100); stage 7 only POC (#110). Superseded as a tracker by `PROJECT_STATUS.md` + the finding queue; sections remainder = batch item 4 |
| #91 ADHD guide wording | C | PR #101 merged `8e722ad6f` |
| #98 HUD vs Decisions explanation | C | Report-only comment delivered; later ownership audit (`docs/evidence/hud-decision-ownership-audit.json`) |
| #102 / #121 pick button 409 | C (merged) | proto #14 `aeaa5c4b4` (ancestor), sandbox #126 merged; live effect covered by later canonical-decision releases — direct live proof **V** |
| #108 Stage 7 sections | N | PR #110 merged = design note + mockups + POC only. Real increment is batch item 4 (queued) → **keep open or re-point to `fbd4db89`** |
| #109 retire leftover Decisions cards | N | Script run retired 2 cards (backup recorded); the status doc says raw seven-card storage retirement is design only and unauthorized → do not close as fully done; leave to owner |
| #112 / #128 strip + ranker percentages | C (merged/applied) | proto #16 `6fa65305a` (ancestor), sandbox #127; `dsh-next-steps` commit `8fe11fe` “apply single decision surface (#124)”; later status doc shows Next steps dock live |
| #116 recovery: restart block | C (merged) | proto #12/#13 ancestors, sandbox #12; `tests/control-restart-authority.py` exists in the checkout |
| #117 fallback to cheap flash | N | proto #15 `9d3801ed1` merged; rule superseded by current routing / conserve mode |
| #122, #132 rebase Stage 5 PR #100 | C | sandbox #100 merged `da6dc80fc` |
| #123, #131 rebase #8/#15/#16 | C | proto #8 `6139a38d9`, #15, #16 merged; sandbox #8/#15 merged |
| #133 plugin load fix | C | proto #18 `5aace7eb0` ancestor |
| #135, #136 branding | C | proto #19 `b3a0b368b`, #20 `dbf9410f0` ancestors |
| #138 plugins backup repo | C | `gera3d/dsh-plugins` exists, private, `main` + two history branches; 17 merged PRs since |
| #157, #159, #167 decision / publish / delivery | C | proto #23/#24/#25/#27, plugins #4–#7, sandbox #158/#161/#168 merged; later thread-native handoff accepted (finding `45251448…` resolved, `PROJECT_STATUS.md`) |
| #163, #165 harmless doc PRs for acceptance | S | sandbox #164, #166 merged; purpose superseded by real publication runs (PR86 etc.) |

Open PR: sandbox **#150** (docs, head `bba69829eb`, mergeable, created Nov 6). Its “9.2/9.3 in progress” status line is stale; Stage 9.4 behaviour is now implemented and accepted. **U/S — owner decides merge-with-refresh vs close as superseded.**

### `gera3d/dsh-superagent-prototype`

| Item | Class | Evidence |
|---|---|---|
| issue #2 Composio action failures | U | batch item 2 running; keep open |
| issue #3 computer-use end-to-end verification | V | no comments; untracked cursor-overlay files in the live checkout; no recorded verification; not in this batch → leave, owner to schedule |
| PR #92 | U | draft, batch item 3 |

`gera3d/dsh-plugins`: 0 open issues, 0 open PRs.

## Proposed administrative closures (owner review — nothing performed)

1. **Close as completed:** sandbox #3, #5, #13, #16, #80, #91, #98, #102, #112, #116, #121, #122, #123, #128, #131, #132, #133, #135, #136, #138, #157, #159, #167.
2. **Close as completed-narrower / superseded with a comment naming the replacement:** #11 (OpenAI left conserved), #54 (no global autopilot), #86, #87 (→ PROJECT_STATUS + finding queue), #117, #163, #165, and PR #150 if the owner prefers not to refresh it.
3. **Keep open:** #14 (item 3), #84 (re-measure), #108 and #109 (until the owner re-scopes to batch item 4 / retirement policy), prototype #2 (item 2), prototype #3 (unverified), PR prototype #92.

Closures must not reopen jobs, retire stored advice rows or accept evidence; the corresponding canonical findings stay as they are.

## Documentation correction proposal

Companion patch: `PROJECT_STATUS.reconcile.patch`, against the base blob above (14 heading/divider lines replaced and 2 lines added; no body text removed).

1. Rename the top section heading to **CURRENT CHECKPOINT** so there is exactly one.
2. Turn the existing “Earlier checkpoints below” line into an explicit **HISTORY BOUNDARY** with a reading rule and a pointer to this file.
3. Re-title the stale “Current / Active / Remaining / Open” headings below the boundary with a `Historical —` prefix (bodies, failed evidence, user decisions and unknown-pin receipts untouched).
4. Not changed (belongs to the live coordinator so a stale snapshot cannot overwrite newer milestones): the top table row 6 (“queued; no ticket yet” → ticket `ecc57b7b…`) and rows 4–5 once their tickets exist.

Coordination: the patch touches only heading lines and the divider block, none of the top batch paragraphs a concurrent milestone would edit. Apply with `git apply --check` and `git apply --3way` onto the then-current head only after confirming the file is still blob `4b68b9f8…` (or that only the top section changed); if the file moved, regenerate rather than overwrite. Rollback: revert the single commit.
