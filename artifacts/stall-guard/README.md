# Lifecycle inbox captures

- **Before:** [before.png](<./before.png>), baseline `dbf9410f07cecdb9a855bb98c42a6b105dcf73cc` (the checkout's original HEAD).
- **After:** [after.png](<./after.png>), lifecycle implementation on `agent/stall-guard-4ce44d956fef` (the exact changed commit is identified in the PR description). Both are **1440×913**, device scale 1.
- **Method:** actual app `DecisionsPage` + actual server `ticketDecisions`, with exactly the same three synthetic `Ticket` aggregates on both revisions. Baseline projection and view were extracted using `git show`; shared presentation components/CSS and stage classification are unchanged. Baseline yields two generic ready cards and no stuck card; after yields one stuck and two done cards. The docs/code distinction uses synthetic GitHub file responses through the actual `enrichLifecycle` server verifier.

## Isolation and limits

React `renderToStaticMarkup` renders the real app components into a local HTML fixture; headless Chrome captures that HTML via `file://`. No live app, server, account, repository data, PR operation, credentials, apply or restart is used. The fixture mocks panel hooks/API data and supplies a fixed dark host-token palette; it does not render the DSH navigation shell. It verifies visual layout only, not browser interaction or a deployed integration. React's expected SSR `useLayoutEffect` warnings come from the unchanged help tooltip. Interaction and action safety are covered separately by lifecycle tests.

The saved viewport intentionally clips baseline's second large generic card below the fold; all three changed cards fit in the same viewport. No notification sound was added.

## Reproduce

Run from the checkout root (requires installed dependencies and Chrome; adjust the executable path on other platforms):

```sh
cp artifacts/stall-guard/capture-fixture.tsx.txt tests/lifecycle-capture.spec.tsx
git show dbf9410:src/client/decisions.tsx > src/client/.capture-baseline.tsx
git show dbf9410:src/app/decision-inbox.ts > src/app/.capture-baseline-inbox.ts
pnpm exec vitest run tests/lifecycle-capture.spec.tsx
PROFILE=$(mktemp -d /tmp/stall-guard-chrome.XXXXXX)
for REV in before after; do
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
    --headless --disable-gpu --no-first-run --no-default-browser-check \
    --hide-scrollbars --force-device-scale-factor=1 --user-data-dir="$PROFILE" \
    --window-size=1440,913 --screenshot="$PWD/artifacts/stall-guard/$REV.png" \
    "file://$PWD/artifacts/stall-guard/$REV.html"
done
```

The temporary capture test, two baseline source snapshots, generated HTML, and temporary Chrome profile are not application files; remove those exact verified paths after capture. Keep the two PNGs and this reproducibility fixture. Chrome may print macOS display-link diagnostics in headless mode; capture succeeds with exit code 0.
