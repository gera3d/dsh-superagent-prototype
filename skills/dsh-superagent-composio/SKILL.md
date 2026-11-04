---
name: dsh-superagent-composio
description: Discover and execute actions across 500+ apps (GitHub, Slack, Google Workspace, Linear, etc.) via Composio MCP tools and skills.
---

# Composio Integration Guide for Superagent & DSH

This skill equips agents with instructions on discovering, inspecting, and executing tools across connected third-party applications using the hosted Composio MCP service.

## Architecture & Wiring

- **Transport:** Streamable HTTP over `https://connect.composio.dev/mcp`
- **Config:** Configured in `$DSH_HOME/profiles/<profile>/cordis.patch.yml` via `@deepseek-ai/dsh-mcp-client` with `serverName: composio`.
- **Credentials:** Authenticated using `x-consumer-api-key` backed by `$DSH_HOME/.credentials.yaml` (`COMPOSIO_API_KEY`) and `$DSH_HOME/.env`.
- **Public Tool Prefix:** In DSH models, tools are available under `mcp__composio__<TOOL_NAME>` (e.g. `mcp__composio__COMPOSIO_SEARCH_TOOLS`).

## Core Tool Workflow

Always follow the standard 3-step execution loop:

1. **Search Tools (`COMPOSIO_SEARCH_TOOLS`):**
   - Query an intent or use case (e.g., `{"queries": [{"use_case": "search messages in slack"}]}`).
   - Returns:
     - `recommended_plan_steps` and `known_pitfalls`.
     - `toolkit_connection_statuses`: Confirms whether the target app connection is `ACTIVE`.
     - `primary_tool_slugs` and `related_tool_slugs`.
     - `session_id`: Maintain this session ID for subsequent calls in the workflow.

2. **Inspect Schemas (`COMPOSIO_GET_TOOL_SCHEMAS`):**
   - If full input parameters are not inlined in the search response, call `COMPOSIO_GET_TOOL_SCHEMAS` with `tool_slugs: ["<SLUG>"]`.
   - Never fabricate or guess argument shapes.

3. **Execute Actions (`COMPOSIO_MULTI_EXECUTE_TOOL`):**
   - Execute up to 50 independent actions in parallel.
   - Arguments: `tools: [{"tool_slug": "<SLUG>", "arguments": { ... }}]`.
   - Set `sync_response_to_workbench: false` for direct structured JSON results.

## Managing App Connections (`COMPOSIO_MANAGE_CONNECTIONS`)

- Call with `toolkits: [{"name": "<toolkit>", "action": "list"}]` to verify authenticated accounts.
- If an account is missing, call with `"action": "add"` to generate an OAuth authentication URL for the user.

## Reusable Composio Skills

- **Search Skills:** `COMPOSIO_SEARCH_SKILLS` searches pre-built organization workflows.
- **Load Skill:** `COMPOSIO_USE_SKILL` loads markdown instructions for a specific workflow slug.
- **Manage Skill:** `COMPOSIO_MANAGE_SKILL` allows programmatic creation or updates of custom skills.
