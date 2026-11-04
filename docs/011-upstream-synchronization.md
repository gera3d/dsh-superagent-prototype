# 011 Upstream Synchronization & Feature Tracking Strategy

This document establishes the Git topology, synchronization protocols, and branch lifecycle management to ensure `dsh-superagent` seamlessly pulls new upstream features from `deepseek-ai/dsh-superagent-prototype` while preserving all local innovations and operator capabilities.

---

## 1. Repository Topology & Remote Architecture

```
                       [Upstream: deepseek-ai/dsh-superagent-prototype]
                                        │
                                        │ git fetch upstream
                                        ▼
                      [Local Remote Ref: upstream/main]
                                        │
                         ┌──────────────┴──────────────┐
                         │ rebase / cherry-pick / merge │
                         ▼                             ▼
   [Local: main (tracking upstream)]     [Local: superagent-core (active features)]
                                                       │
                                                       │ git push origin
                                                       ▼
                                   [Origin: gera3d/dsh-superagent-prototype]
```

### Remotes Configuration
- **`upstream`**: `https://github.com/deepseek-ai/dsh-superagent-prototype.git` (Official research prototype maintained by DeepSeek Harness team).
- **`origin`**: `https://github.com/gera3d/dsh-superagent-prototype.git` (Gera's personal fork hosting active feature branches).

### Active Branch: `superagent-core`
All custom enhancements live on `superagent-core`. The `main` branch tracks pristine `upstream/main` as a clean rebase reference.

---

## 2. Feature Modularity Matrix

To prevent merge conflicts when upstream code changes, all custom capabilities are designed with strict structural modularity:

| Capability | Isolation Strategy | Files Owned | Upstream Touchpoints |
|---|---|---|---|
| **OS Computer Use** | Standalone scripts + MCP daemon | `scripts/macos-input-helper*`<br>`scripts/dsh-computer-use-mcp.cjs`<br>`skills/dsh-superagent-computer-use/`<br>`docs/010-os-computer-use.md` | Non-intrusive (plugs via profile patch) |
| **OAuth Login CLI** | Standalone Node CLI | `scripts/dsh-login.cjs` | Zero upstream collision |
| **Visual Activity Indicator** | Spec + Client component slot | `docs/009-visual-activity-indicator.md`<br>`src/client/activity.tsx` | Cordis slot registration |
| **ADHD Progress Streaming** | Prompts & Skill layer | `skills/dsh-superagent-adhd/` | Skill registry |
| **Chrome & Composio MCP** | Profile patch + Skills | `skills/dsh-superagent-chrome/`<br>`skills/dsh-superagent-composio/` | Profile patch |
| **Darwin Helper Recognition** | Daemon supervisor fix | `scripts/dsh-superagent` | Darwin process check |

---

## 3. Step-by-Step Upstream Sync Protocol

### Step 1: Fetch Upstream State
```bash
git fetch upstream
```

### Step 2: Inspect Incoming Upstream Changes
Before applying changes, review what upstream added or modified:
```bash
# View list of new upstream commits
git log --oneline superagent-core..upstream/main

# Review full diff of incoming changes
git diff superagent-core...upstream/main
```

### Step 3: Fast-Forward Local `main`
Keep local `main` synchronized with upstream:
```bash
git checkout main
git merge --ff-only upstream/main
git push origin main
```

### Step 4: Rebase `superagent-core` onto Updated `main`
Rebasing replays custom features cleanly on top of the latest upstream commits:
```bash
git checkout superagent-core
git rebase main
```

### Step 5: Validate Test Suite & Build
After rebasing or merging, verify that the entire test suite and build pipeline pass:
```bash
pnpm check
```
*(Runs `tsc --noEmit`, `vitest run`, and `tsdown`)*.

### Step 6: Push to Fork
```bash
git push origin superagent-core --force-with-lease
```

---

## 4. Automated Sync Helper Script: `scripts/sync-upstream.sh`

An automated synchronization script is provided at `scripts/sync-upstream.sh` with the following modes:

- **`./scripts/sync-upstream.sh --check`**: Inspects upstream without modifying any branches; prints incoming commits and changed files.
- **`./scripts/sync-upstream.sh --rebase`**: Automatically fetches, fast-forwards `main`, rebases `superagent-core`, runs `pnpm check`, and reports results.
- **`./scripts/sync-upstream.sh --merge`**: Merges `upstream/main` into `superagent-core` if a merge commit workflow is preferred over rebase.

---

## 5. Superagent Sandbox PR Integration

Work executed autonomously by worker sessions against `gera3d/superagent-sandbox`:
- Tickets create dedicated feature branches (`agent/<ticket-slug>`).
- Pull requests are opened automatically against `main` of `superagent-sandbox`.
- Once merged, the capabilities (guides, scripts, configurations) become permanent fixtures of the sandbox repository.
