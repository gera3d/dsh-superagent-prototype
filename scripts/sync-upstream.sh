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

UPSTREAM_BRANCH="upstream/main"
# Last upstream commit a person reviewed (see docs/011). The fork shares no history with upstream, so commits cannot be
# counted with `git log A..B`; compare the upstream tip with this recorded commit instead.
REVIEWED="$(sed -n 's/^Last reviewed upstream commit: `\([0-9a-f]*\)`.*/\1/p' docs/011-upstream-synchronization.md | head -n 1)"
TIP="$(git rev-parse "$UPSTREAM_BRANCH")"

MODE="${1:---check}"

if git merge-base HEAD "$UPSTREAM_BRANCH" >/dev/null 2>&1; then
  echo "Note: histories are related now; see docs/011 before choosing a workflow."
fi

if [[ -n "$REVIEWED" && "$TIP" == "$REVIEWED"* ]]; then
  echo "✓ upstream/main is unchanged since the last reviewed commit ($REVIEWED). Nothing to port."
  exit 0
fi

echo "Upstream changed: tip ${TIP:0:8}, last reviewed ${REVIEWED:-none}."
git log --oneline -n 20 "$UPSTREAM_BRANCH"
echo ""

if [[ "$MODE" != "--check" ]]; then
  echo "Error: '$MODE' is not supported. The fork shares no history with upstream, so it cannot be rebased or merged."
  echo "Port changes by hand as described in docs/011-upstream-synchronization.md, section 3."
  exit 2
fi

echo "Review with: git diff superagent-core $UPSTREAM_BRANCH -- <path>"
exit 0
