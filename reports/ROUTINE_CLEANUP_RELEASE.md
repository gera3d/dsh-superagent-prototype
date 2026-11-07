# Combined routine cleanup release

Base: exact qualified installed source 9992decdacf43b93be04faf4858efbb2ed88a03a, including the earlier live launch-retry and nonblocking startup inbox fixes. Source target: superagent-core. Worker artifacts: sandbox PRs 181, 183, 185, 186, 187 and 189. Artifacts are not independently deployable acceptance records.

## Independent review and corrections

- Recovery: keep generic transient retry/backoff, but use availability fallback immediately for explicit quota, cooldown, budget/account exhaustion and 429. The three retry/reset/pause regressions retain behavioral assertions. No broad numeric status shortcut suppresses quota fallback.
- Instructions: remove redundant worker restart wording while retaining the shared worker guard. Preserve the installed named gh-agent publication CLI and exact-head verification contract. Carry legacy merge thresholds in migration instead of reverting deployment instructions to generic/manual-only defaults.
- Routing: require eligible managed routes, guard inherited helper/auto-ranker defaults and existing session requests, rebind the guard after model selection, and refuse activation on an unavailable or parked economy provider. UI and execution share a browser-safe resolver. Portable default, explicit deployment preset, saved priorities, credentials untouched, manual reset reminders.
- Dispatch: FIFO admission up to configured worker capacity, subtract active ordinary work, retain same-finding prior-work quiescence, atomic binding and current pause/capacity checks.
- Settings: test all seven existing groups and last-opened-group persistence.
- Evidence: native explicit record operation uses existing protected endpoint, current revision, retained drafts on conflict, separate verified attestation and requirements acceptance. No new authority header or automatic acceptance.

## Checks

141 focused review regressions passed. Type check passed; build passed. Initial full suite: 2147 passed, two skipped, six failures; all six were corrected or confirmed as a subprocess timing failure and passed in a 74-test recheck without relaxing the timeout. Final stable-candidate full suite: 2154 passed, two skipped, zero failures (120 passing files). Type check and build pass. Subsequent results and live proof belong in PROJECT_STATUS.md and the deployment evidence record.

## Deployment and rollback

Deployed and verified through backend PR #33, merge fb591843c3f9ff19965a49e45a4157ed195fc890. Exact changed installed files match the qualified base. A new rollback copy preserves source, prompts, docs, built assets and SQLite snapshots. Final checks passed before deployment. Native verification passed for service readiness, effective routing settings, all seven navigation groups and return behavior, protected evidence rejection (403), and explicit evidence recording plus requirements acceptance. All three cleanup findings are resolved; no worker review remains pending. Preserve failures and limitations rather than declaring completion from a worker's ready report.
