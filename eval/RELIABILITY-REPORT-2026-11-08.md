# 0.11.1 reliability delivery and bounded live pilot

Date: 2026-11-08 (America/New_York). This is a diagnostic development pilot, not an efficacy or release-readiness claim.

## Implemented and mechanically verified

- Save and update share one write boundary. Low confidence and confirm mode cannot be bypassed with `force`; a lexically detected cross-file conflict returns the owning file without creating another active memory. Explicit correction can update that file.
- Proposed update/delete/rename and direct model updates carry a SHA-256 expected version. The store compares it under its write lock before mutating history or files; stale approval preserves both the author's edit and the pending proposal. Legacy proposals without hashes remain compatible and lack this protection.
- Structured Dream evidence maps each added nonempty body line to a quote. Host-owned provenance retains session and event sequence, including tool call/result sequences and long-session analysis. String-only legacy citations remain manually usable with an operation-level warning. Literal matching does not establish semantic entailment.
- Automatic semantic rewrites and unproved deletions use the existing review proposal flow. Large shrinks remain reviewable, pending proposals cannot be shadowed, and watermarks wait for successful application. Mechanical content preservation uses conservative text equality; code indentation is meaningful.
- UI remained frozen. The independent review's three concrete findings were reproduced and repaired with regressions.

Final local verification: `node scripts/verify.mjs` checks structure, syntax and all tests; **RESULT: PASS** after the last guard change. The suite has 62 test files and 462 assertions. `node scripts/ui-freeze.mjs` confirms all four frozen files match their manifest. `node eval/validate.mjs` passes. The installed-host no-model preflight also passes using the existing `cc-memory-eval` profile.

## Live setup and provenance

- Provider/model: the installed profile's `deepseek-official` / `deepseek-flash` (checked with a field allowlist; no keys printed).
- Harness contract v14; the existing scenarios and rubrics were retained. The manifest was explicitly re-frozen for version 0.11.1; it does not retroactively change old runs.
- Two synthetic history scenarios, three query cases (stable preference, current-instruction variant, user correction), one repetition per condition, four conditions: A (no tools/memory), B0 (same memory tools, empty memory), B (saved memory), C (B plus a pure-consolidation Dream).
- Every condition has an isolated `memoryRoot`, cross-project user memory is disabled, base tools are locked, and Dream reads zero historical sessions. Only fixture text and generated test answers were sent; daily memories and personal transcripts were not used.
- Two run directories, ending in `02-31-00-776Z` and `02-33-29-778Z`, contain original records and reports. UTC timestamps fall on November 9; the local evaluation date is November 8.
- Source hashes were unchanged during both runs and were checked after completion. After both runs, the automatic-review whitespace comparison was tightened to preserve code indentation, with a RED/GREEN regression and a full final verifier. These live results therefore describe the pinned pilot snapshot, not independent live validation of that final mechanical guard. See [source hashes](reliability-0.11.1-source-hashes.json).

## Original outcomes (not rescored)

| Query | A | B0 | B | C |
|---|---|---|---|---|
| Stable handoff preference | FAIL | FAIL | PASS | PASS |
| Current instruction: one factual paragraph | FAIL | FAIL | FAIL | FAIL |
| User correction: concise, conclusion first | FAIL | FAIL | FAIL | PASS |

All 12 conditions passed device comparability checks and snapshot restoration checks. There were no runner errors, device-invalid conditions or missing grades. Task failures are retained as task failures. Do not interpret the report's `valid` aggregate, which separates task failures, as the number of comparable conditions.

Both Dream calls applied **zero operations** and reviewed zero sessions. B/C differences in this pilot cannot be attributed to changed memory content or to Dream consolidation.

## Trajectory interpretation and grading limits

1. The stable preference case provides a concrete successful use of stored formatting preferences in B and C. A emitted DSML pseudo-tool text instead of completing the task; A remains a protocol diagnostic, and B0 is the relevant tool-matched control. One repetition does not establish a general memory benefit.
2. In the current-instruction variant, every group added headings or multiple sections despite the request for one paragraph. B and C also added explanations about remembered preferences. The judge correctly separates this format violation from actually providing prohibited rollback/todo actions. The literal forbidden-word check additionally fails B/C for mentioning those words in explanations; this is not independent evidence that the old actions were carried out.
3. In the correction case, B and C both begin with a conclusion but also include substantial implementation detail. The same model judge rejects B as too detailed and accepts C. This grading difference needs human or calibrated independent review; it is not proof of C's superiority. Original scores are preserved.
4. No fabricated-history flag was raised in these 12 queries, but that is only a judge observation on this sample, not a general fabrication guarantee.
5. The restricted-tool configuration is not an ordinary full coding-agent session. Automatic Dream trigger behavior and new transcript-evidence checks are covered locally, not by these pure-consolidation live calls.

## Recorded usage and limits

Numbers below are the runner's reported `totalTokens` (including cached input), not monetary costs. They are not a complete account-level bill.

| Phase | Reported totalTokens |
|---|---:|
| Synthetic history | 89,393 |
| Outer Dream orchestration | 13,637 |
| Queries A | 6,074 |
| Queries B0 | 19,773 |
| Queries B | 12,900 |
| Queries C | 13,707 |

Judge usage and internal Dream usage are excluded from this table; they are not zero. No cost-efficiency conclusion is justified by these partial counts.

## Supported decision

Retain the first delivery's deterministic write/review protections. Leave auto Dream disabled by default. There is insufficient evidence to enlarge its unattended semantic authority or add retrieval infrastructure. The next behavioral gap is concise adherence to a current format instruction without extra memory explanations, followed by calibration of the brevity grader using fresh examples.

The original records are not in this repository: they contain local paths and need redaction before release.
