# 016 — Stage 3: Autopilot Characters (Senior Developer First), with Permission to Disagree

**Status:** Draft / First Slice implemented in Stage 3 (`agent/autopilot-characters-9599005427f6`).  
**Context:** Part of the SuperAgent Path-to-Ready plan (Stage 3). Builds on the Decisions ranker and Response Agent profiles established in `docs/015-decision-engine-consolidation.md`.

---

## 1. Vision & Motivation

Prior iterations treated "Autopilot" as a binary switch or button ("Make Progress", "Auto-run"). A binary button has no architectural context, no domain standards, and no voice: when presented with multiple poor choices, it blindly picks the "least bad" option and advances work down an unverified or risky trajectory.

In Stage 3, **the autopilot becomes a configurable character instead of a button**.

A character is an autonomous second agent with a distinct domain specialty. It reads what the first agent (the worker) did and proposed, assesses the proposals against strict domain standards, pushes back when something looks off, and acts or answers on the person's behalf.

```
Worker turn completes (offers candidates or next steps)
       │
       ▼
Character Evaluator (Senior Developer)
       │
       ├─► 1. Check Locked Escalation Boundaries
       │      (money, deletions, secrets, sending as person, undecided)
       │      ──► MATCH?  ──► ESCALATE to human gatekeeper (canAutoPush: false)
       │
       ├─► 2. Permission to Disagree & Standards Assessment
       │      (Does proposal skip tests, ignore failures, or use unverified shortcuts?)
       │      ──► WEAK?   ──► DISAGREE: Issue critique, inject counter-proposal,
       │                                recommend inclined tools & send worker back
       │
       └─► 3. Candidate Alignment & Mode Execution
              ──► SOUND?  ──► APPROVE best candidate
                              mode: suggest_only  ──► Stage for human confirmation
                              mode: auto_push     ──► Auto-send & progress worker
```

---

## 2. Character Specification & Anatomy

A Character is configured in `settings.characters` and carries:
1. **Name and Specialty**: A human-readable title and defined domain of mastery with explicit standards.
2. **Brief**: A concise system brief instructing how it reasons, critiques, and evaluates.
3. **Standards**: Invariant quality bars it enforces (e.g., test coverage, verification before deploy).
4. **Permission to Disagree**: Permission to reject weak or unverified proposals, generate counter-proposals, and send the worker back with corrective direction rather than picking the least bad choice.
5. **Inclined Tools**: Specific tools and actions it expects to see utilized (e.g. `run tests first`, `typecheck`, `verify git diff`).
6. **Execution Mode**:
   - `suggest_only`: Evaluates and drafts the decision or counter-direction, leaving final dispatch to the person.
   - `auto_push`: Automatically dispatches approved choices or corrective directions, accelerating autonomous completion.

### First Character: Senior Developer

```typescript
export const DEFAULT_SENIOR_DEVELOPER_CHARACTER: CharacterConfig = {
  id: 'senior_developer',
  name: 'Senior Developer',
  specialty: 'Software Architecture, Code Quality & Test Verification',
  brief: 'Thinks critically about architectural soundness, test coverage, and regression risks. Rejects weak or hand-waving proposals, insists on verifying diffs with automated tests, and sends the worker back with precise corrective direction.',
  standards: [
    'Never deploy or merge without tests',
    'Verify diffs against project rules',
    'Reject hand-waving or incomplete fixes',
    'Check edge cases and error handling',
  ],
  permissionToDisagree: true,
  inclinedTools: [
    'run tests first',
    'typecheck',
    'verify git diff',
    'read test output',
  ],
  mode: 'suggest_only',
  apiKeyEnv: '',
  enabled: true,
}
```

---

## 3. Hard Rules & Invariants

### 3.1 Locked Escalation List (Hard Gatekeeper)

A character—regardless of specialty, confidence, or `auto_push` mode—**can NEVER override the locked escalation list**. When any item touches these domains, execution stops and the decision is escalated to a human operator (`requiresHuman: true`, `canAutoPush: false`):

