# Independent r9 review — use the actual native digest format

Exact candidate `eb3d9cb24acb2005f4ba5bd8928f8fc87d1f5b6e`: hold release for a **narrow remaining parser mismatch**. Earlier native publication, ordinary direct request, scope and lifecycle tests improve. Do not rewrite those implementations.

[Executable exact audit](../evidence/root-quality-real-digest.audit.spec.ts), [actual2failed/2](../evidence/root-quality-real-digest-audit.log). Root used an isolated pinned worktree and existing runner, no worker-suite duplicate or live modification.

`dsh-next-steps/src/turn.ts` produces `latestTurn` via `src/suggest.ts:buildDigest`. It uses Markdown sections **## Original goal (first human message)**, optional **## Earlier human follow-ups (oldest first)**, **## Latest human message**, **## What the agent did this turn ...**, **## Agent progress notes this turn**, **## Agent's final message to the human**. `summary` deliberately contains older prompts. It does NOT use `User: ... Assistant:`. r9's extractUserObjectiveFromDigest parses only that simplified test format, then prefers stale summary.

Exact reproduction: summary is earlier “Explain caching options.”, latestTurn has the actual native sections with current human “Please draft a new issue for the native-tool gap; do not file or send it.”. Parser returns older caching scope. Actual helper with valid generated draft/clarify options drops draft and returns clarify,next-clarify-step. Both parser assertion and useful generated-option assertion fail. This is the same current-context objective failure, now replayed through the real plugin contract.

## Minimal correction

1. Change the shared current-objective extraction to recognize the real builtDigest sections. Prefer **Latest human message**, stop at next section header so assistant/tool narratives cannot become the objective. If absent (first-turn actual digest), use **Original goal (first human message)**. Retain supported simple User:/Assistant: inputs only as compatibility, and old summary only as a last fallback. Add first-turn and newer-human-after-older-summary controls; keep current scope prohibition/owned finding rules and source guards unchanged.
2. Ensure this correct objective reaches the **generating helper context** as bounded conversational data as well as quality validation; no new tool authority or routes/settings. Native publication continues to derive authority/current source from real events, not caller/model claims. No broad keyword rewrite or more synthetic filler choices.
3. Copy both exact tests unchanged. Preserve previous root/17-option and positive controls, source/CAS/staging/history/publication gates. Focus on this parser, current context and a relevant focused regression bundle/types/build; do not restart unrelated investigations or broad duplicate full-suite runs.
4. Return exact committed candidate, real checks and reporting receipt. No merge/deploy/acceptance by worker. Codex handles authorized release and actual newly generated all-option native checks on useful review handoff, ordinary request and completion, with model/path coverage limits explicit.

This is an existing-context contract correction, not a new feature. Historical retirement remains excluded.
