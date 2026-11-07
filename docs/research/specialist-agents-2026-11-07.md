# Reuse research: specialist agents and animated presence

Research date: November 7, 2026. Read-only GitHub search, repository metadata, README/license review and selected source inspection. No installation, application execution, account connection, benchmark or security audit. Fit assessments below are engineering inferences, not demonstrated DSH compatibility.

## Recommendation

Reuse specialist knowledge and animation components; retain DSH/Superagent as the execution, canonical decision and protected release system. Start with a small adapter and compact avatar next to the existing recommendations. Do not introduce a second authoritative task queue or replace the tested GitHub delivery machinery merely to obtain characters.

## Shortlist

| Project | Existing capability | Proposed reuse | Important gap |
|---|---|---|---|
| [Pixel Office](https://github.com/basriayaz/pixel-office) | Closest full-product match: named employees with role, appearance, memory, skills, model, tools/permissions, integrations and colleague handoffs | Agent-profile schema, skill organization and compact identity/state concepts | Separate runtime/control plane; not a drop-in DSH plugin. README claims are not operational qualification. Current provider-specific access defaults need review before importing them. |
| [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) | Animated characters driven by tool/session/permission events; provider boundary and standalone/browser rendering | Event-to-animation adapter and character rendering patterns | Source currently ships Claude hook integration; DSH requires its own adapter. Full office canvas is optional and must not obstruct chat. |
| [Agency Agents](https://github.com/msitarzewski/agency-agents) | Specialist role definitions, standards, procedures and expected deliverables | Starter operating briefs, reviewed and tailored for Administrator, reviewer and domain experts | Persona documents are not executable tools, real permission enforcement or a persistent job system. |
| [Cloudflare Skills](https://github.com/cloudflare/skills) and [Cloudflare MCP](https://github.com/cloudflare/mcp) | Official domain procedures plus API/documentation access over MCP | Cloudflare Specialist knowledge and existing authorized tool connection | Validate DSH skill/MCP discovery and precise account/tool scope. Installing a skill does not grant authority. No account access was tested in this research. |
| [AgentOffice](https://github.com/esteban-dcp/AgentOffice) | Fork advertising generic MCP events, GitHub context and animated office | Secondary reference for a status bridge | Older repository activity and unverified advertised capabilities; not the first adoption choice. |

## Source observations

Pixel Office at [7b04146](https://github.com/basriayaz/pixel-office/tree/7b04146b99b33769779d3814841a72be056944bc): `src/server/agents.ts` builds a profile from agent instructions, memory and skills directories. `src/server/employee.ts` has explicit fields for role, appearance, allowed tools, permission mode, model, memory, manager behavior, worktree and integrations. Some provider connector defaults differ, so copying the schema must not copy access semantics blindly. `src/server/skills.ts` provides an actual skill-management module. These are code observations, not a complete behavioral review.

Pixel Agents at [b1bafd0](https://github.com/pixel-agents-hq/pixel-agents/tree/b1bafd02896d90d83457266575a1e8e5011ce997): `core/src/provider.ts` defines normalized tool-start/end, session, progress, permission and subagent events. Its comments explicitly say only the Claude HookProvider ships at this revision. `webview-ui/src/office/engine/officeState.ts` contains rendering state logic. That separation is a plausible reuse seam for DSH, but no adapter has been implemented.

## Licenses and maturity

GitHub metadata and root license files list Pixel Office, Pixel Agents, Agency Agents and AgentOffice as MIT; Cloudflare Skills as Apache-2.0. Retain notices when adapting code and inspect the exact files/assets selected before copying them. Root code licensing is not a blanket qualification of every third-party sprite, logo or external art pack. The smaller full-app Pixel Office project is a closer feature match; the broader Pixel Agents project has a larger public footprint. Neither popularity nor README completeness proves reliability or DSH compatibility.

## Proposed small proof, not yet authorized or started

Use the existing DSH agent identity and canonical job state. Map real runtime events into a compact avatar with idle, investigating, tools, testing, waiting, blocked and complete states. Keep the current composer and recommendation layout. Give one specialist an explicit knowledge/skill bundle and allowed tools; let Senior Developer advice consume the same current job record. Verify handoff ownership, stale-card prevention, actual permission enforcement and completion truth before expanding. User-generated custom animation can replace artwork later without changing task semantics; a state-driven renderer is more useful than a single endlessly looping GIF.

Administrator/agent-profile implementation remains a design proposal. This research does not alter the two already-approved work tracks or grant new model, tool, account or deployment authority.
