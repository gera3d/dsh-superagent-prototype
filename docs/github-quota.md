# GitHub quota behaviour

**Existing efficiency (unchanged):** repository streams (`issues`, `comments`, `review-comments`) send `If-None-Match` with the stored ETag, so an unchanged list returns HTTP 304 and costs no quota; notifications honour `x-poll-interval` (minimum 60 s). PR head/base/check facts and publication data are never cached.

**Added:** a failed `gh api --include` now keeps only status, `x-ratelimit-remaining/reset` and `retry-after` (`CliError.rate`). A primary limit (403 with remaining 0) waits until the reset; a secondary limit (429, or 403 with `retry-after`) waits `retry-after` (60 s if absent). Both add up to 10 s jitter and are capped at 24 h. Health shows `paused: GitHub <kind> rate limit reached; polling resumes after <time>`; the next successful round reports `ready` again with no restart. Permission/auth (401, 403 without quota signals), 304 and 5xx keep the ordinary `pollFailures` path. Local workers are unaffected: only the GitHub poll loop sleeps.

**Representative workload** (one 60 s poll, quota exhausted for 10 min, mocked): before, 10 polls × ≥4 requests = ≥40 failing calls; after, 1 failing round, then one wait to the reset (+≤10 s jitter), then normal polling.

**Quota facts (official docs):** an authenticated user has 5,000 REST requests/hour shared across all that user's PATs, OAuth and user-authorized apps, so non-Harness consumers can drain it; Harness cannot attribute them. A GitHub App installation has a separate budget (minimum 5,000/hour, scaling with repos/users, higher on Enterprise Cloud). A paid personal plan does not raise the user limit. Moving to an App is a future option needing App registration, installation and a private key (new credentials and permissions), so it is not done here.
