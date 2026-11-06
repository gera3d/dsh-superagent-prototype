# Historical delivery backfill: sandbox #159 / #160

**Preview is read-only. Both deliveries remain pending native acceptance.** No live database was opened for writing during qualification, no release candidate was created, no worker was reopened, and no publication was queued. The separately gated apply command is for an operator's later, explicit invocation after reviewing the exact records hash.

## Run the offline preview

From the backend checkout (Node 24.13.0 used; type transformation is needed by the imported store):

```sh
node --experimental-transform-types scripts/delivery-backfill-preview.ts \
  --preview docs/018-delivery-backfill.json
```

The [CLI](../scripts/delivery-backfill-preview.ts) parses the [public-safe input](./018-delivery-backfill.json), validates exactly one intake each for #159/#160, and invokes `DeliveryStore(':memory:').previewBackfill(records)`. It asserts zero in-memory deliveries/outbox entries afterward, then closes that store. Preview cannot accept database, authority, or extra arguments; it makes no network requests and does not inspect installed paths.

Output is deterministic JSON: `mode`, `readOnly`, `documentFingerprint`, `recordsFingerprint`, and the actual store preview. No timestamp, random ID or machine path is generated. Store fingerprints are SHA-256 over the store's recursively key-sorted serialization, **not** the file's raw bytes; array order matters.

| Reviewed input | Fingerprint |
| --- | --- |
| `recordsFingerprint` (apply authority scope) | `2869297451ff5713717c0c561c963fa72c46222a79130cba8b37ec841506243b` |
| `documentFingerprint` (including provenance envelope) | `400ee3ad434ee16db15604590f44d93eafe9eeb4df0e7ef6e28ffe06022c0901` |

Both preview entries have `stage: verifying`, `state: blocked`, no acceptance, and the blocker “Read-only backfill preview; intake acceptance requires explicit verification.” Apply uses its own historical-evidence blocker and does not dispatch actions.

## Actual bindings and source review

The input's `records` array has the exact `DeliveryBackfillRecord` fields from [the backend contract](../src/app/feature-delivery.ts). Top-level qualification and attempt metadata is provenance for operator review, not additional store fields or acceptance evidence.

