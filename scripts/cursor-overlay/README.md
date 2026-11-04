# Computer-use activity overlay

## Behavior

- Hidden on startup and whenever no computer action is running.
- Cyan pulsing halo around the **real OS cursor**; no second drawn arrow, no cursor hiding, no fake movement.
- Click-through, non-activating badge: action + actual calling thread title (ID fallback, explicit `Thread unavailable` if absent).
- Fade out over 350ms after success or failure. A 15-second watchdog hides a stale activity indication; EOF terminates the overlay.
- Uses AppKit global logical coordinates and one transparent panel per display. Badge clamps to display edges.
- Display-only code never clicks, types, or takes focus.

## Ownership contract

DSH's MCP bridge must forward host-sourced per-call metadata:

```json
{"_meta":{"dev.dsh/computer-caller":{"threadId":"<execution.agent.id>","threadTitle":"<sessionTitle>"}}}
```

Do not use model tool arguments, environment variables, the selected browser tab, or a process-global name as the owner. Calls are serialized within this computer MCP process, and each action uses its own metadata. This is not a cross-process desktop lease: independently running computer servers can still conflict.

The tracked installer patches the currently installed bridge with a guarded exact match and keeps a backup. Run:

```bash
node scripts/cursor-overlay/install-host-metadata.cjs /absolute/path/to/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js
```

Review/reapply after DSH upgrades. Unknown upstream code fails rather than applying a guessed patch. Long-term, upstream the small metadata seam instead of maintaining an installed-package patch.

## Build and test

```bash
swiftc -O scripts/cursor-overlay/main.swift -o scripts/cursor-overlay/overlay
node --test scripts/cursor-overlay/overlay.test.cjs
node --check scripts/dsh-computer-use-mcp.cjs
```

The driver also compiles when the binary is absent or older than the Swift source. The binary is ignored by Git.

## Deployment / verification

Restart the existing DSH runtime to load both the server and host metadata bridge; merely refreshing a page is not enough. Do not restart it while other sessions have active work without operator consent. The old sibling prototype may have orphaned overlays: quit those separately before comparing visuals.

Live acceptance: invoke a move/click/type from a known thread, check the displayed title, verify a single real arrow with centered halo across screens/Spaces, then confirm fade-out on success, error, idle, and client shutdown. Source compilation/unit tests alone do not prove live runtime adoption.

Limits: screen topology is captured on overlay startup; relaunch after connecting a display. The watchdog can hide the indicator for a single action lasting over 15 seconds. This UI is not a security gate, emergency-stop implementation, or OS-input ownership enforcement.
