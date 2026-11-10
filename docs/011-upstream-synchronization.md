# 011 Upstream Synchronization

How this fork (`gera3d/dsh-superagent-prototype`, branch `superagent-core`) tracks the upstream research prototype (`deepseek-ai/dsh-superagent-prototype`).

## 1. State of the two repositories

Verified 2026-11-10:

- Upstream has a single commit on `main` (`8c32a9d`, from 2026-10-31) and no releases.
- **The fork shares no Git history with upstream.** `git merge-base superagent-core upstream/main` finds nothing. A merge or rebase of `upstream/main` into the fork therefore cannot work: a rebase would replay the fork's whole history onto an unrelated root, and a merge needs `--allow-unrelated-histories` and conflicts in nearly every file.
- The fork's `main` is not a pristine upstream mirror. It holds only the merge of PR #1 (`superagent-core`). Do not fast-forward it from upstream.
- `superagent-core` is the only active branch. All work lands on it by pull request.

```
upstream: deepseek-ai/dsh-superagent-prototype  (main: 8c32a9d)
              │  git fetch upstream   (read only, no shared history)
              ▼
   review the upstream tree, port what is wanted by hand
              │
              ▼
origin: gera3d/dsh-superagent-prototype  superagent-core  ← pull requests, CI (pnpm check)
```

## 2. Checking for upstream changes

```bash
scripts/sync-upstream.sh --check
```

The script adds the `upstream` remote if needed, fetches it, and compares `upstream/main` with the **last reviewed upstream commit** recorded below. It changes no branch. With no change it prints that upstream is unchanged.

To inspect by hand:

```bash
git fetch upstream
git log --oneline upstream/main          # all upstream commits; the list is short
git diff superagent-core upstream/main -- <path>   # a two-tree diff works without shared history
```

## 3. Porting an upstream change

1. Create a branch from `superagent-core`.
2. Read the upstream commit (`git show <sha>`), then apply the wanted parts by hand or with `git diff superagent-core upstream/main -- <paths> | git apply -3`. Never copy upstream files over local ones wholesale: `superagent-core` has local innovations in most files.
3. Run `pnpm check` (typecheck, tests, build) on Node 24.
4. Open a pull request to `superagent-core`, let CI pass, merge.
5. Update the last reviewed commit below in the same pull request.

Last reviewed upstream commit: `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` (2026-11-10, nothing to port; the fork already contains the feature set).

## 4. Local capabilities and where they live

Keep local work in files upstream does not touch where possible, so a port stays a read-and-copy task.

| Capability | Files owned |
|---|---|
| OS computer use | `scripts/macos-input-helper*`, `scripts/dsh-computer-use-mcp.cjs`, `skills/dsh-superagent-computer-use/`, `docs/010-os-computer-use.md` |
| OAuth login CLI | `scripts/dsh-login.cjs` |
| Visual activity indicator | `docs/009-visual-activity-indicator.md`, `src/client/activity.tsx` |
| ADHD progress streaming | `skills/dsh-superagent-adhd/` |
| Chrome and Composio MCP | `skills/dsh-superagent-chrome/`, `skills/dsh-superagent-composio/` |
| Service supervision | `scripts/dsh-superagent` |

## 5. Superagent Sandbox pull requests

Worker sessions act on `gera3d/superagent-sandbox`: each ticket gets a branch `agent/<ticket-slug>`, and its pull request opens against that repository's `main`. Merged work stays in the sandbox repository.