| Intake | Immutable sandbox evidence head | Actual code PR heads |
| --- | --- | --- |
| [#159](https://github.com/gera3d/superagent-sandbox/issues/159) | [PR162 / f73f8228e46ecd768ac7f910ca16f7dc332fdaf5](https://github.com/gera3d/superagent-sandbox/pull/162) | [backend25 / 5888087bb17d59eef8959e0a82382a879dcf0b5f](https://github.com/gera3d/dsh-superagent-prototype/pull/25), [backend26 / 4461d3ff3e473d42feff6dff8fc376438a737a79](https://github.com/gera3d/dsh-superagent-prototype/pull/26), [plugins6 / 562b0b792f634ac2d36cb9b14ca2cb4fcee3dce5](https://github.com/gera3d/dsh-plugins/pull/6) |
| [#160](https://github.com/gera3d/superagent-sandbox/issues/160) | [PR161 / dd669e476872b89cdd146f02a3e939480a2ac565](https://github.com/gera3d/superagent-sandbox/pull/161) | [backend24 / 82a5828841f66686506756eecc0379b090e3b592](https://github.com/gera3d/dsh-superagent-prototype/pull/24), [plugins5 / 535f9dfe8f5d9745877caeea61a49a478b14f91b](https://github.com/gera3d/dsh-plugins/pull/5) |

`bindings.repository/baseSha/headSha` anchor the sandbox evidence PR snapshot, not the installed backend's HEAD or a deployable patch. Both sandbox evidence PRs had base `15c7dc72e0f7f2d54383e3e3bbc86d190cf49484`; `refs` bind code PR heads. Actual `gh pr view` independently confirmed all seven implementation/evidence PRs are merged. Installed qualification records identify backend merge `f388ad81988eaee2037a88b65e6554b0ebee4839` and plugin merge `2721b197ef44d0b682303733e575fd13a015d261`.

PR26 is a later Runtime HTTP facade correction: PR162's earlier report does not itself attest this fix. Its actual PR head/merge and the installed qualification record supply that provenance. The #159 implementation observation is dated at PR26's merge; historical attempt evidence is dated at the installed run record's final update, not an invented exact rollback completion time.

Stored `workers[].id` values are **bare ticket IDs**, not session IDs or assignment IDs. The delivery projection adds `worker-` exactly once to link the original conversation; no worker is newly created:

1. #159 stores `3b4864f597572937fdf1c6b7c019c1d6`, projecting session `worker-3b4864f597572937fdf1c6b7c019c1d6`; historical assignment `33cc0964b0fe53fe203488639a19f424`; ended/merged at `2026-11-06T09:04:32Z`.
2. #160 stores `a8ecebad8bea17f9dc48a704c5f5ed7e`, projecting session `worker-a8ecebad8bea17f9dc48a704c5f5ed7e`; assignment `966dbc6147deb276b1c9fa48b8e3f574`; ended/merged at `2026-11-06T09:04:28Z`, independently confirmed with an SQLite `mode=ro` query because the supplied historical ticket extract excludes #160.

For #160, the implementation evidence time `09:04:28Z` is the independently verified actual PR161 merge time, **not a passed review verdict**. Read-only original-inbox inspection shows its pending source-empty generated advice was created at `08:35:29.270Z`, before that merge. Currency reconciliation can therefore retire that generated advice only under the audited ended/merged backfill; it must preserve real unresolved user questions and post-merge advice. The checked-in-input regression asserts both exact session projection and this temporal distinction.

The private ticket/decision extracts were reviewed locally only. No raw reports, conversation contents, credentials, database paths, local account paths or decision payloads are copied into this public input.

## Observed qualification and preserved failures

Four local qualification records were independently read and hashed. The input retains only their relative names, observed SHA-256 values and minimal outcomes. These are local observations, **not publicly hosted attestations**; public evidence references point to the actual GitHub PRs/reports, not to invented uploads of private records.

The installed run record reports backend **1873 passed, 10 matched baseline failures, 2 skipped, zero unhandled errors**; Next steps **16 Node / 177 UI tests passed**. These historical automated checks are not native acceptance.

| Attempt | Exact candidate head | Preserved result |
| --- | --- | --- |
| [PR164](https://github.com/gera3d/superagent-sandbox/pull/164) | `d8c75bd148e6182d135117d15fa4c3e5f9c129c7` | Merge/apply/build/restart passed; test verification failed; protected rollback passed; original bundle/document absence independently checked. |
| [PR166](https://github.com/gera3d/superagent-sandbox/pull/166) | `fccfcf3bb8a4864fd35df705bd65d9640457e0ec` | Merge/apply/build/restart passed; bounded verification failed during historical GitHub API rate exhaustion; protected rollback passed and independently checked. |

These attempts are associated historical evidence under the #159 intake bindings; **their artifact heads remain separately recorded** and are not relabeled as the feature code/evidence head. Failed publication and successful rollback are both retained in the store evidence. There is deliberately no passed publication, native verification, or acceptance evidence; rollback success never means publication success.

The old qualification records mention a Mac lock and exhausted GitHub quota. **The Mac is now unlocked according to the current operator instruction.** Neither historical condition is asserted as a current blocker. Current quota/health is not inferred from an old record or a successful read-only PR query.

## Pending acceptance and limitations

1. **#159 — `native-browser-one-click`: pending.** Prior controlled captures, fixture hooks and CLI approvals do not prove the actual native browser one-click path. No physical human click is claimed.
2. **#160 — `ordinary-conversation-native-pilot`: pending.** Automated/native-submission policy tests do not prove a real bounded pilot in an ordinary conversation. Default OFF must remain intact.
3. **No deployment authority is inferred.** Binding a historical snapshot is not a current-head review or a release manifest. These records cannot authorize publication, bypass explicit acceptance, or prove current installed source identity.

## Operator review → explicit apply → compensating rollback

### Review and apply

1. Inspect the complete public input and both fingerprints; independently compare the local qualification hashes, code PR heads, ended-worker status and historical outcomes. Confirm the sandbox evidence snapshot binding is the intended delivery identity. Review `applyBackfill` in [the store](../src/app/feature-delivery.ts): it requires exact records hash and structured local-operator authority, atomically creates blocked/verifying aggregates, preserves evidence and does not touch worker rows or enqueue publication.
2. Obtain an explicit operator instruction naming the database and reviewed records hash. Take a consistent SQLite backup including WAL state using the installation's supported backup procedure; do not copy only the main file while live writers run. Confirm no existing delivery ID conflicts. The CLI requires an **absolute existing regular database file**, has no default live target, and checks arguments/hash plus an in-memory preview before opening that target.
3. Only that operator, after review, invokes the following template, replacing both placeholders with actual authority and database location. **This command was not run against the live database.**

```sh
node --experimental-transform-types scripts/delivery-backfill-preview.ts \
  --apply docs/018-delivery-backfill.json \
  --database /ABSOLUTE/EXISTING/operator-selected.sqlite \
  --review-hash 2869297451ff5713717c0c561c963fa72c46222a79130cba8b37ec841506243b \
  --actor OPERATOR_ID \
  --reference EXPLICIT_REVIEWED_OPERATOR_INSTRUCTION
```

The CLI passes `{source: 'local_operator', actor, reference, scope: recordsFingerprint}` to `store.applyBackfill`; argument strings are an audit assertion by the local operator, not an identity authentication system. Restrict process/database access accordingly. It never calls a capability adapter/coordinator or confirms an action. Exact repeat of the same reviewed records, actor and reference is idempotent; conflicting existing IDs fail atomically. Provenance-envelope changes alter the document fingerprint but not the records fingerprint: review both, because the store imports only `records`.

### Post-apply verification and rollback

1. Verify exactly the intended two aggregates are blocked/verifying with both native requirements unresolved; confirm zero new publication outbox entries, unchanged worker rows, and unchanged historical publication/audit rows. Record input fingerprints, operator reference, new aggregate revisions and backup identifier in private operator evidence.
2. If the mapping is wrong, stop before any confirmation/dispatch. Record the bound rollback/correction observation through the trusted operator-evidence operation below so the intake stays blocked with append-only provenance. Do not offer an arbitrary `compareAndSwap` operator recipe, delete delivery/worker/publication rows, rewrite historical outcomes, or restore an entire old database over newer unrelated history. A binding correction/cancellation requires its own reviewed operation; this evidence CLI deliberately cannot rebind or cancel an intake.
3. If any later mutation exists, review that mutation independently before compensation. The backup is a recovery artifact, not a routine rollback instruction; a database-wide restore would lose concurrent history. Publication rollback remains the existing protected artifact-specific mechanism, never this backfill CLI.

## Isolated qualification of this CLI

Passed on Node 24.13.0: deterministic repeated previews; actual blocked/verifying output; isolated temporary-database apply and exact idempotent replay; no acceptance/next action/outbox entries; rejection of incomplete apply authority, preview database arguments, mismatched review hash (before opening DB), out-of-scope issue input, and mismatched evidence bindings. Seeded worker/publication/decision history rows remained byte-for-byte unchanged; an existing conflicting second delivery rolled back the entire two-record import. No live apply was executed.

Strict standalone script/store typecheck passed:

```sh
pnpm exec tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck \
  --allowImportingTsExtensions --types node scripts/delivery-backfill-preview.ts
```

## Trusted external native evidence operation

[The operator evidence CLI](../scripts/delivery-evidence.ts) implements the [explicit #167 operator-evidence requirement](https://github.com/gera3d/superagent-sandbox/issues/167#issuecomment-6688179061) through [the validated operation](../src/app/delivery-evidence.ts), `recordOperatorEvidence`, rather than exposing arbitrary database updates. This is a **trusted local-operator assertion**, not browser automation, a publication adapter, authentication, or proof that a physical human clicked anything. Restrict local process/database access; never invoke it merely because a worker or suggestion says acceptance passed.

### Collect and review a request

1. Perform the native acceptance separately under actual explicit authority. Capture its external evidence at an HTTPS provenance URL, with the observed exact repository/base/head/component refs and requirement IDs. Preserve sensitive captures privately. A new successful publication observation must genuinely reconcile the named historical rollback/failure; a browser screenshot alone is not publication evidence.
2. Prepare a private JSON **array of `DeliveryEvidence` records**. Each record needs a new stable `id`, `kind` (`publication`, `verification`, `acceptance`, or `rollback`), exact intake `bindings`, ISO `recordedAt`, HTTPS `reference`, and `outcome` (`passed`, `failed`, or `uncertain`). Verification/acceptance passes must name a nonempty `requirements` subset of the exact intake IDs. Omit `generation` to use the current generation, or supply that exact value. Do not fabricate an evidence URL, current installed head, successful outcome, or human-click provenance.
3. For intentional reconciliation only, a **passed publication** may list historical same-bound rollback IDs in `supersedes`; a passed observation may supersede failed/uncertain observations of the same kind. Targets must already exist at the exact current bindings/generation. Unknown, self, cross-kind, wrong-head or successful non-rollback targets are rejected. No old evidence is edited/deleted; no implicit blanket supersession occurs. All unresolved failure/uncertainty/rollback entries keep the intake blocked.

The private evidence file is intentionally not included here: neither native acceptance has yet been observed for these features. Do not reuse isolated test fixtures as real evidence.

### Offline request preview, then explicit recording

Obtain the actual current delivery revision through a read-only inspection. Preview constructs the complete reviewed request (`deliveryId`, `revision`, `evidence`, and `accept: true` only when requested) and outputs its deterministic `requestFingerprint` without opening any database. This is a request/hash preview, **not validation against current DB bindings**.

```sh
node --experimental-transform-types scripts/delivery-evidence.ts \
  --preview --delivery sandbox-159 --revision CURRENT_REVISION \
  --input /ABSOLUTE/PRIVATE/observed-native-evidence.json
```

After an explicit operator instruction reviews this exact request and fingerprint, record it against the named existing database. Replace placeholders with observed values; `--actor` must already be in the delivery's recorded authorities, not merely its display owner.

```sh
node --experimental-transform-types scripts/delivery-evidence.ts \
  --database /ABSOLUTE/EXISTING/operator-selected.sqlite \
  --delivery sandbox-159 --revision CURRENT_REVISION \
  --actor RECORDED_OPERATOR_ID --reference EXPLICIT_OPERATOR_INSTRUCTION \
  --input /ABSOLUTE/PRIVATE/observed-native-evidence.json \
  --expected-hash REVIEWED_REQUEST_FINGERPRINT
```

The input is cloned, validated and appended in a revision-fenced transaction. Audit records include the operator, instruction reference, operation hash and observation time; evidence preserves its own capture time/reference. The request hash includes the target delivery, revision, complete input and optional acceptance flag. Changing any of those requires a new review/hash. Repeating the exact successful request with the same actor/instruction returns the current delivery without adding duplicate evidence, audit entries or revisions, even when its original revision is now stale. A different request reusing an existing evidence ID is rejected.

### Reevaluation and optional acceptance

1. The operation only handles unsettled `verifying` deliveries, including blocked backfills. It rejects stale new requests, unrecorded actors, non-local authority, wrong hashes/bindings/requirements, malformed references/times, unexpected privileged fields, and any pending/leased/blocked mutation handoff. It cannot clear an outstanding mutation lease or rebind a head.
2. If adverse evidence remains, the intake stays blocked. Otherwise it becomes `awaiting_decision`; the store derives `verify` until publication plus native verification and all requirement coverage exist, then derives `accept`. Merely ingesting acceptance-kind evidence does **not** accept the delivery. Neither operation queues a publication, sends a conversation message, starts/reopens a worker, or alters historical publication rows.
3. Only if the operator separately and explicitly authorizes acceptance, add **`--accept` to both the preview and recording commands**. It changes the request fingerprint. The operation atomically calls `store.confirm` only for the newly derived `accept` action, using that action's current fingerprint and structured `source: local_operator` authority. If incomplete evidence cannot derive `accept`, the entire ingestion/acceptance transaction rolls back. No `human_click` provenance is invented. Acceptance and request ingestion remain append-only and exact replay is idempotent.

For #160 use `--delivery sandbox-160` and actual evidence covering `ordinary-conversation-native-pilot`; for #159 the requirement is `native-browser-one-click`. This interface does not assert that either acceptance has happened, and was qualified **only against isolated temporary databases**.

### Evidence operation qualification

[Regression tests](../tests/delivery-evidence.spec.ts) pass against the actual backfill input in temporary SQLite files: both source intakes; blocked-to-accept-eligible reevaluation; explicit atomic acceptance; idempotent replay across reopen; preservation of old evidence/audit/workers/publication rows; no publication outbox; invalid hashes/authority/revision/head/requirements/generation/IDs/references/times/supersession; active handoff protection; and actual CLI request-preview/record/replay paths.

```sh
pnpm exec vitest run tests/delivery-evidence.spec.ts
pnpm exec tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck \
  --allowImportingTsExtensions --types node scripts/delivery-evidence.ts \
  src/app/delivery-evidence.ts
pnpm typecheck
```

The checked-in-input projection regression imports the real runtime and therefore needs the project's module/Context augmentations; use the full project typecheck for that test rather than an isolated-file compiler invocation.