| Category | Boundary Scope | Example Triggers |
|---|---|---|
| **`money`** | Financial transactions, cloud billing, subscription tier upgrades, token purchases. | Stripe charges, buying API credits, subscription upgrades. |
| **`deletions`** | Destructive modifications, permanent data loss, branch deletions, force pushes. | `rm -rf`, `DROP TABLE`, `truncate`, `git push --force`. |
| **`secrets`** | Credentials, auth tokens, private keys, certificate manipulation. | Private keys, JWT secrets, passwords, `.env` file credentials. |
| **`sending_as_person`** | External outbound communications or public postings representing the person. | Public GitHub comments, client emails, tweeting, customer messaging. |
| **`undecided`** | Genuinely undecided choices, conflicting specifications, ties with low ranker confidence (< 0.40) or unranked deadlocks. | Explicit ambiguity, contradictory directives, 50/50 probability ties. |

### 3.2 Secret Storage Rule

**Keys and secrets are never stored in settings.**  
Settings only store the identifier of an environment variable (`apiKeyEnv`, e.g., `OPENAI_API_KEY`). Setting schemas strictly validate this: raw API keys (e.g., `sk-...`), bearer tokens, or assignment expressions (`KEY=val`) are rejected at schema validation time.

---

## 4. Permission to Disagree in Action

When a worker completes a turn and presents weak proposals (for example: *"Option A: Deploy now without running tests"* vs *"Option B: Ignore test failure and merge"*), standard rankers are forced into selecting one of the bad options.

With **Permission to Disagree** enabled:
1. The character analyzes the options against its standards (e.g., *"Never deploy or merge without tests"*).
2. It detects that the options represent shortcuts or unverified paths.
3. Instead of picking either option, it returns:
   - `action: 'disagree'`
   - `critique`: Direct critique explaining why the proposals are unacceptable and which standard was violated.
   - `counterProposal`: A newly synthesized corrective choice (e.g., `Run tests and verify typecheck first`).
   - `direction`: Precise instructions sending the worker back to execute tests.
   - `suggestedTools`: Inclined tools (`['run tests first', 'typecheck', 'verify git diff']`).

---

## 5. Open Question for the Person

> [!IMPORTANT]
> **Open Question for the Person (Architectural Direction):**  
> Should SuperAgent use **one character per request** (dynamic selection), or **one default always on** (global singleton)?

### Trade-offs:

1. **Option A: One Character per Request (Dynamic / Context-Specific)**
   - *How it works:* Individual tasks, repositories, or source tickets select or route to a specific Character (e.g., `Senior Developer` for backend/infrastructure, `UX Reviewer` for frontend UI, `Security Auditor` for authentication).
   - *Pros:* Deep domain specialization; high contextual precision; allows different teams or repos to customize character expectations.
   - *Cons:* Higher configuration overhead; requires either operator selection per request or an automatic router to choose the character.

2. **Option B: One Default Always On (Global Default)**
   - *How it works:* A single active Character (e.g., `Senior Developer`) operates globally across all incoming decisions and workers.
   - *Pros:* Minimal cognitive load; zero per-ticket configuration; uniform quality baseline across the entire system.
   - *Cons:* Less tailored to non-code workflows (e.g., research tickets or copy editing).

3. **Hybrid Path (Recommended Reference):**
   - The system maintains a global default character (`defaultCharacterId: 'senior_developer'`), but allows per-request overrides via the decision API (`characterId?: string`). This preserves simplicity while supporting future specialization.

---

## 6. Implementation & Verification Summary

The first slice delivers:
- **`src/core/character.ts`**: Types, locked escalation categories, detection regexes, weak proposal evaluation, and Senior Developer definition.
- **`src/app/character-evaluator.ts`**: `evaluateWithCharacter` function enforcing the invariant pipeline (escalation check → disagreement assessment → alignment).
- **`src/policy.ts`**: `CharacterConfigSchema`, `CharactersConfigSchema`, secret safety guards, and integration into `SettingsSchema`.
- **`src/app/http.ts` & `src/app/api.ts`**: Registered `POST decisions/character-evaluate` management route.
- **`tests/character.spec.ts`**: 16 unit tests covering:
  - Configuration defaults for Senior Developer.
  - Disagreement on weak options (generating counter-proposals and corrective direction).
  - Agreement on strong verification options.
  - Locked escalation triggers across all 5 categories (`money`, `deletions`, `secrets`, `sending_as_person`, `undecided`).
  - Invariant verification: locked escalations cannot be bypassed by `auto_push` mode.
  - Rejection of raw API keys in settings.
