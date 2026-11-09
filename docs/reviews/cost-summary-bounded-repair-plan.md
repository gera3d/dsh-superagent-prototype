# Next bounded repair: cost-summary correctness

## Existing evidence and approval boundary

The original cost-summary feature is deployed and accepted (PR45). The later verification finding1accfa18 is resolved for investigation only. Its explicit scope says: **"Do not ... implement fixes without a subsequent confirmed bounded decision."** The accepted independent review records nine distinct concerns, not nine unrelated features. Current installed job-usage, client and fixture hashes still match those verified defective sources.

## Concrete proposed implementation

1. Derive route attribution from surviving usage, so same-step replacement can clear an obsolete unattributed flag.
2. Deduplicate settlements with and without samples without losing genuine retries; make the existing retry test exercise the same actual step.
3. Avoid flushing/reading running-job usage that the browser does not display. Preserve final completed-job summaries and safe no-data behavior.
4. Bound the usage-fold cache and invalidate rewritten/recreated logs correctly, including equal-length rewrites with changed persistence revision. Preserve incremental append performance and unavailable-log semantics.
5. Separate usage reporting coverage from route-attribution wording; never imply missing attempts when all settled attempts reported usage.
6. Make the screenshot fixture use the public dependency import, configurable/portable browser lookup and a checkout-contained output path.

These six implementation areas cover the nine deduplicated concerns in docs/evidence/cost-verification-independent-review.json. No new pricing feed, quota reader, account integration, routing, credential, access, money/spend, concurrency, autoplay or new product feature is included. Do not guess dollar costs when no rate metadata exists. Do not reopen the accepted original feature or verification finding; link both into one separately confirmed repair finding.

## Finish line after confirmation

Harness owns one isolated current-source implementation, linked to original issue/evidence. Candidate must carry exact base/head/diff and a structured report. Meaningful regression checks cover all nine concerns, actual completed-job API/UI, retained cache/token semantics, real retry versus same-step replacement, read/flush counts and cache bounds. Codex independently checks the returned head, preserves rollback, reviews/merges, deploys at safe idle and verifies a real ended-job cost card in the installed app. Record progress through the supported canonical/operator path so Senior Developer advice stays current. Protect native final acceptance; no fabricated user choice or reply.

Existing publication diagnostic work is optional and remains separate. Three unbound historical delivery records retain missing source/target/requirements bindings; no bulk acceptance or publish is included.
