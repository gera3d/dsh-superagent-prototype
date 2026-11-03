---
name: dsh-superagent-computer-use
description: Control and automate the local operating system GUI (mouse, keyboard, display inspection, window focus) via the Unified Computer Use MCP service.
---

# OS Computer Use Guide for Superagent & DSH

This skill instructs agents on controlling the local operating system desktop environment (macOS / Linux / Windows) to automate native applications, simulate mouse interactions, dispatch keystrokes, and visually verify GUI state.

## Architecture & Wiring

- **Transport:** Out-of-process Stdio or Local-HTTP MCP daemon (`dsh-computer-use-mcp`).
- **Config:** Configured in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` via `@deepseek-ai/dsh-mcp-client` with `serverName: computer`.
- **Permissions:** Requires macOS Accessibility (`AXIsProcessTrusted`) and Screen Recording permissions.
- **Public Tool Prefix:** In DSH models, tools are available under `mcp__computer__<TOOL_NAME>` (e.g. `mcp__computer__computer_screenshot`).

## Core Execution Loop

Always follow the standard 4-phase GUI automation loop:

```
[1. Inspect & Focus] ──> [2. Capture & Locate] ──> [3. Dispatch Action] ──> [4. Verify Result]
   Focus target app         Take screenshot          Click / Type / Key        Confirm UI change
```

### 1. Window Discovery & Focus
- Before clicking or typing, ensure the target application is in the foreground:
  - List windows: `computer_list_windows`
  - Focus application: `computer_focus_window` with `{"appName": "Visual Studio Code"}` or `{"windowId": 1234}`.
- Allow 200–500ms for OS window animation and focus settling.

### 2. Capture & Coordinate Resolution
- Capture display state: `computer_screenshot` with `{"scaleDown": 1.0}`.
- **Coordinate System Rule**: All coordinates are in **logical display points**, NOT physical Retina pixels.
  - If a Retina screen is 3024x1964 physical pixels with a 2x scale factor, logical resolution is 1512x982.
  - Never guess coordinates without inspecting the latest screenshot.

### 3. Dispatching Interactions
- **Mouse Clicks**:
  - `computer_mouse_click` with `{"x": 420, "y": 310, "button": "left"}`
  - Double click for opening files/items: `{"x": 420, "y": 310, "clickCount": 2}`
- **Mouse Drag**:
  - `computer_mouse_drag` with `{"startX": 100, "startY": 200, "endX": 300, "endY": 200}`
- **Keyboard & Text**:
  - Type text: `computer_type_text` with `{"text": "git status\n"}`
  - Shortcuts: `computer_key_press` with `{"key": "c", "modifiers": ["cmd"]}` (macOS) or `{"key": "Enter"}`.

### 4. Visual Verification
- Never assume an action succeeded without taking a follow-up screenshot.
- Compare state: confirm the dialog closed, menu expanded, or text appeared before continuing.

## Safety & Boundaries

1. **Panic Corner**: Moving the mouse to `(0, 0)` immediately halts all automation scripts.
2. **System Prompts & Passwords**: Never attempt to bypass or click through macOS Keychain prompts, biometric Touch ID dialogs, or root elevation requests. Always defer to the human operator.
3. **Pacing**: Avoid blasting multiple mouse clicks without intermediate screenshots or small pauses. Native GUIs require render latency.
