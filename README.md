# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Senior Developer helper API

`POST /orchestrator/api/helper/suggest` requires `x-orchestrator-request: 1` and the same loopback Host/origin checks as management routes. Send only a compact digest, never raw session events:

```json
{"summary":"Earlier milestones (under 1500 characters)","latestTurn":"Latest turn text / incremental diff (1–12000 characters)"}
```

The strict body accepts no other fields and is capped at 64 KiB. It returns `{"options":[{"id":"verify","label":"Run tests","prompt":"Run automated tests and inspect diffs.","recommended":true},...]}` with 2–4 distinct options and exactly one recommendation. Draft generation is tool-free and does not wait for scoring or dispatch any action.

`settings.models.helper` is a nullable role model (`provider`, `model`, optional `reasoningEffort`), defaulting to `null`. Null starts at the existing first starred/first hierarchy route, or the host default if the hierarchy is empty; existing Eval/Executor defaults are unchanged. Availability errors use the existing model ladder/DeepSeek fallback within `maxEscalations` and one shared 6-second deadline. Model failures return a sanitized error so callers can fall back locally; malformed input returns HTTP 400. The helper uses the existing enabled Senior Developer character (built-in Senior Developer if absent), its verification standards and permission to disagree. Model authentication stays in the host model service; inline credentials are not accepted.

This server change is independent of the stall guard and does not change live settings or install/restart anything. Rollback: `git revert <helper-server-commit>`; clients must keep their local suggestion fallback when this route is unavailable. Real-turn latency measurement and UI verification belong to the plugin integration, not these mocked server tests.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
