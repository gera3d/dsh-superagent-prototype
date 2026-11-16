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

s1..s8 are the first eight (sorted path) `archive/sessions/*/worker-*/session.v4.jsonl.zstd` of the local harness when first taken; s3 (565 bytes) has no
tool results and is left out. Re-decompressing the archive on 2026-11-13 yields seven files whose hashes match the table (the s3 entry is no longer listed), so the ids above follow the hashes. Synthetic corpus: eight fixed cases S1..S8 in the script (S7 is a 20,000-byte line followed by a status line; S8 is a true single
line of 20,016 bytes ending in `[exit code: 137]`); its JSON output sha256 is
`7cbf2c867e19513609e1a4d33390a8fa0b4a6594c434af77c7074e25248ddcc6` and is identical on repeated runs. (The earlier 7-case hash
`7f3e6a71…` no longer applies: S8 was added.)

## Results

| corpus | results | bounded | before bytes | after bytes | saved | worst bounded | over limit | errors altered | tail lost | retrieval mismatch |
|--------|--------:|--------:|-------------:|------------:|------:|--------------:|-----------:|---------------:|----------:|-------------------:|
| synthetic | 8 | 5 | 356,584 | 153,047 | 57.1% | 4,094 | 0 | 0 | 0 | 0 |
| recorded s1,s2,s4–s8 | 644 | 68 | 1,043,327 | 771,843 | 26.0% | 4,095 | 0 | 0 | 0 | 0 |

(approx. tokens: recorded 260,832 → 192,961; synthetic 89,146 → 38,262.) The recorded numbers are unchanged by the single-line fix: no recorded result is a lone oversized line. Every bounded result's saved file hashed equal to the
original text.

### Error results: what the recorded corpus contains, and what is out of scope

An independent tally of the same 644 recorded results (`docs/evidence/context-efficiency-r5-error-coverage.json`, reproduced here
by the replay command above, rows with `error: true`; re-run on 2026-11-13: 644 results, 68 bounded, 1,043,327 → 771,843 bytes, savedFiles 68):

| class | results | bytes before | note |
|-------|--------:|-------------:|------|
| text tool results with `isError` | 10 | 1,697 | largest 232 bytes, one line each; **0 exceed 4,096 bytes or 100 lines**; none bounded, none altered |
| successful results of bounded tools (`bash`, `grep`, …) over the limit | 68 | — | 64 over 4,096 bytes plus 4 over 100 lines; all bounded and saved |
| oversized results of tools the bound never touches (`read` 12, `skill` 7) | 19 | 139,949 | out of scope by design |

The recorded corpus therefore contains **no** oversized error, and an earlier statement that it held 4 oversized `isError` results is
not supported by it (and nothing here supports a claim that the model repeats failing output). No error-handling saving is claimed.

Scope limit: an oversized error is deliberately passed whole and saved nowhere, so a failed build or test run with very large output
would still enter the model context in full. This is a chosen trade-off (an earlier review required it, so a failing command's
diagnostic and exit code are never hidden or cut), not a gap that was measured; its size in real use is unknown because the
recorded corpus has no such case. The behavior itself is covered by a separate controlled synthetic case, not by recorded data:
replay case `S4-bash-oversized-error` is a 56,904-byte `isError` result that reaches the model whole (56,911 bytes with the runtime's
error prefix, `bounded: false`, `errorsAltered: 0`), and `tests/tool-output.spec.ts`, `tests/tool-output-runtime.spec.ts` and
`tests/tool-output-sessions.spec.ts` assert it through the hook, the real `ToolRuntime` and a worker Session.

## Limits of the claim

- This is a per-result size reduction of the tool-result text, not a quota or cost saving. The earlier "98 sessions / 29.9%" replay is
  unverified here and is not claimed.
- Later requests re-send earlier results (cache reads or input tokens); the effect on those depends on the provider's cache and was
  not measured.
- The recorded Sessions ran without the bound; the replay does not model how a worker would have behaved differently after seeing a
  bounded result (for example, extra `read` calls into the saved file).
- Prompt text: this change makes no prompt reduction and claims no progress to the 4,500-token target. Relative to the pre-#92
  prompts, `prompts/work.md` and `prompts/team/communication.md` restore policy that #92 removed, except for two lines that were
  shown to be redundant and are not restored: "Human attention is the condition for an unsolicited IM update." (said by the
  preceding "Unsolicited IM must require human attention: …") and "A PR merely existing is not a delivery milestone." (said by
  "Creating a PR does not mean it is ready, fixed or merged." together with "Send a result only when the worker confirms …"). What
  is restored is the ready example, "Assess scope yourself under the Ticket scope section", and the acknowledgement rule with its
  bots/CI clause. Relative to the current base, `prompts/team/communication.md` adds the ready example line and **replaces** the
  one line "Silent resolution does not suppress the initial acknowledgement of a new human request." with the two pre-#92
  acknowledgement lines (net +2 lines in the file, with the ready example); `prompts/work.md` adds the scope line and moves the tool-output sentence onto its own
  line, narrowed to successful shell and search output. Beyond those two removed restatements, no other duplicated line was shown to
  be removable without losing a rule.

## Behavior of the bound at its edges

- A text of one line is cut like any last line: the head is given up before the last 120 characters, so a trailing
  `[exit code: N]` / `[status: ...]` survives (regressions: `tests/tool-output.spec.ts`, `tests/tool-output-runtime.spec.ts`
  through the real `ToolRuntime`; replay case S8).
- An oversized result that is an error (thrown or `isError`) is deliberately passed whole and saved nowhere: a failing command's
  diagnostic is not hidden or cut. `prompts/work.md` now says so ("Successful shell and search output … (an error is shown whole)", about +10 tokens).
- When the pointer is so long that the full notice leaves no room, the result falls back to a compact notice that keeps the whole
  pointer and the end of the last line. If even that, or a storage failure, would break the limits or lose the pointer, the hook
  leaves the original model content unchanged.
