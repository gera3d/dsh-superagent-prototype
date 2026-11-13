# Worker tool-output bound: corrected-hook measurement

Reproduce (run in the repository root, after `zstd -dc <archive>/session.v4.jsonl.zstd > /tmp/corpus/sN.jsonl` for the Sessions below):

    node --experimental-strip-types scripts/replay-output-bound.mjs --synthetic
    node --experimental-strip-types scripts/replay-output-bound.mjs /tmp/corpus/s{1,2,4,5,6,7,8}.jsonl

The script installs the real `installOutputBound` on a real `ToolRuntime` and runs every recorded result through `tools.execute`.
It measures model-facing tool-result text only. Bytes/4 is a token estimate. Input, output and cache-read tokens are separate
usage counters (see `scripts/measure-worker-context.py`); allowance burn, billed cost and provider cache pricing are not derivable
from these logs and are not claimed.

## Corpora (sha256 of the decompressed log)

| id | sha256 |
|----|--------|
| s1 | 7166b816e135042ca079e2d9a173bf5b35f54f37ed37d85b47a3e983ebd7c3c8 |
| s2 | b3424f7a500f852fedb486a14dbdff1b276ff9fc05815b8666b356f9422756ee |
| s4 | 1156e31a5eb04d71a4291ea89a0c4c8ffcac14710e54590fe3eeef300fe26b13 |
| s5 | 4629c41b1b303c316e5b4320be87074553bb6d54f096034698706e63342784a3 |
| s6 | 809b8bb065474f736af29d7a422f7adeee0e9113c9ccc1a9ee2c5eeb3368a74b |
| s7 | b3978247a1f40477a0087d26db816a182ae74f47a0218e1b68fc9f2b13a315ec |
| s8 | ed3d4b0fd870092c7c726fad5d51f12c388977853b1795b0af3954a038b16651 |

s1..s8 are the first eight (sorted path) `archive/sessions/*/worker-*/session.v4.jsonl.zstd` of the local harness; s3 (565 bytes) has no
tool results and is left out. Synthetic corpus: eight fixed cases S1..S8 in the script (S7 is a 20,000-byte line followed by a status line; S8 is a true single
line of 20,016 bytes ending in `[exit code: 137]`); its JSON output sha256 is
`7cbf2c867e19513609e1a4d33390a8fa0b4a6594c434af77c7074e25248ddcc6` and is identical on repeated runs. (The earlier 7-case hash
`7f3e6a71…` no longer applies: S8 was added.)

## Results

| corpus | results | bounded | before bytes | after bytes | saved | worst bounded | over limit | errors altered | tail lost | retrieval mismatch |
|--------|--------:|--------:|-------------:|------------:|------:|--------------:|-----------:|---------------:|----------:|-------------------:|
| synthetic | 8 | 5 | 356,584 | 153,047 | 57.1% | 4,094 | 0 | 0 | 0 | 0 |
| recorded s1,s2,s4–s8 | 644 | 68 | 1,043,327 | 771,843 | 26.0% | 4,095 | 0 | 0 | 0 | 0 |

(approx. tokens: recorded 260,832 → 192,961; synthetic 89,146 → 38,262.) The recorded numbers are unchanged by the single-line fix: no recorded result is a lone oversized line. Every bounded result's saved file hashed equal to the
original text. The 4 `isError` results in the recorded corpus that are over the limit were passed whole (none altered).

## Limits of the claim

- This is a per-result size reduction of the tool-result text, not a quota or cost saving. The earlier "98 sessions / 29.9%" replay is
  unverified here and is not claimed.
- Later requests re-send earlier results (cache reads or input tokens); the effect on those depends on the provider's cache and was
  not measured.
- The recorded Sessions ran without the bound; the replay does not model how a worker would have behaved differently after seeing a
  bounded result (for example, extra `read` calls into the saved file).
- Prompt text: relative to the pre-#92 prompts, `prompts/work.md` and `prompts/team/communication.md` are restored by this change
  (the policy lines #92 removed are back: the attention-only IM condition, "a PR merely existing is not a delivery milestone", the
  ready example, the acknowledgement rule and its bots/CI clause, and "Assess scope yourself under the Ticket scope section"). The
  only difference from the pre-#92 text is that the tool-output sentence #92 appended to "Review changes and run relevant checks."
  is on its own line and narrowed to successful shell and search output. Relative to the current merged base (#92) the diff therefore only adds those restored lines. No prompt
  reduction, and no progress to the 4,500-token target, is claimed; no duplicated line was shown to be removable without losing a rule.

## Behavior of the bound at its edges

- A text of one line is cut like any last line: the head is given up before the last 120 characters, so a trailing
  `[exit code: N]` / `[status: ...]` survives (regressions: `tests/tool-output.spec.ts`, `tests/tool-output-runtime.spec.ts`
  through the real `ToolRuntime`; replay case S8).
- An oversized result that is an error (thrown or `isError`) is deliberately passed whole and saved nowhere: a failing command's
  diagnostic is not hidden or cut. `prompts/work.md` now says so ("Successful shell and search output … (an error is shown whole)", about +10 tokens).
- When the pointer is so long that the full notice leaves no room, the result falls back to a compact notice that keeps the whole
  pointer and the end of the last line. If even that, or a storage failure, would break the limits or lose the pointer, the hook
  leaves the original model content unchanged.
