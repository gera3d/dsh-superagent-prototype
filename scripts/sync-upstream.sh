#!/usr/bin/env bash
set -euo pipefail

# scripts/sync-upstream.sh
# Synchronizes superagent-core with upstream deepseek-ai/dsh-superagent-prototype
# while verifying that all local feature suites and tests remain intact.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

UPSTREAM_URL="https://github.com/deepseek-ai/dsh-superagent-prototype.git"

# Ensure upstream remote exists
if ! git remote | grep -q "^upstream$"; then
  echo "Adding upstream remote ($UPSTREAM_URL)..."
  git remote add upstream "$UPSTREAM_URL"
fi

echo "==> Fetching latest changes from upstream..."
git fetch upstream --tags

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_BRANCH="upstream/main"

NEW_COMMITS="$(git log --oneline "$CURRENT_BRANCH..$UPSTREAM_BRANCH" 2>/dev/null || true)"
COMMIT_COUNT="$(echo "$NEW_COMMITS" | grep -c . || true)"

if [[ "$COMMIT_COUNT" -eq 0 ]]; then
  echo "✓ superagent-core is fully up to date with upstream/main. No new upstream commits found."
  exit 0
fi

echo "Found $COMMIT_COUNT new upstream commit(s):"
echo "$NEW_COMMITS"
echo ""

MODE="${1:---check}"

if [[ "$MODE" == "--check" ]]; then
  echo "Run './scripts/sync-upstream.sh --rebase' to integrate these commits into superagent-core."
  exit 0
fi

if [[ "$MODE" == "--rebase" ]]; then
  # Ensure working directory is clean
  if ! git diff-index --quiet HEAD --; then
    echo "Error: Working directory has uncommitted changes. Please commit or stash before syncing."
    exit 1
  fi

  echo "==> Updating local main branch..."
  git checkout main
  git merge --ff-only "$UPSTREAM_BRANCH"
  git push origin main

  echo "==> Rebasing $CURRENT_BRANCH onto updated main..."
  git checkout "$CURRENT_BRANCH"
  git rebase main

  echo "==> Running full verification check (tsc, vitest, build)..."
  pnpm check

  echo ""
  echo "✓ Successfully rebased $CURRENT_BRANCH onto upstream/main!"
  echo "To push to your fork, run:"
  echo "  git push origin $CURRENT_BRANCH --force-with-lease"
  exit 0
fi

echo "Unknown option: $MODE. Use --check or --rebase."
exit 1
