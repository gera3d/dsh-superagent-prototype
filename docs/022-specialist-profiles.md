# 022 Specialist profiles (bounded v1)

Candidate only. Not live-qualified. Root owns independent review and release.

## What it is
One typed registry (`src/core/specialist-profile.ts`) over the existing character mechanism, seeding **Administrator**,
**Senior Developer** (derived from `DEFAULT_SENIOR_DEVELOPER_CHARACTER`, so it cannot drift) and **Cloudflare Specialist**.
Fields: identity, specialty, versioned/pinned knowledge refs, capability identifiers, model-policy inheritance, owner,
supported activity states, routing keywords. `src/core/specialist-schema.ts` validates it (server side only).

## Authority rules
- A profile **declares** capabilities; effective capabilities = declared ∩ natively discovered (`specialist-capability.ts`).
  Titles, specialty and knowledge text are never read as grants. `cloudflare.write` is never grantable in v1.
- Discovery is a read-only list of native tool names (`discoverNativeTools(ctx.tools)` → `schemas()` names; MCP tools are
  `mcp__<server>__<tool>`). Nothing connects, installs, authenticates or copies credentials.
- **Cloudflare is unavailable in this Harness** (no Cloudflare MCP tool registered; the Codex connector is a different
  system and is not assumed). The specialist then returns "Cloudflare capability unavailable" with the decision for Gera:
  *connect an official Cloudflare MCP server (`https://mcp.cloudflare.com/mcp`, OAuth, added by a person), or keep it advice-only.*
- Administrator only proposes the delivery's already-recorded `nextAction`, only when the delivery has an owner and
  already delegated that action kind; never `accept`; at most 10 deliveries; executes nothing.
- Model policy is `inherit` only (`helper`/`executor`/`eval`) through the existing `helperRoute`/`defaultRoute`. Parked
  providers (e.g. OpenAI marked exhausted/conserved) stay skipped. Escalation is the separate Sonnet candidate (`52af0df`).

## One record, no duplicate job
`adviseWithSpecialist` (`src/app/specialist-advice.ts`): route (one profile, bounded text) → `claimCanonical` on the
existing session/message identity (fresh owner per call, so concurrent duplicates are refused) → injected tool-free advice →
`publishCanonical` → `DecisionInbox.attributeCharacter` (attribution only; refuses staged/closed/invalidated records).
Continuation is the unchanged explicit **stage → Send → native submission proof**. No new table, queue or runtime.

## Avatar/status
`SpecialistStatus` sits in the existing `dsa-decisions__header`. States: idle, investigating, tools, testing, waiting,
blocked, complete (+ non-working `unknown`). Derived by `specialist-activity.ts` from native Session events
(`turn/*`, `tool/call|result`, `approval/*`) or the shared decision record. Working evidence older than 90 s, no evidence,
future or untimed events → `unknown`/stale, never animated. `role="status"`, focusable, text label, `prefers-reduced-motion`
disables animation. Custom GIF/sprite: pass `art` (URL); none is bundled.

## Pilot transcript (mock, from `tests/specialist-advice.spec.ts`; not live)
```
task            "Deploy the Worker with wrangler to Cloudflare"
route           profile=cloudflare_specialist basis=keyword (single profile)
discovery       native tools: bash, read, mcp__chrome__navigate  (no Cloudflare MCP)
capabilities    granted=[advice.read]  refused=[cloudflare.docs.read, cloudflare.account.read: no_native_tool]
next decision   "Cloudflare capability unavailable: decide whether to connect an official Cloudflare MCP server ... or keep ... advice-only."
job identity    existing decision record (session/message/turn/seq/draftRevision); items before=0 after=1, same tables
advice          tool-free; options published once: docs-first (recommended), dry-run
status          waiting (choices published, nothing staged)
continuation    user stages -> Send -> native submission proof -> resolved(docs-first); character stays cloudflare_specialist
```

## UI evidence (header of the existing decision dock; same fixture, 800px viewport, light theme)
Real renders of the component via headless Chrome with the shipped CSS; baseline = `8e20607`, changed = this branch.
`docs/evidence/022/before-waiting.png`, `after-waiting.png` (Senior Developer default), `before-cloudflare.png` (identical to baseline),
`after-cloudflare.png` (unavailable capability shown as text). Dark theme and a live-session capture were not taken.

## Provenance
| Item | Source | Pin | Use |
|---|---|---|---|
| Cloudflare Skills | github.com/cloudflare/skills (Apache-2.0) | `6eb6c781aa9b6438e0c7307bd102788a75fe1a6d` | referenced by name/pin; no text copied |
| Cloudflare MCP | github.com/cloudflare/mcp (Apache-2.0) | `563b71037a3cc1f1ed52d944133abb3aca5a0901` | tool names (`docs`,`search`,`execute`,`whoami`) only |
| Pixel Office | MIT, `7b04146b99b33769779d3814841a72be056944bc` | — | inspiration only, no code copied |
| Pixel Agents | MIT, `b1bafd02896d90d83457266575a1e8e5011ce997` | — | normalized-event idea only, no code copied |

## Integration seams (not implemented here)
- Outside-progress observation repair (worker `a291438f297872fcaa5e3c59a453fe4d`): feed its events through
  `activityFromSessionEvents` / `deriveActivity`; this change adds no observation store.
- Sonnet quality policy `52af0df`: escalation untouched.
- Wiring `adviseWithSpecialist` to an HTTP route and a real model call is deliberately left to the release owner.

## Release / rollback
- Release: merge the branch; the avatar renders in the existing decision header with no settings, schema or DB migration.
  `adviseWithSpecialist` is not reachable from any route yet, so behavior change is the header avatar only.
- Rollback: revert the branch. The only persisted effect of the new code is the optional `character` attribution on a
  decision record (already an existing optional field), which older code ignores.

## Known limitations
- `tests/canonical-next-steps.spec.ts` and `tests/inline-decision.spec.tsx` need the missing sibling `../../dsh-next-steps`
  (baseline failure), so the header integration is covered by typecheck + component tests of `SpecialistStatus`, not by that suite.
- Baseline `vitest` already had 4 failing tests (timeouts in `delivery-evidence`, one in `decision-submission-client`).
- Mock pilot only; no live model, no Cloudflare connection.
