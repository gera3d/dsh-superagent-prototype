# 009 Visual Activity Indicator: Real-time Thinking & Background State

This document specifies the design, architecture, and rollout plan for the **Visual Activity Indicator** feature in `dsh-superagent`.

---

## 1. Objective

Provide real-time transparency into the agent's background lifecycle during chat mode without cluttering the screen or pulling focus from the conversation. 

Users should immediately see at a glance whether the agent is:
- **Listening / Input Active**: Capturing voice or receiving input.
- **Thinking / Reasoning**: Generating internal reasoning tokens or planning steps.
- **Executing Tools / Proactive Work**: Running shell commands, fetching GitHub data, or reviewing PRs.
- **Idle / Awaiting User**: Conversation turn complete.

---

## 2. Design Principles

1. **Subtle & Non-Intrusive**: Small animated badge or wave indicator with a soft glow, never flashing or disorienting.
2. **Unified Design Language**: Matches the cyan-to-purple gradient (`#38bdf8` to `#a855f7`) established by the ElevenLabs voice mode integration.
3. **Low Overhead**: Pure CSS animations driven by Cordis session state transitions.
4. **Seamless Slot Integration**: Injected into DSH client slots (`conversation.session.header.utilities` and `conversation.input.activity`).

---

## 3. Architecture & Lifecycle States

```
        ┌────────────────────────────────────────────────────────┐
        │                  Agent Lifecycle                        │
        └──────────────────────────┬─────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
            [session.start]               [voice.listening]
                    │                             │
                    ▼                             ▼
           State: "thinking"             State: "listening"
          (Soft purple pulse)            (Cyan wave ripple)
                    │                             │
                    ├──────────────┬──────────────┘
                    ▼              ▼
           State: "executing"     State: "idle"
           (Amber orbit dot)      (Resting pill)
```

---

## 4. Implementation Checklist

- [x] **Phase 1: Repository & Upstream Setup**
  - [x] Fork `deepseek-ai/dsh-superagent-prototype` to `gera3d/dsh-superagent-prototype`.
  - [x] Configure dual remotes (`origin` -> `gera3d`, `upstream` -> `deepseek-ai`).
  - [x] Create and push `superagent-core` working branch.
  - [x] Verify existing test suite (1,195 passing tests) and build pipeline.

- [ ] **Phase 2: State Stream Bridge**
  - [ ] Connect Cordis session events (`session.thinking.*`, `session.status_*`, `session.tool_*`) to client state.
  - [ ] Expose reactive hook `useAgentActivityState()`.

- [ ] **Phase 3: Visual Component**
  - [ ] Build `<ActivityPill />` and `<ActivityOrb />` React primitives in `src/client/activity.tsx`.
  - [ ] Register into client slots `conversation.session.header.utilities` and `conversation.input.dock`.

- [ ] **Phase 4: Verification & Release**
  - [ ] Unit tests for activity component and state transitions.
  - [ ] Visual verification in DSH web client (`http://127.0.0.1:3082/`).
  - [ ] Commit to `superagent-core` and open PR to document feature branch.
