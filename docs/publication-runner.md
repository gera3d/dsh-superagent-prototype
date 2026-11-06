# Track A / issue 159: pinned publication runner

## Implemented, not deployed

The adapter in [publication-runner.ts](../src/infra/publication-runner.ts) implements the `PublicationAdapter` contract in [publication.ts](../src/app/publication.ts). The tests in [publication-runner.spec.ts](../tests/publication-runner.spec.ts) combine stubbed adapter transport with an actual disposable phase-script fixture: patch application/rollback is confined to temporary files, while build/restart tools are harmless log-writing stubs. No GitHub merge, installed-source mutation/build, live restart, or production deployment verification was executed.

`loadPublicationRunner(configPath)` is synchronous. A missing configuration returns `undefined` (publication disabled); malformed/present configuration throws. `pinsFor(repository, prNumber)` returns a copy of the operator-configured release binding, never request-selected patch contents. `createPublicationRunner(config, executor?)` permits deterministic transport stubbing in tests.

## Read-only baseline inspection

1. Sandbox evidence [docs023](../../evidence/docs/023-senior-developer-helper.md) explicitly prohibits autopilot live apply/restart (section 4.5). Publication must remain an independently human-authorized flow, not permission inherited from helper/autopilot settings. The evidence [auto-merge gatekeeper](../../evidence/scripts/auto-merge-gatekeeper.sh) does not actually run its advertised verification before merge, lacks exact-head matching, and swallows pull/fetch errors. It is not reused.
2. Live [Stage 9.2 runner](</Users/gerayeremin/Documents/deepseek-harness/default-workspace/go-live-9-2/stage-9-2-go-live.sh>) validates stacked patches, applies 9.2/9.3, builds/tests, and only prints restart/full rollback. Live [Stage 9.4 runner](</Users/gerayeremin/Documents/deepseek-harness/default-workspace/go-live-9-4/stage-9-4-go-live.sh>) preserves 9.1–9.3, applies only 9.4, uses the unchanged exact 12-failure test baseline, and prints operator-only restart/rollback. Both explicitly warn about partial apply and reversing only successfully applied patches. Neither exposes independently runnable phases.
3. Observed backend checkout HEAD: `c832b862367ffe1791f208b2c9a0517803194007`; live backend HEAD: `dbf9410f07cecdb9a855bb98c42a6b105dcf73cc`, with many uncommitted changes. Read-only remote HEAD queries returned origin `7665d764ff8c170fcc09f10cc3e33c8b7462e30e` and upstream `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. These are observations, not a claim that dirty live sources equal either commit. The installed [DSH package manifest](</Users/gerayeremin/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json>) reports `0.2.1-rc.3`; this backend declares alpha.2 development dependencies. No installed source was edited.

## Trusted operator manifest

The runtime integration uses a local `publication-runner.json` under its state directory. It must not be writable by request/card/agent configuration APIs. Do not add a default that points at legacy go-live scripts. The strict JSON schema is exported as the TypeScript input type `PublicationRunnerConfig` and accepts only:

```typescript
{
  version: 1,
  pins: { repository: 'owner/repo', prNumber: 159,
          headSha: '<40 lowercase hex>', patchSha256: '<64 lowercase hex>' },
  ghPath: '/absolute/path/to/gh',
  cwd: '/canonical/absolute/operator/release/directory',
  patch: { path: '/canonical/absolute/release.patch', sha256: '<same patch digest>' },
  timeoutMs: 600000, // preparation default; supported 1000..900000
  scripts: {
    apply:    { path: '/canonical/absolute/apply.sh', sha256: '<64 hex>', dependencies: [] },
    build:    { path: '/canonical/absolute/build.sh', sha256: '<64 hex>', dependencies: [] },
    restart:  { path: '/canonical/absolute/restart.sh', sha256: '<64 hex>', dependencies: [] },
    verify:   { path: '/canonical/absolute/verify.sh', sha256: '<64 hex>', dependencies: [] },
    rollback: { path: '/canonical/absolute/rollback.sh', sha256: '<64 hex>', dependencies: [] }
  }
}
```

Preparation exposes `--timeout-ms` and emits a **600,000 ms per-phase default**, with strict bounds **1,000..900,000 ms**. This budgets build plus the complete test run together; the observed installed baseline tests alone took 142.645 seconds, so a 90-second release default was insufficient. Set a reviewed measured margin within the hard cap. Hand-authored legacy manifests that omit the field still inherit the adapter's 90,000 ms default; use preparation for usable release configuration.

Each dependency is `{path, sha256}`. Paths must be absolute/canonical (symlink aliases rejected), files regular, hashes lowercase SHA-256. All five script paths must differ. Configuration is parsed and copied once; later manifest edits require reconstructing the adapter. No script arguments, shell snippets, environment overrides, or arbitrary commands are accepted from requests.

## Execution contract

1. **Evidence and merge:** `gh pr view` observes the exact configured PR/head, checks, review, state and mergeability. Missing/empty checks remain pending, non-approved review remains required, unknown PR state fails. Evidence never grants authority. Merge uses `gh pr merge <number> --repo <repo> --squash --match-head-commit <head>` with no `--admin`, auto-merge, or branch-name substitution. GitHub protection remains authoritative for check/review changes racing a merge.
2. **Apply/build/restart/verify:** the service owns sequencing, durable operation IDs, authorization, write-ahead records and replay prevention. Before normal operations, the adapter checks every phase script, declared dependency, and the patch against configured digests. It runs captured, hash-checked script bytes through `/bin/bash -s --` on stdin (not a mutable script pathname), with no interpolated request command. Structured `PUBLICATION_*` environment values bind stage, operation ID, repository, PR, head, patch hash and path. Scripts receive no positional arguments; scripts must not rely on `BASH_SOURCE` resolving to their original file. Working directory is configured and canonical.
3. **Rollback:** independently checks only the rollback script and its declared dependencies, not broken forward scripts, GitHub availability, review/check state, or the original forward patch. If rollback consumes that patch, declare it as a rollback dependency. No automatic rollback/restart runs after a failed stage. A timeout/failure is an uncertain side effect, not proof of no changes; the service must preserve its interrupted/failed record and require reconciliation.

The subprocess transport uses `shell:false`, an allowlisted baseline environment (plus structured binding values), bounded output, disabled prompts and a timeout. GitHub authentication should use the operator's existing `gh` configuration; ambient token variables are deliberately not forwarded. Configured `ghPath`, `/bin/bash`, PATH tools, their execution environment, and operator scripts are trusted local capabilities, not a hostile-script sandbox. A compromised local operator account can replace assets/configuration.

## Required phase-script invariants before activation

**Production activation remains blocked on operator configuration/review and a production rehearsal.** Checked-in conservative phase entrypoints now exist under [scripts/publication](../scripts/publication/runner.py). They are executable implementation, not merely proposed adapters; fixture tests exercise them only against disposable files and fake build/restart tools. The legacy monolithic runners must not be configured under multiple phase names or wrapped into an apply phase that also builds/tests/restarts. This change deliberately ships no production deployment manifest.

1. **Apply:** check every target and stacked patch before the first live mutation, refuse incompatible context, preserve dirty source changes, and create a durable preimage/partial-apply ledger keyed by `PUBLICATION_OPERATION_ID` before any write. Bind the patch to the reviewed PR/head. All sidecars consumed by scripts belong in the manifest dependency list. Script/dependency/release storage must remain operator-controlled and immutable during execution; checked sidecar paths can otherwise race after hashing.
2. **Build/restart/verify:** build/test only the intended affected packages and retain the exact known-failure ledger/comparator (never broaden the baseline). Restart only the intended service with separately authorized publication. Verification must prove the existing GUI URL after refresh and observe actual expected behavior, not merely build success or an HTTP 200. Preserve health/version evidence. No replacement server counts as deployment.
3. **Rollback:** reverse only this publication's actually applied changes, in reverse order; preserve prior stages and unrelated dirty changes. Restore/rebuild prior artifacts and intentionally recover service state according to the captured ledger. Rollback must work after partial apply, build failure, failed restart, or failed verification. It must reject an unavailable/ambiguous preimage instead of blindly applying the full printed rollback. A GitHub merge is not automatically reverted by local rollback; any GitHub revert needs its own reviewed flow.

## Checked-in conservative phase implementation

The [Python phase implementation](../scripts/publication/runner.py) is invoked by the distinct [apply](../scripts/publication/apply.sh), [build](../scripts/publication/build.sh), [restart](../scripts/publication/restart.sh), [verify](../scripts/publication/verify.sh), and [rollback](../scripts/publication/rollback.sh) entrypoints. The wrappers use `/usr/bin/python3` and expect `publication-runner.py` plus `publication-plan.json` in the trusted release cwd. Copy the checked-in Python implementation to that name; list its hash, the plan hash, restart script hash, and any consumed tools/sidecars in **every phase's dependencies**. This is operator installation/configuration, not an HTTP operation.

The plan is strict JSON with exactly these fields:

```typescript
{
  version: 1, repository: 'owner/repo', headSha: '<40 hex>', patchSha256: '<64 hex>',
  target: '/canonical/absolute/package/root',
  pnpmPath: '/canonical/absolute/path/to/pnpm',
  restartScript: { path: '/canonical/absolute/operator/service-script', sha256: '<64 hex>' },
  verifyUrl: 'http://127.0.0.1:3082/explicit-release-health',
  verifyContains: '<release-specific marker>'
}
```

1. **Scope and recovery:** one target root per configured release, `-p1` text modifications/additions only. Deletions, renames, binaries, quoted/ambiguous filenames, mode changes, `.git` paths, traversal and symlink targets are rejected. Apply checks the full patch before mutation, computes postimages on touched-file copies, captures dirty preimages, fsyncs backups and a write-ahead ledger, and checks again before apply. The private release ledger is keyed by the service publication UUID, not a caller-chosen path. Failed/partial apply is recoverable when each target matches its recorded preimage or postimage. Ambiguous/corrupted state fails closed.
2. **Actual fixed operations:** build invokes the configured executable with `build`, then `test` by default; it never accepts arbitrary request arguments. An optional reviewed, hash-pinned complete Vitest baseline enables the exact comparator described below; missing/invalid baseline keeps the default fail-closed behavior. Restart executes only the hash-checked configured operator script with the fixed argument `restart`. That script must use a proper service manager or launch the daemon into its own session; leftover descendants in the publication process group are terminated. Verify requires HTTP 200 plus the configured release-specific marker from the operator-bound existing loopback URL, rejects redirects/proxies, and caps response bytes. The marker **must contain the exact head SHA or patch SHA-256**, so a healthy old listener lacking this release identity fails; release preparation rejects arbitrary generic markers. It does **not** count as browser/UI verification.
3. **Rollback:** preflights all targets and preimages before restoring anything, refuses later operator edits, restores exact dirty preimages/modes, removes only exact verified files newly added by this publication, then rebuilds/tests. If restart was attempted it invokes the configured restart script again to recover the old service. It does not automatically verify the old service against the **new** release marker; independent restored-version/UI verification remains mandatory. It never reverts GitHub history. Combined multi-package qualification remains an integration dependency; each configured publication targets one repository/package and serializes independently through the shared publication lock. The exact current-baseline comparator below is implemented, not deferred; it never reuses the older Stage 9 failure list.

The subprocess transport launches a detached POSIX process group and awaits TERM→KILL cleanup, including normal parent exit, before returning and allowing the publication lock to release. The fixture timeout test includes an ignored-TERM descendant and verifies its delayed write cannot survive cleanup. Trusted scripts must not deliberately escape supervision except the intended service-manager daemon; this is not an OS-level sandbox.

## Release preparation and local independent evidence

[record-evidence.py](../scripts/publication/record-evidence.py) creates the strict local attestation from **actual** `pnpm typecheck`, `pnpm test`, and `pnpm build` results on a clean linked review worktree whose HEAD is checked against GitHub before and after checks. It requires an existing independent approved review report and its actual completion timestamp; it does not generate a review, approval, or fake successful report. Failed checks retain logs and do not create an approved attestation. An operator-pinned attestation is provenance from the trusted review process, not cryptographic proof of the reviewer identity or a replacement for explicit publication authority.

```bash
/usr/bin/python3 scripts/publication/record-evidence.py \
  --repository owner/repo --pr 159 --patch /absolute/release.patch \
  --worktree /absolute/clean-linked-review-worktree --gh /absolute/gh --pnpm /absolute/pnpm \
  --review-report /absolute/independent-review.md --reviewer Codex --author worker \
  --review-approved --review-completed-at '<actual ISO timestamp>' \
  --output-dir /absolute/new-evidence-directory \
  --limitation 'Browser acceptance not yet performed'

