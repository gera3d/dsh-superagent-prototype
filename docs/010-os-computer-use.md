# 010 OS Computer Use: Native Mouse, Keyboard & Display Automation

This document specifies the architecture, execution model, safety boundaries, and implementation plan for **OS-level computer use** (GUI automation, mouse, keyboard, and screen inspection) in `dsh-superagent`.

---

## 1. Objective & Context

While browser automation (`chrome-devtools-mcp`) handles web workflows via the Chrome DevTools Protocol (DOM interaction, element queries, network/console inspection), it is strictly confined to browser viewports. 

Modern agent capabilities (such as OpenAI's desktop operator and Anthropic's Computer Use) allow models to operate at the **operating system level**:
- Controlling the mouse (movement, left/right/middle click, double click, dragging, scrolling).
- Dispatching keyboard events (text typing, key chords, system shortcuts like `Cmd+Tab`, `Cmd+Space`, `Enter`).
- Capturing screenshots of the entire display, active window, or designated bounding boxes.
- Inspecting and interacting with native desktop applications (VS Code, terminal emulators, macOS System Settings, Finder, Slack desktop, Figma, etc.).

This document outlines the architecture options and establishes the rollout strategy for integrating OS computer use into the `superagent-core` branch.

---

## 2. Design Principles & Hard Constraints

1. **Model & Provider Agility**:
   Avoid tight coupling to a single proprietary provider schema. The system must support Anthropic Computer Use (`computer_20241022`), OpenAI CUA / Operator formats, and open vision-language models (e.g. DeepSeek-VL, Qwen2.5-VL) through a unified tool abstraction.
2. **Retina & Multi-Display Coordinate Normalization**:
   High-DPI displays (such as macOS Retina with 2x scaling) introduce discrepancies between physical pixel bitmaps and logical points. All mouse coordinates dispatched to the OS must be normalized to **logical display points**, with transparent scaling between screenshot bitmaps and event coordinates.
3. **Fail-Safe & Break-Glass Interrupters**:
   Autonomous mouse and keyboard control presents immediate risks to operator workflows. Hard-stop kill-switches must exist at the OS level:
   - **Panic Corner**: Moving the cursor to screen corner `(0, 0)` immediately halts automation.
   - **Global Break-Glass Hotkey**: A physical key combo (e.g., `Cmd+Ctrl+Shift+Escape`) revokes the agent's input lease instantly.
   - **Active Control Overlay**: A subtle visual border or status pill in DSH indicates when OS input dispatch is active.
4. **Sandboxing & Scope Enforcement**:
   OS computer use must respect DSH security boundaries. Critical OS dialogs (e.g., macOS Keychain password prompts, biometric Touch ID prompts, `sudo` elevation) must trigger human confirmation rather than autonomous clicks.

---

## 3. Architecture Options

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DSH Session / Superagent                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
  [Option A: Native Plugin]  [Option B: Vendor Wrapper]  [Option C: Unified MCP]
  Direct Cordis Plugin        Model-Specific API Proxy    Protocol-Agnostic Daemon
  - In-process native addons  - Locked to Anthropic/OAI   - Out-of-process Stdio/HTTP
  - C++/Obj-C/Swift bridge    - Container/Docker focused  - Standard MCP tools
  - High risk of crash        - High vendor lock-in       - Resilient, multi-model
