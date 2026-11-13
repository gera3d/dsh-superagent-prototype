# GitHub quota behaviour

**Existing efficiency (unchanged):** repository streams (`issues`, `comments`, `review-comments`) send `If-None-Match` with the stored ETag, so an unchanged list returns HTTP 304 and costs no quota; notifications honour `x-poll-interval` (minimum 60 s). PR head/base/check facts and publication data are never cached.

**Added:** a failed `gh api --include` now keeps only status, `x-ratelimit-remaining/reset` and `retry-after` (`CliError.rate`). A primary limit (403 with remaining 0) waits until the reset; a secondary limit (429, or 403 with `retry-after`) waits `retry-after` (60 s if absent). Both add up to 10 s jitter and preserve the server deadline, splitting long waits into one-hour sleeps. Health shows `paused: GitHub <kind> rate limit reached; polling resumes after <time>`; the next successful round reports `ready` again with no restart. Permission/auth (401, 403 without quota signals), 304 and 5xx keep the ordinary `pollFailures` path. Local workers are unaffected: only the GitHub poll loop sleeps.

**Measured mocked workload:** the rejected first patch made four requests after an initial notification quota failure; the corrected production poll round makes one. A separate production-plugin fake-clock test records one request at the quota response, no further request during 7,199.999 seconds, and a second request with ready health at 7,200 seconds. No real account was exhausted or load-tested; account-wide usage is not attributed to Harness.

**Quota facts (official docs):** an authenticated user has 5,000 REST requests/hour shared across all that user's PATs, OAuth and user-authorized apps, so non-Harness consumers can drain it; Harness cannot attribute them. A GitHub App installation has a separate budget (minimum 5,000/hour, scaling with repos/users, higher on Enterprise Cloud). A paid personal plan does not raise the user limit. Moving to an App is a future option needing App registration, installation and a private key (new credentials and permissions), so it is not done here.

## Request telemetry

The harness now counts its own GitHub requests, so a quota number can be tied to the part that spent it. It makes **no extra request** for this: every count comes from calls already made through `Commands`, and the quota values come from the `x-ratelimit-*` headers of responses that already carry them (`gh api --include`, and failed responses). The optional `gh api rate_limit` refresh is not used.

**What is counted.** Each `gh api` call is recorded under a *caller* and a *masked endpoint*, with one outcome:

| Outcome | Meaning |
| --- | --- |
| `200` | plain success |
| `304` | conditional read, unchanged; **free** (costs no quota) |
| `2xx` | other success, such as a 201 after a write |
| `limited` | 403/429 carrying quota signals (the same test as `CliError.rate`) |
| `error` | any other failure, including a 403 without quota signals |

A paginated call counts one request per page. Callers: `poll-notifications` (including the Issue and PR reads a notification triggers), `poll-issues`, `poll-comments`, `poll-review-comments`, `poll-branch-ci`, `poll-ticket-pr`, `poll-ticket-checks`, `poll-thread`, and `other` for everything else (replies, tools, lifecycle checks). The startup check (`gh api user` and the repository read) runs before `Commands` exists, outside this counter: it costs 2 requests per start and is not included. Endpoints are templates: `repos/:o/:r/issues/:n/comments`; numbers become `:n`, commit SHAs `:sha`, refs and names `:x`, file paths `:path`, and the query string is dropped. Writes are prefixed with the method (`POST repos/:o/:r/issues/:n/comments`).

**What is kept.** Counts for the last 60 minutes in memory, and a daily summary of the last three UTC days in the state store (`github-telemetry`), written after each poll round, so a restart keeps the day's picture (the hourly window restarts empty). It holds counters plus the last `x-ratelimit-remaining`, `-reset` and `-resource` per resource; never tokens, other headers, request bodies or response bodies. The number of endpoint keys per day is capped; the surplus is counted under `other|:overflow`.

**Where to read it.** The GitHub source health `detail` ends with one line, for example `GitHub requests: 41 in the last hour (22 free, 0 limited), 380 today; top callers: poll-thread 18, poll-notifications 12, poll-comments 6; core quota 4713 left, resets 2026-11-13T21:00:00.000Z`. The same data is structured in `telemetry` on that health entry, so `GET sources` (the existing status route) returns it: `hour` and `day` totals (`requests`, per-outcome counts, `free`, `charged`), the top five `callers` and `endpoints` of the last hour, and `quota` (`remaining`, `reset` in epoch seconds, `resource`, `at`). The paused rate-limit health and the poll-failure health carry it too; their text is unchanged.

**How to read it.** `charged` (requests minus 304s) is what counts against the 5,000/hour limit. Compare `charged` for the last hour with the drop in `quota.remaining`: any gap is spent by something that is not this harness (another harness profile, or a Claude session on the same account), which is the attribution `account-wide usage` could not give before. Take a `charged` number before a quota fix and again after it. Each profile reports only its own counts, so add them for the account.
