# 013: OpenAI Dots Feature Parity & Master Conversational Orchestrator

This document specifies the architecture and implementation of **OpenAI Dots parity** within DeepSeek Harness and Superagent.

---

## 1. Context & The "Dots" Paradigm

In traditional agent workflows, users context-switch across multiple terminal sessions, individual issue threads, and PR reviews. 

OpenAI's **Dots** paradigm introduces **always-on, asynchronous AI orchestration** accessed through **a single conversational entry point**:
- **One Master Dot**: The user speaks or types to a single persistent coordinator agent.
- **Goal Deconstruction**: The Dot decomposes high-level, multi-faceted prompts into atomic, modular, independent tasks.
- **Autonomous Task Swarm**: Sub-tasks are dispatched directly to the project repository (as tracked GitHub Issues) and picked up by background worker subagents operating in isolated worktrees.
- **Asynchronous Telemetry & Approvals**: The master Dot aggregates progress across all workers, reports back conversationally, and requests human confirmation only when critical decisions or PR reviews arise.

---

## 2. System Architecture

```
[ User Channels: Hands-Free Voice / DSH Web Composer / CLI ]
                           │
                           ▼
         [ OpenAI Dots Master Orchestrator (dsh-dot) ]
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
  [ Deconstruction Engine ]    [ Conversational State ]
  (DeepSeek Chat / Astra)      (Voice Duplex / Memory)
             │
             ▼
  [ GitHub Repository Dispatch: Issues with [superagent] ]
             │
             ▼
  [ dsh-superagent Orchestrator Loop (Every 60s) ]
             │
   ┌─────────┼─────────┬─────────┐
   ▼         ▼         ▼         ▼
Worker 1  Worker 2  Worker 3  Worker 4  (Isolated Git Worktrees)
   │         │         │         │
   ▼         ▼         ▼         ▼
  PR #1     PR #2     PR #3     PR #4
             │
             ▼
[ Central Decisions Inbox & Executive Progress HUD ]
```

---

## 3. Core Capabilities

### 3.1 Single Conversational Entry Point (`dsh-dot` & `voice-mode`)
The user interacts through:
1. **Hands-free Voice**: Via `start-voice-mode.sh` (SenseVoice ONNX STT + Neural TTS + instant interruption barge-in).
2. **Terminal Interactive**: `dsh-dot --interactive` or `dsh-dot -i`.
3. **One-Shot CLI**: `dsh-dot "<feature description>"`.

### 3.2 Autonomous Goal Deconstructor
The orchestrator leverages structured JSON schema prompting to break any vision into 2–5 atomic units:
- Tagged with `[superagent]` to trigger DSH intake.
- Fully formulated with Problem, Acceptance Criteria (markdown check-boxes), and Technical Approach.

### 3.3 GitHub Repository Synchronization
- Calls GitHub API via `gh issue create` on the target repository (`gera3d/superagent-sandbox`).
- `dsh-superagent` polls GitHub issues, converts them into Tickets in `orchestrator.sqlite`, and spawns workers.

### 3.4 Live Telemetry & Decisions Gate
- `dsh-dot --status` queries both SQLite tickets and live GitHub PRs.
- Pending ambiguities route to the **Decisions API** and render in the DSH panel's **Decisions** tab.

---

## 4. Usage Commands

```bash
# Check orchestration status & worker swarm
dsh-dot --status

# Dry-run feature deconstruction
dsh-dot "Add OAuth2 user authentication and session cookies" --dry-run

# Deconstruct and dispatch tasks directly to GitHub
dsh-dot "Add OAuth2 user authentication and session cookies"

# Launch interactive voice mode
dsh-dot --voice
```