```

### Option A: Native Cordis Plugin (`@deepseek-ai/dsh-tool-computer-use`)
- **Mechanism**: An in-process Cordis plugin using Node.js native addons (`robotjs`, `nut.js`, or a custom Swift C-API bridge) to invoke macOS Quartz Event Services (`CGEventCreateMouseEvent`, `CGEventPost`) and CoreGraphics display capture (`CGDisplayCreateImage`).
- **Pros**: Zero network overhead; tightly integrated into DSH plugin lifecycle.
- **Cons**: Native compilation complexity across platform architectures (Apple Silicon arm64 vs x86_64); a segmentation fault crashes the entire DSH desktop application; difficult to mock in CI.

### Option B: Vendor-Specific Model Protocol Wrapper
- **Mechanism**: Direct passthrough of Anthropic's predefined Computer Use tool specification (`type: "computer_20241022"`) or OpenAI's Operator protocol.
- **Pros**: Matches vendor pre-training prompts and resolution constraints (1024x768 / 1280x800) out of the box.
- **Cons**: Hard vendor lock-in; fails to support non-Anthropic models (e.g., DeepSeek models or local models running through Ollama/vLLM); typically assumes a sandboxed Linux/X11 container rather than macOS host automation.

### Option C: Unified Protocol-Agnostic MCP Service (`dsh-computer-use-mcp`) — **RECOMMENDED**
- **Mechanism**: An isolated, out-of-process MCP server executing as a stdio child process or local HTTP daemon, configured through DSH's `@deepseek-ai/dsh-mcp-client`.
- **Pros**:
  - **Process Isolation**: Any OS-level failure, permission drop, or crash does not bring down the DSH host or orchestrator.
  - **Model Agnostic**: Exposes standard MCP tools accessible to any model provider (DeepSeek, Claude, OpenAI, Gemini).
  - **Adapter Friendly**: Includes a lightweight translation layer to map vendor-specific computer-use tool calls (e.g. Anthropic's tool format) into standard MCP tool calls.
  - **Seamless Configuration**: Follows the exact configuration pattern already verified for `dsh-superagent-chrome` and `dsh-superagent-composio` in `cordis.patch.yml`.

---

## 4. Detailed Specification: Option C (Unified MCP Service)

### 4.1 Toolset Definition

The MCP server exposes the following tools under namespace `computer`:

| Tool | Parameters | Description |
|---|---|---|
| `computer_screenshot` | `displayId?: number`, `windowId?: number`, `region?: [x, y, w, h]`, `scaleDown?: number` | Captures display or window screenshot as base64 PNG/JPEG with coordinate metadata. |
| `computer_mouse_click` | `x: number`, `y: number`, `button?: 'left' \| 'right' \| 'middle'`, `clickCount?: number` | Moves cursor to logical point `(x, y)` and executes single, double, or triple click. |
| `computer_mouse_move` | `x: number`, `y: number` | Moves the cursor smoothly to logical coordinates `(x, y)`. |
| `computer_mouse_drag` | `startX: number`, `startY: number`, `endX: number`, `endY: number`, `button?: string` | Press-and-drag operation between two logical coordinates. |
| `computer_mouse_scroll` | `x: number`, `y: number`, `deltaX: number`, `deltaY: number` | Dispatches scroll wheel events at target point. |
| `computer_type_text` | `text: string`, `cpm?: number` | Types a string into the currently focused input element with realistic character timing. |
| `computer_key_press` | `key: string`, `modifiers?: ('cmd' \| 'ctrl' \| 'alt' \| 'shift')[]` | Presses a single key or key chord (e.g., `Cmd+C`, `Enter`, `Escape`). |
| `computer_hotkey` | `keys: string[]` | Executes a sequential hotkey combination. |
| `computer_list_windows` | *none* | Lists active desktop applications, window titles, coordinates, and window IDs. |
| `computer_focus_window` | `windowId: number` or `appName: string` | Brings target application window to foreground. |
| `computer_get_cursor` | *none* | Returns current `(x, y)` cursor position and active display dimensions. |

### 4.2 Display & Coordinate Normalization

```
Physical Bitmap (Retina 2x: 3024 x 1964)
┌────────────────────────────────────────────────────────┐
│                                                        │
│   Logical Canvas (1512 x 982 Points)                   │
│   ┌───────────────────────────┐                        │
│   │ Coordinate: (x: 100, y: 150)                       │
│   │ Event Dispatch: Quartz AX │                        │
│   └───────────────────────────┘                        │
│                                                        │
└────────────────────────────────────────────────────────┘
```

1. **Screenshot Scaling**: Screenshots captured at high physical resolutions are scaled down to standard model analysis resolution (maximum width 1536px, aspect-ratio preserved).
2. **Metadata Header**: Every screenshot response includes:
   ```json
   {
     "logicalWidth": 1512,
     "logicalHeight": 982,
     "physicalWidth": 3024,
     "physicalHeight": 1964,
     "scaleFactor": 2.0
   }
   ```
3. **Coordinate Conversion**: The MCP tool automatically translates scaled image model prediction coordinates `(x_model, y_model)` into logical display points `(x_logical, y_logical)` before sending to `CGEventPost`.

### 4.3 macOS Permission & Security Scaffolding

OS computer use requires two explicit macOS privacy entitlements:
1. **Accessibility (`AXIsProcessTrusted`)**: Required to synthesize keyboard and mouse events.
2. **Screen Recording (`CGRequestScreenCaptureAccess`)**: Required to capture desktop frames.

The server provides a self-diagnostic command:
```bash
dsh-computer-use doctor
```
Checks permissions, outputs setup instructions with direct links to `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`, and prevents execution until permissions are granted.

### 4.4 Configuration in `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-mcp-computer-use
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: computer
        transport: stdio
        command: npx
        args:
          - '-y'
          - '@deepseek-ai/dsh-computer-use-mcp'
        autoApprove:
          - computer_screenshot
          - computer_list_windows
          - computer_get_cursor
        # Mouse and key actions require worker session authorization
        timeoutMs: 15000
```

---

## 5. Rollout Plan & Implementation Checklist

- [x] **Phase 1: Architecture & Requirements Specification**
  - [x] Analyze voice conversation requirements with operator (Gera).
  - [x] Compare Native vs. Vendor Wrapper vs. Unified MCP approaches.
  - [x] Author specification `docs/010-os-computer-use.md`.
  - [x] Create agent guidance skill `skills/dsh-superagent-computer-use/SKILL.md`.

- [ ] **Phase 2: MCP Server Scaffolding (`dsh-computer-use-mcp`)**
  - [ ] Implement macOS Quartz event dispatcher (`@nut-tree/nut-js` or Swift CLI helper).
  - [ ] Implement screengrab capture with Retina 2x logical normalization.
  - [ ] Implement panic corner `(0, 0)` and break-glass keyboard listener.
  - [ ] Add `doctor` diagnostic check for Accessibility and Screen Recording permissions.

- [ ] **Phase 3: DSH Bundle & Preset Integration**
  - [ ] Add `dsh-mcp-computer-use` to `cordis.patch.yml` under `superagent` profile.
  - [ ] Configure tool admission rules in `WORKER_PRESET` (`src/app/sessions.ts`).
  - [ ] Add model adapter layer for Anthropic Computer Use and OpenAI Operator schemas.

- [ ] **Phase 4: End-to-End Verification**
  - [ ] Test cross-application window focus (e.g. DSH -> VS Code -> Terminal).
  - [ ] Verify click and typing accuracy in high-DPI multi-monitor setup.
  - [ ] Verify panic corner immediate abort behavior.
  - [ ] Submit pull request to `superagent-core`.
