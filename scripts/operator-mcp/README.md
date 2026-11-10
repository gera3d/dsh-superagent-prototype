# dsh-remote-mcp

A zero-dependency MCP server (stdio) that lets Claude read **and control** the local `dsh-superagent`
orchestrator: status, tickets, the decision inbox, settings, prompts, executor pause, and more.

It runs on the Mac next to the service and talks only to `127.0.0.1`. It opens **no** network port of its own.
To use it from elsewhere, register it with Claude Desktop; the desktop app proxies it to your Claude sessions
(they show up as `mcp__remote-devices__…` tools). No tunnel, no exposed port.

## Install

1. Confirm Node 18+ on the Mac: `node --version`.
2. Add the block from `claude-desktop-config.example.json` to Claude Desktop's config
   (Settings → Developer → Edit Config), fixing the two paths if your folder differs. Restart Claude Desktop.
3. Ask Claude: "run harness_status".

Check it without Claude: `node test/smoke.cjs` (88 checks against a mock service, touches nothing real).

## Tools

Reads: `harness_status` (start here), `list_tickets`, `get_ticket`, `decision_inbox`, `get_decision`,
`get_settings`, `get_prompts`, `list_threads`, `search`, `list_findings`, `get_finding`.

Writes: `observe_finding`, `resolve_decision`, `dismiss_decision`, `restart_decision`, `pause_executor`, `retry_ticket`,
`stop_ticket`, `requeue_trigger`, `sync_policy`, `save_settings`, `save_prompts`, `check_setup`, `api_request`.

`api_request` reaches the remaining routes (label edits, decision stage/submission/discard-staging, thread
unsubscribe, prompt preview, evaluate). It is still checked against the same route table.

Notes:
- `resolve_decision` records the choice in the shared queue. It does not itself send a message into a conversation.
  The "native Send linkage" depends on a host hook the stock host doesn't have.
- `save_settings` / `save_prompts` need the **current revision**. Call `get_settings` / `get_prompts` first.
  A stale revision is refused (409) rather than overwriting.
- Saving some settings can restart the service. Give it a minute.

## Safety

| Control | Behavior |
|---|---|
| Loopback only | `DSH_SUPERAGENT_URL` must be `http://127.0.0.1`, `localhost` or `[::1]`; anything else and the process exits. |
| Route table | Only the listed orchestrator routes can be called. Path tricks (`..`, encoded slashes, `?`, `#`) are rejected before any request. |
| Token handling | Held in memory, never written to disk, redacted from every output and log. |
| Audit log | Every write appends a JSON line to `audit.log` (mode 600): time, tool, route, status, body **keys** and a short hash. Never body values. |
| Read-only switch | `DSH_MCP_READONLY=1` hides and refuses every write tool. |
| Restart gate | `check_setup` restarts the service, so it is refused unless `DSH_MCP_ALLOW_RESTART=1`. |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DSH_SUPERAGENT_URL` | `http://127.0.0.1:3082` | Service address (loopback only) |
| `DSH_SUPERAGENT_TOKEN` | auto | Panel token. If unset, read from the newest service log |
| `DSH_SUPERAGENT_LOG_DIR` | `../dsh-superagent/.artifacts` | Where `dsh-superagent-*.log` live (for the token) |
| `DSH_MCP_READONLY` | off | `1` = reads only |
| `DSH_MCP_ALLOW_RESTART` | off | `1` = allow `check_setup` |
| `DSH_MCP_AUDIT_LOG` | `./audit.log` | Audit file path |

The token changes on every service restart. The server logs in again on its own when the old cookie stops working.

## Known limits

- Only the Dot/UI-bridge routes are generic (via `api_request`); there is no dedicated tool for them.
- This server cannot start the service if it is stopped. Start it from Terminal (`scripts/dsh-superagent`).
- Output is truncated at ~60 KB; use `limit` and filters.

## Finding observations

`observe_finding` sends data only to `POST findings/observe`. The backend records external observation provenance; the response must state `execution_authorized: false`. This cannot confirm, dispatch, defer, review, publish or accept work. Repeated observations use stable problem and occurrence identities. Finding reads work in read-only mode; observation is hidden/refused there.

Typed finding/delivery decisions require their current native harness confirmation. Generic resolution/dismissal and the MCP route escape cannot substitute for it. No browser Origin or Sec-Fetch approval headers are synthesized. Existing loopback authentication, secret redaction and body-hash-only write auditing remain in force.

Long-lived MCP clients must refresh/reconnect this server to discover new tools; no harness restart is needed for this bridge update. Deploy the backend observation route before using it.

## Existing approved finding coordination

`coordinate_finding({id, instruction_file})` transports only an absolute local instruction-file path to the existing enabled backend. The backend checks current UID/mode0600/canonical path,15-minute expiry, exact finding/revision, existing native approval lineage, matching original choice and idle/current state. Supported actions remain bounded retry/confirm/defer. The tool cannot create first approval, accept evidence, publish, enable coordination, change scope or inject browser approval headers.

Native first approval and protected publication/acceptance remain explicit gates. This removes screen dependence for already-approved routine retries, not those gates. The MCP read-only setting hides and refuses the tool.
