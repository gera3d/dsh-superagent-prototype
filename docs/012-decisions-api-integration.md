# 012 Decisions API Integration: Real-Time Recommendations & Human-in-the-Loop Decisions Tab

This document specifies the architecture, data models, UI components, and implementation plan for integrating **Decisions APIs** into `dsh-superagent`.

---

## 1. Objective & Motivation

In agentic workflows, conversations and autonomous worker sessions often conclude in a dead end: the model stops generating, and the human operator is left wondering what to do next or which branch to take.

This integration delivers two interconnected capabilities:

1. **End-of-Chat Decision Hook**:
   At the conclusion of every chat or autonomous Ticket session, a low-latency "System One" decision model (such as **TypeSafe AI's Jev** or **OpenAI's `gpt-6-luna` Decisions API**) evaluates the conversation transcript, git diffs, and test results. It outputs a structured set of actionable options, highlighting a recommended choice:
   > *"Hey Gera, here is the recommended next step: **Deploy to Staging & Run Smoke Tests** (92% confidence). Alternately: Open PR or Request Human Review."*

2. **Dedicated "Decisions" Left-Hand Tab**:
   A dedicated top-level panel tab in the DSH sidebar (`src/client/decisions.tsx`) that acts as an **Actionable Decision Inbox**. Whenever autonomous subagents encounter blockers, branching decisions, or require operator approval, those decisions are queued with ranked recommendations from the model. The operator can resolve them with a single click, keeping background work continuously moving forward.

---

## 2. Decision Engine Landscape & Provider Abstraction

Instead of forcing general generative LLMs to draft slow, unstructured prose tokens, the integration leverages specialized Decision APIs:

```
                                  ┌──────────────────────────────┐
                                  │   Application / Agent State  │
                                  └──────────────┬───────────────┘
                                                 │
                                                 ▼
             ┌───────────────────────────────────────────────────────────────────────┐
             │                     UNIFIED DECISION CLIENT LAYER                     │
             │                         (src/core/decision.ts)                        │
             ├──────────────────────────┬─────────────────────────┬──────────────────┤
             │                          │                         │                  │
             ▼                          ▼                         ▼                  ▼
    ┌──────────────────┐       ┌──────────────────┐      ┌─────────────────┐ ┌───────────────┐
    │  TypeSafe — Jev  │       │ OpenAI Decisions │      │   Laya (Local)  │ │DeepSeek Native│
    │  • 70–120ms      │       │  • gpt-6-luna    │      │   • Open-weight │ │ • Structured  │
    │  • $0.042 / 1M   │       │  • Multimodal    │      │   • Sovereign   │ │   JSON Output │
    │  • Parallel Eval │       │  • Up to 400 Qs  │      │   • Zero API cost││ • 800–1200ms  │
    └──────────────────┘       └──────────────────┘      └─────────────────┘ └───────────────┘
```

### Supported Providers:
1. **TypeSafe AI (Jev)**: Reference System One model using non-autoregressive candidate evaluation. Sub-100ms latency, $0.042/1M input tokens, $0 output tokens.
2. **OpenAI Decisions API (`POST /v1/decisions` via `gpt-6-luna`)**: Multimodal decision endpoint capable of evaluating up to 400 questions per request, including visual screenshots and structured JSON.
3. **DeepSeek Native Fallback**: Zero-dependency fallback using DeepSeek-V3 or DeepSeek-Flash with JSON Schema structured outputs (`response_format: { type: "json_object" }`).

---

## 3. Core Decision Primitives

The decision engine operates on three typed primitives:

### A. `Choice` (Selection & Ranking)
Evaluates state against a finite set of discrete options.
* **Returns**: Selected candidate `value`, confidence score ($0.0 \to 1.0$), explanation rationale, and the full normalized probability distribution across all choices.

### B. `Predicate` / `Noul` (Boolean Probability)
Evaluates a proposition or condition against state.
* **Returns**: A calibrated mathematical probability ($0.00 \to 1.00$) indicating the truth likelihood.

### C. `Score` (Rubric Evaluation)
Evaluates context against a multi-criteria numeric scale.
* **Returns**: Weighted aggregate score and per-criterion grades.

---

## 4. Architectural Components

```
dsh-superagent/
├── src/
│   ├── core/
│   │   ├── decision.ts           # Unified DecisionClient interface & provider drivers
│   │   └── types.ts              # DecisionRequest, DecisionResult, ChoiceOption types
│   ├── executor/
│   │   └── hook-decision.ts      # Post-ticket / post-chat execution hook
│   └── client/
│       ├── route.ts              # Route registry with 'decisions' tab added
│       ├── app.tsx                # Sidebar navigation item with badge counter
│       ├── decisions.tsx          # Dedicated Decisions Inbox view
│       └── decision-card.tsx      # Interactive recommendation widget at bottom of chat
```

### Component Details:

#### 1. End-of-Chat Decision Hook (`src/executor/hook-decision.ts`)
* Intercepts `session.end` or `ticket.complete`.
* Extracts the conversation summary, files changed, and test exit codes.
* Dispatches a structured `Choice` request to the active Decision Provider.
* Injects a `DecisionCard` into the session feed presenting the top recommended action and alternative options.

#### 2. Dedicated Decisions Tab (`src/client/decisions.tsx`)
* Registered under route `/decisions`.
* Maintains a live list of decision items partitioned into:
  - **Pending**: Unresolved decisions awaiting operator input, ranked by urgency.
  - **Resolved**: History of past choices and agent outcomes.
* Each card displays:
  - Context & Triggering Task (e.g. *"Worker 2: Architecture Fork in auth module"*).
  - Jev / Luna Recommendation with confidence badge (e.g., `94% Recommended`).
  - Action buttons to accept the recommendation or choose an alternative.

---

## 5. Data Schema & Persistence

Decisions are stored in SQLite (`$DSH_HOME/state/superagent/superagent.db`):

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'dismissed', 'overridden')),
  provider TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK(question_type IN ('choice', 'predicate', 'score')),
  prompt TEXT NOT NULL,
  recommended_value TEXT NOT NULL,
  confidence REAL NOT NULL,
  distribution_json TEXT NOT NULL,
  selected_value TEXT,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
CREATE INDEX IF NOT EXISTS idx_decisions_ticket ON decisions(ticket_id);
```

---

## 6. Implementation Roadmap

- [ ] **Phase 1: Decision Client Engine (`src/core/decision.ts`)**
  - Implement unified client interface.
  - Add TypeSafe Jev driver (`POST /v1/systemone` or SDK).
  - Add OpenAI Decisions driver (`POST /v1/decisions` with `gpt-6-luna`).
  - Add DeepSeek native structured output fallback.

- [ ] **Phase 2: Post-Chat Hook (`src/executor/hook-decision.ts`)**
  - Wire post-ticket completion listener.
  - Generate next-step candidates dynamically from workspace state.
  - Mount inline interactive action buttons.

- [ ] **Phase 3: Panel UI & Left-Hand Decisions Tab (`src/client/decisions.tsx`)**
  - Add `'decisions'` to `TABS` in `src/client/route.ts`.
  - Add navigation item with active pending count badge in `src/client/app.tsx`.
  - Build filterable list view (Pending vs Resolved).

- [ ] **Phase 4: End-to-End Verification**
  - Test decision generation on completed tickets in `superagent-sandbox`.
  - Verify instant turn-around (<150ms) using Jev / Luna.
