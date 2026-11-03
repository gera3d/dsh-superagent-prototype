---
name: dsh-superagent-chrome
description: Control and automate Google Chrome for browsing, DOM interaction, screenshots, and web inspection via Chrome DevTools MCP.
---

# Chrome DevTools Browser Automation Guide for Superagent & DSH

This skill instructs agents on controlling local and remote Google Chrome instances for browsing web pages, interacting with forms, scraping dynamic content, and taking screenshots.

## Architecture & Wiring

- **Transport:** Stdio child process running `chrome-devtools-mcp` via Node.js.
- **Config:** Configured in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` via `@deepseek-ai/dsh-mcp-client` with `serverName: chrome`.
- **User Data Dir:** Uses dedicated profile directory `~/.config/mcp-chrome-profile` to persist session cookies and state across invocations.
- **Public Tool Prefix:** In DSH models, tools are available under `mcp__chrome__<TOOL_NAME>` (e.g. `mcp__chrome__navigate_page`).

## Common Browser Operations

### 1. Navigation & Page Management
- **Open URL:** `navigate_page` with `{"url": "https://example.com"}`.
- **Wait for DOM State:** `wait_for` with `{"selector": "#content"}` or `{"duration": 2000}`.
- **List Pages:** `list_pages` to inspect open browser tabs.
- **New Tab:** `new_page` with `{"url": "..."}`.
- **Close Tab:** `close_page` with `{"targetId": "..."}`.

### 2. Interaction & Input
- **Click Element:** `click` with `{"selector": "button.submit"}` or coordinates `{"x": 100, "y": 200}`.
- **Type Text:** `type_text` with `{"selector": "input[name='q']", "text": "deepseek harness"}`.
- **Fill Form:** `fill_form` with field mappings.
- **Press Keys:** `press_key` with `{"key": "Enter"}`.

### 3. Inspection & Screenshots
- **Take Screenshot:** `take_screenshot` captures the rendered viewport or full page.
- **DOM Snapshot:** `take_snapshot` captures the structured accessibility and DOM tree.
- **Evaluate JavaScript:** `evaluate_script` with `{"expression": "document.title"}` returns runtime values.

### 4. Diagnostics
- **Console Messages:** `list_console_messages` retrieves browser console logs and errors.
- **Network Requests:** `list_network_requests` inspects network activity and HTTP response codes.
