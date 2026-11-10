# GitHub quota candidate 711a443: correction required

Exact candidate 711a4434938c77824de322f3504af94bdbf9097a; base69ebba0. No quota changes installed.

Independent actual-header test passes: real CRLF parsing works (initial suspicion not confirmed). Independent server-deadline test FAILS: Retry-After7200 becomes3600; do not send before the server deadline. Bounded scheduling must recheck in segments without issuing HTTP early, or retain absolute not-before time.

Production pollRound still performs repository streams/ticket PRs/subscribed threads after a known notification quota error, and keeps performing further stream reads after quota. Quota exhaustion is account-wide; stop the round without advancing failed cursors, retain retry maps and health, then wait. Preserve nonquota independent-read behavior.

Worker evidence is honest about3 unit checks only, types terminated/build absent, no fake-clock watch integration. Existing docs label an analytic estimate mocked; replace that with measured fake-clock request counts. Add public-plugin watch proof: paused quota state, no calls before deadline, automatic ready recovery without restart, changed PR facts remain fresh. Test secondary increasing bounded backoff when no Retry-After, nonquota401/403/5xx and existing304/auth isolation, no live exhaustion.

Do not widen caching/publication/auth scope. Reuse isolated token-optimization/quota-r5 instead of broad rediscovery or fresh implementation. Add focused tests and correct source, commit cumulative patch, run types/build serially and preserve actual logs. No live edits/deploy by worker. Codex retains exact-head review/release and real-thread handoff pilot.
