# Changelog: `superagent-core` Innovations & Upstream Features

This changelog tracks all custom features, architectural enhancements, and upstream integrations maintained on the `superagent-core` branch of `dsh-superagent`.

---

## [0.2.0-core] — 2026-11-03

### Added
- **Unified OS Computer Use MCP Service (`dsh-computer-use-mcp`)**:
  - Full operating system GUI control (mouse, keyboard, display inspection) via Model Context Protocol (MCP).
  - Out-of-process Stdio daemon in `scripts/dsh-computer-use-mcp.cjs` with automatic Swift compilation on first launch.
  - Native macOS event synthesis helper `scripts/macos-input-helper.swift` using Quartz Event Services and AppKit.
  - Support for 13 MCP tools: `computer_screenshot`, `computer_mouse_click`, `computer_mouse_move`, `computer_mouse_drag`, `computer_mouse_scroll`, `computer_type_text`, `computer_key_press`, `computer_hotkey`, `computer_list_windows`, `computer_focus_window`, `computer_get_cursor`, `computer_check_permissions`, and Anthropic-compatible `computer`.
  - Fail-safe panic corner at `(0, 0)` to immediately halt automation upon operator cursor override.
  - Wired into `$DSH_HOME/profiles/superagent/cordis.patch.yml` and `web/cordis.patch.yml`.
  - Specification documented in `docs/010-os-computer-use.md`.
  - Operational skill registered in `skills/dsh-superagent-computer-use/SKILL.md`.

- **Upstream Synchronization Architecture & Automation**:
  - Specification `docs/011-upstream-synchronization.md` defining Git remote topology (`upstream` vs `origin`), branch isolation, and conflict resolution rules.
  - Automated sync script `scripts/sync-upstream.sh` supporting `--check` (non-destructive inspection) and `--rebase` (automated rebase with test verification).

- **Interactive Subscription OAuth Login CLI (`scripts/dsh-login.cjs`)**:
  - Browser-based OAuth login CLI for Anthropic Claude (Claude Pro/Max) and OpenAI (ChatGPT Plus/Pro).
  - Automatically saves grants into `$DSH_HOME/.credentials.yaml`.

- **Skills Ecosystem**:
  - `skills/dsh-superagent-adhd/SKILL.md`: Real-time micro-step progress streaming and cognitive pacing.
  - `skills/dsh-superagent-chrome/SKILL.md`: Live authenticated Chrome DevTools MCP browser automation.
  - `skills/dsh-superagent-composio/SKILL.md`: Multi-app integration across 500+ SaaS services via Composio.
  - `skills/dsh-superagent-computer-use/SKILL.md`: OS-level desktop automation workflow.

- **Visual Activity Indicator Specification**:
  - Specification `docs/009-visual-activity-indicator.md` for ambient background thinking and execution states in DSH client UI.

### Fixed
- **Darwin DSH Helper Daemon Recognition**:
  - Updated `scripts/dsh-superagent` supervisor to detect running Electron helper processes on macOS Darwin.
- **Ambient Git Config Test Isolation**:
  - Fixed `tests/runtime.spec.ts` to preserve and restore `process.env.GIT_CONFIG_GLOBAL` across test runs.
- **Strict Null Checks**:
  - Resolved TypeScript error in `tests/sources.spec.ts` for self-authored PR admission test.

---

## [0.1.0] — Initial Prototype
- Shipped baseline `dsh-superagent` prototype from `deepseek-ai/dsh-superagent-prototype`.
