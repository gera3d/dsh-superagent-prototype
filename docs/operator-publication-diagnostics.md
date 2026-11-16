# Operator Guide: Publication Phase Diagnostics & Failure Classification

## 1. Overview & Problem Scope

During bounded publication confirmation, the orchestrator advances through a strict lifecycle:
```
[Confirmation] ──► [Validation] ──► [Enqueue] ──► [Execution]
```

### Historical Context & Root Cause Status
* **Status**: The original pre-enqueue failure (~66ms confirmation window) cause remains **UNPROVEN**.
* **Distinction**: Offline synthetic tests and mock fixtures model potential hypothetical failure modes (e.g., simulated binding serialization faults or lock contention). These test fixtures do **not** claim or prove what specifically caused the historical failure.
* **No Blanket or Immediate Retry**: A pre-enqueue rejection does **not** permit blind or automatic retry. Every recovery attempt must proceed through the existing protected approval flow, re-verifying operator authority, configuration pin freshness, and single-use idempotency.

This diagnostic framework adds narrow, sanitized phase, category, and allowlisted cause tracking across the entire publication path without altering protected approval gates, one-use authority, or idempotency constraints.

---

## 2. Publication Lifecycle Phases

Every audit event is attributed to exactly one diagnostic phase:

| Phase | Boundary | Side Effects Possible? | Description |
|---|---|---|---|
| **`confirmation`** | UI click / explicit instruction | **No** | Local operator click or explicit instruction received and leased. |
| **`validation`** | Gate check & pin match | **No** | Pinned repository, PR, head SHA, and patch SHA256 verified against configured manifest. |
| **`enqueue`** | Pre-grant & grant journal | **No** (until grant) | Canonical ticket fence captured; single-use `workerGrants` entry persisted to disk. |
| **`execution`** | Detached worker process | **Yes** | Merge, apply, build, restart, verify, or rollback operations executed by detached worker. |

---

## 3. Failure Categories, Allowlisted Causes & Operator Action

When an operation stops, the `category` and `cause` in `PublicationAudit` and `PublicationOutcome` identify the failure class using fixed allowlisted values (no arbitrary exception or provider text is persisted):

### A. Before-Effect Rejection (`before_effect_rejection`)
* **Guarantee**: Zero worker grants recorded; zero Git or host mutations executed; publication status remains `prepared`.
* **Delivery Outcome**: Classified as `outcome: 'failed'` (`uncertain = 0`). Delivery outbox lease completes with `uncertain = 0`.
* **Interrupted Handoff & Uncertainty Boundary**: Definite before-effect rejection is strictly gated on explicit trusted exact-ID proof (e.g. audited `before_effect_rejection` event or verified stale configuration pins with an exact matching snapshot and no durable grants). The orchestrator never infers zero effects from an absent or mismatched snapshot, or indirect ticket lookup failure (such as index loss during handoff). Missing or unproven state retains baseline fail-closed reconciliation (`outcome: 'uncertain'`) with no zero-effects claim.
* **Specific Categories & Allowlisted Causes**:
  - **`pre_enqueue_binding_failed`** (`pre_enqueue_binding_serialization_failed`): Binding capture or serialization error during pre-grant preparation.
    - *Action*: Inspect coordinator environment and ticket fence state. Requires explicit operator re-evaluation; never automatically retried.
  - **`stale_pins`** (`stale_configuration_pins`): Configured repository, PR head SHA, or patch SHA256 changed after preparation.
    - *Action*: Re-inspect the PR and refresh the preparation review card.
  - **`authority_mismatch`** (`authority_missing_or_mismatched`): Missing explicit operator click or instruction proof.
    - *Action*: Re-confirm using the native operator UI.
  - **`canonical_ticket_changed`** (`canonical_ticket_or_decision_changed`): The underlying ticket or canonical decision was modified or invalidated before effect.
    - *Action*: Inspect ticket events and refresh the decision card.
  - **`idempotency_conflict`** (`idempotency_key_reused`): A request ID was re-submitted with mismatched actor, action, or source proof.
    - *Action*: Use a fresh request ID for new operations; preserve existing ID only for exact replays.
  - **`concurrency_blocked`** (`concurrency_grant_active` / `interrupted_grant_pending_reconciliation`): Another publication is actively queued/running, or an interrupted grant is awaiting explicit operator settlement.
    - *Action*: Await completion of running coordinator or execute explicit interruption reconciliation (`acknowledgeInterruption`).

### B. Enqueue Launch Failure (`worker_launch_failed`)
* **Guarantee**: Worker grant recorded in `workerGrants`, but the detached Node child process failed to spawn (e.g., path/exec error).
* **Cause**: `worker_launch_process_failed`.
* **Delivery Outcome**: Grant marked `failed`.
* **Action**: Check system logs and detached entry path. No automatic replay occurs.

### C. Execution Failure (`stage_failed`)
* **Guarantee**: Side-effects began or occurred. The failing stage (`merge`, `apply`, `build`, `restart`, `verify`) is recorded in `outcomes`.
* **Cause**: `stage_execution_failed`.
* **Delivery Outcome**: Classified as `outcome: 'uncertain'` or `failed`; publication status marked `failed`.
* **Action**: Explicit rollback remains available. Do not rerun live publish without explicit recovery.

### D. Execution Interrupted (`execution_interrupted`)
* **Guarantee**: Coordinator was killed, restarted, or compromised during execution.
* **Cause**: `execution_interrupted_unknown_outcome`.
* **Delivery Outcome**: Status `interrupted`.
* **Action**: Inspect process settlement via `acknowledgeInterruption`.

### E. Rollback Outcome (`rollback_outcome`)
* **Guarantee**: Rollback operation completed (`rolled_back` with `rollback_completed`) or failed (`failed` with `rollback_failed`).

---

## 4. Privacy & Sanitization Floor

Diagnostics enforce strict data hygiene through structural and bounded layers:
1. **Architectural Allowlisting (Primary Guarantee)**: Newly modified persisted diagnostic paths (`PublicationOutcome.detail`, `PublicationAudit.detail`, `PublicationAudit.cause`, `PublicationWorkerGrant.detail`, `DeliveryResult.blocker`) strictly use fixed allowlisted diagnostic tokens and operational IDs (`stage`, `category`, `cause`, `requestId`, `operationId`, `grantId`). Free-form adapter errors, arbitrary exception messages, provider responses, and user request text are never persisted to the canonical document or exposed across boundaries.
2. **Bounded Redaction (Defense-in-Depth)**: As secondary defense-in-depth, `sanitizeDiagnosticMessage` performs bounded redaction of known credential formats (Bearer tokens, `ghp_*`, `sk-*`), multiline quoted secrets (`api_key="..."`), email addresses, and structured JSON payloads (`[REDACTED_PAYLOAD]`). It is explicitly bounded and does not rely on denylists as the primary privacy guarantee.
3. **Immutable Identifiers Preserved**: Commit SHAs (40 hex characters), patch SHA256 digests (64 hex characters), request IDs, ticket IDs, and grant IDs are explicitly preserved for safe operational correlation.

---

## 5. Inspection Guide for Operators

### Inspect Audit Log in `publication-state.json`
```bash
jq '.publications[] | {id: .id, status: .status, audit: .audit}' publication-state.json
```

### Inspect Outbox Lease State in `orchestrator.sqlite`
```sql
SELECT id, delivery_id, status, uncertain, worker, polls FROM feature_delivery_outbox WHERE status = 'blocked';
```
If `uncertain = 0` and `status = 'done'`, the failure was confirmed prior to effects and requires no manual state surgery.
