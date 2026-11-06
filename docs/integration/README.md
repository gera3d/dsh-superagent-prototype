# Root-owned MCP observation companion

These two source-only artifacts were supplied by root in [issue171 comment6692096645](https://github.com/gera3d/superagent-sandbox/issues/171#issuecomment-6692096645). Only the patch and inventory were copied; no installed bridge, configuration, audit log or credentials were read/copied/changed by this worker.

- [Source patch](mcp-bridge.patch), SHA-256 `511aa7d2c62c5847f721bf0a1e5e311a6288b594f273e73f515a46ae9cbc5394`.
- [Root inventory](mcp-bridge-inventory.json), SHA-256 `4d5ea1eb27810c84d7bfd9955148f8956b870598446f9be051e3942e5008669e`.

The patch exposes finding reads and observation-only intake, checks `execution_authorized:false`, and centrally rejects generic mutations of typed finding/delivery/lifecycle decisions, including the generic API escape and restart. It introduces no confirmation/review/revisit/evidence route or impersonated browser approval envelope. Existing authenticated loopback transport and body-hash-only auditing remain.

Root's supplied inventory reports `node --check server.cjs` and 122 passed/0 failed isolated loopback mock checks, plus independent boundary review. Those are root-provided evidence, not tests rerun or native live acceptance claimed by this worker. The worker verified the copied patch matches the inventory digest. Root applies/reconnects the installed bridge only after combined release review; no harness restart is authorized by this artifact. The backend observation-only CLI is an alternative read/observe bootstrap, not a privileged-action transport.