/usr/bin/python3 scripts/publication/prepare.py \
  --repository owner/repo --pr 159 --patch /absolute/release.patch \
  --target /absolute/known-package-root --release-dir /absolute/new-release-directory \
  --gh /absolute/gh --pnpm /absolute/pnpm --restart-script /absolute/operator-service-script \
  --verify-url http://127.0.0.1:3082/explicit-release-health \
  --verify-contains '<release-specific marker>' \
  --local-evidence /absolute/new-evidence-directory/local-evidence.json
```

[prepare.py](../scripts/publication/prepare.py) observes actual PR metadata through `gh`, refuses existing release directories, copies the patch and phase package, and emits the complete strict runner manifest and plan with dependency hashes. It does **not** install that manifest into runtime state or execute any deployment phase. The operator can review/install its generated manifest through the separately authorized integration flow; no manual JSON/script assembly is required.

1. Optional manifest fields are `localEvidence: {path,sha256}` and `localEvidenceMaxAgeMs` (default one hour, hard maximum 24 hours). The attestation binds exactly the repository, PR, head and patch and includes `author`, independent `reviewer`, approved `review` with actual timestamp/hash-pinned report, nonempty successful `checks` with actual timestamps/hash-pinned reports, and `limitations`. Every report is checked again for freshness and digest on every evidence observation.
2. Local evidence substitutes only for an **absent** hosted check list or **absent** hosted review decision. Failed/pending hosted checks, `CHANGES_REQUESTED`, branch protection, wrong heads, changed reports, stale records, same reviewer/author identity and unknown states remain blocking. Exact-head `gh` merge remains unchanged, without `--admin`. The card can display the actual local reviewer, report digest, check names/report digests/timestamps, and limitations via `PublicationEvidence.local`. The adapter also provides `local.reviewExcerpt` (maximum 6,000 UTF-16 code units) and `local.checks[].outputExcerpt` (maximum 2,000), decoded directly from the **same hash-verified report buffers**. ANSI/terminal escapes and remaining C0/C1 controls are stripped; hashes still identify the complete original bytes. Excerpts are plain display text, not executable content or report-fetch URLs; no filesystem path API is exposed.
3. The legacy release directory [canonical-sync-release](</Users/gerayeremin/Documents/Projects/Manage-Builder/canonical-sync-release/live-verification.json>) contains newer canonical-sync patches, preserved archives/dirty diffs and a live-verification record; its verification record was inspected read-only. These artifacts are evidence of the prior release, not executable split phase scripts, and are not reapplied by this implementation. Production patch content must be prepared against current installed customizations, never selected by resurrecting older Stage 9 patches.

**Cancellation and write-ahead child identity:** `evidence` and `perform` accept optional `AbortSignal` and process-group callbacks. The transport starts a detached group behind a fixed stdin execution gate, invokes the synchronous PID callback before releasing any command/script bytes, and never starts the actual command if journaling fails. Cancellation, timeout, output overflow and normal child exit all await group cleanup; pre-aborted calls never spawn. The service/coordinator must durably save PID ownership/start identity and safely settle orphan groups before lock takeover. Deliberate group escape and uninterruptible kernel tasks remain OS limitations; no unsupported claim of arbitrary-process sandboxing is made.

## Exact current-baseline test gate

The [baseline comparator](../scripts/publication/baseline.py) and independent [unhandled-error reporter](../scripts/publication/errors-reporter.cjs) support known installed-baseline assertion failures without a broad waiver. The optional plan field is:

```typescript
baselineReport: {
  path: '/canonical/absolute/immutable-vitest-report.json', sha256: '<reviewed SHA-256>',
  baselineHead: '<actual 40-hex tested commit>', root: '/absolute/original-baseline-worktree'
}
```

1. Both baseline/current reports must be complete and internally consistent. Identity is relative test file + exact full test name + stable occurrence ordinal for legitimate repeated names; repeated-name multiplicity may not change. Every prior case must remain present, every formerly passing case must pass, and every known failure must still be tested (not skipped). Added uniquely named passing cases and known failures becoming passing are permitted. Only exact known failing identities with the **same SHA-256 of actual failure messages** are allowed; normalization strips ANSI color and replaces only the respective checkout root. Any different assertion under an unchanged name fails closed.
2. Build and rollback run real `pnpm exec vitest run --cache=false` with JSON, default output and the separately pinned unhandled-error reporter. Raw output, complete JSON and unhandled-error report remain in the durable ledger. Only normal exit codes 0/1 consistent with the full assertion report are accepted. New/changed failures, lost/skipped cases, collection/runtime/snapshot errors, unhandled errors, interrupted runs, corrupt reports and tampered baseline/helper/reporter block the operation. No count-only matching, wildcard allowlist or automatic rebaselining exists.
3. Preparation accepts `--baseline-report`, `--baseline-head`, `--baseline-root` and copies/pins all baseline assets into the generated release. Evidence recording accepts the same options plus mandatory reviewed `--baseline-sha256`, runs actual checks, records raw Vitest exit status and comparator results, and adds the exact baseline hash/commit limitation to the card evidence. Preparation rejects a local attestation that omits this baseline limitation. Default behavior without baseline remains a fully passing `pnpm test` requirement.

A real read-only sanity check against the parent's immutable **current shipped** report [immutable-baseline.json](../../immutable-baseline.json), SHA-256 `7f174e37bd15abf2371bcff0e9b3809fd4645fc9afafd3d39d06ca93a5abc79d`, for `c832b862367ffe1791f208b2c9a0517803194007` returned **1,735 tests / 10 exact known failures / 0 changed failures**. Its recorded root is the sibling baseline worktree. This validates parsing/comparison of the actual current report; it does not imply a new candidate passed checks or a deployment occurred. Do not substitute the older Stage 9 or older `32c8dc7` failure list.

## Canonical cards, restart ownership and operator handoff

The runtime and independent inbox provider project the same durable publication onto the original canonical lifecycle decision. Conversation uses an independent privileged dock even when Next steps owns suggestions; Workstream dynamically consumes the optional `publicationCards` renderer without a required injection. Lifecycle controls never enter suggestion scoring, chat staging or native Send. Closed original decisions retain progress/recovery without rewriting their history. A serialized ticket fence permits only the expected successful exact-PR merge/end transition; newer work, human stops, different PRs and changed pins invalidate continuation. GitHub second-resolution merge timestamps are handled at that precision, not confused with a stale earlier-second merge.

`POST decisions/:id/lifecycle` accepts only a fixed action and UUID-bound publication/request identity; caller-provided authority, commands and configuration are rejected. Explicit approval is validated at the trusted local same-origin browser boundary. This does **not** authenticate against hostile processes under the same OS account: those processes can already invoke local capabilities. Autopilot never calls this path; structured lifecycle/actionKind metadata is independently denied by the companion pilot.

One approval queues a durable single-use exact-manifest grant. A detached coordinator, not the web host, owns merge/apply/build/restart/verify and the execution lock. Restarting only the host preserves that coordinator; a real harmless host-replacement subprocess regression covers this handoff. Each phase outcome is write-ahead persisted independently. Same-head transient post-merge evidence is retried with bounded **read-only** observations; completed mutations never repeat. Lock compromise aborts the supervised group and awaits settlement; observed process birth identities prevent unrelated recycled PIDs masquerading as the old owner. Unknown coordinator loss remains quarantined, not automatically replayed or rolled back.

The protected trusted-local CLI is `node lib/publication-operator.js approve-publish|rollback` with exact state/publication/head/patch/actor and a preexisting owner-only instruction record. It is a Codex/operator entrypoint, **not** an HTTP or autonomous-agent tool, nor a natural-language permission parser. The instruction proof and its digest/reference are retained in the grant audit. `reconcile-interruption` is separately bound to a specific grant and explicit process-settlement evidence; it records reconciliation only, never executes rollback. A subsequent explicit rollback uses the normal pinned runner. See the strict record and argument definitions in [publication-operator.ts](../src/app/publication-operator.ts). No credential/model/settings modification is part of preparation or publication.

Repository/package publication is serialized per configured release. Coordinating multiple packages remains an integration dependency: qualify the combined backend/plugin revisions first, then prepare their distinct pinned releases without interleaving operations. The scripts never resurrect superseded Stage 9 patch files.

## Verification limits

The final expanded targeted suite passed **28/28 tests** (30.60 seconds), including ten exact-baseline regression scenarios and a real phase build/rollback fixture with known assertion failures, including real temporary-file apply/build-stub/restart-stub/health verification/rollback, generated manifest loading, exact-head local evidence and hard-hosted-failure behavior, dirty-preimage preservation, refusal to overwrite later edits, abort handling, journal-before-execution gating and descendant termination. The final repository-wide `tsc --noEmit` invocation exited **0**; earlier transient sibling contract errors were resolved by their owners. Tests cover exact-head command construction, configured pin discovery, evidence fail-closed states, pinned phase input, tamper rejection, rollback independence from corrupted forward script, invalid config rejection, and subprocess-error propagation. They do not prove live patch compatibility, actual restart authority, recovery of dirty workspaces, browser behavior, package-version compatibility, or a successful deployment. Those require operator-reviewed phase scripts and a separately authorized production rehearsal.
