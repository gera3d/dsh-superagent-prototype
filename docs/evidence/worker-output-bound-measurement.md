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
tool results and is left out. Synthetic corpus: seven fixed cases S1..S7 in the script; its JSON output sha256 is
`7f3e6a7146db5dafae8fb18ca14ccfb45f6d8c303f6aafef8a96eef915cc897f` and is identical on repeated runs.

## Results

| corpus | results | bounded | before bytes | after bytes | saved | worst bounded | over limit | errors altered | tail lost | retrieval mismatch |
|--------|--------:|--------:|-------------:|------------:|------:|--------------:|-----------:|---------------:|----------:|-------------------:|
| synthetic | 7 | 4 | 336,560 | 152,428 | 54.7% | 4,094 | 0 | 0 | 0 | 0 |
| recorded s1,s2,s4–s8 | 644 | 68 | 1,043,327 | 771,843 | 26.0% | 4,095 | 0 | 0 | 0 | 0 |

(approx. tokens: recorded 260,832 → 192,961; synthetic 84,140 → 38,107.) Every bounded result's saved file hashed equal to the
original text. The 4 `isError` results in the recorded corpus that are over the limit were passed whole (none altered).

## Limits of the claim

- This is a per-result size reduction of the tool-result text, not a quota or cost saving. The earlier "98 sessions / 29.9%" replay is
  unverified here and is not claimed.
- Later requests re-send earlier results (cache reads or input tokens); the effect on those depends on the provider's cache and was
  not measured.
- The recorded Sessions ran without the bound; the replay does not model how a worker would have behaved differently after seeing a
  bounded result (for example, extra `read` calls into the saved file).
- Prompt text: the candidate's `communication.md` trimming was reverted because those lines carried policy (the attention-only IM
  condition, the "PR existing is not a milestone" rule, the acknowledgement rules, the scope instruction). The only prompt change is one
  added sentence in `prompts/work.md` telling workers to read the saved file, about +45 tokens. No prompt reduction, and no progress to
  the 4,500-token target, is claimed.
