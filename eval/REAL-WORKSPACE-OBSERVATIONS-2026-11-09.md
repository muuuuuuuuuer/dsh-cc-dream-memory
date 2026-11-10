# Real-workspace Dream observations

Inspected on 2026-11-09. These are aggregate observations from one maintainer's working project, not a benchmark or a comparison of plugin versions. No session text, memory bodies, private paths, plan summaries, source quotes or credentials are included.

## One costly applied batch

One recorded batch used **149,984 reported total tokens** and took **263,258 ms (about 263 seconds)**. Its application metadata records two memory writes and one index operation, three operations in total. The total includes 15,744 cache-read tokens; token counts are provider-reported usage, not a monetary bill. The saved preview still says `dryRun: true`, while a separate application record confirms the later selective application. A preview's flag alone does not describe the final outcome.

This is substantially more usage than the README's synthetic three-short-session demonstration (6,500–11,000 tokens). The inputs and tasks differ, so this is not a controlled cost comparison or a typical-use estimate. Long-session analysis, generated output and repeated prompt processing can make the total much higher than an input-character estimate. Dry-run also calls the model and incurs usage; only the new estimate action is model-free.

## What the counters can establish

The current metrics ledger records six proposal events, three application events, two failure events, zero rejection events, 34 planned operations and 11 applied operations. Those phases are not mutually exclusive and may refer to the same work. The three application metadata records independently total 11 operations: eight memory writes and three index updates, with no file deletions.

The retained directory also has eight saved previews containing 32 operations, including older records without usage metadata. That inventory and the metrics ledger have different coverage and must not be added together. Repeated previews may propose the same edit. Therefore neither `11 / 34` nor an artifact count is an acceptance rate or a count of distinct facts.

## Why were other proposals not applied?

The available records do **not** preserve the maintainer's reason for leaving each preview unapplied. There is no recorded rejection event. An unapplied preview could be a rehearsal, a superseded plan, an undecided proposal or a rejected edit; the records cannot distinguish them. We do not label those operations as bad changes or invent a reason after the fact.

To assess Dream quality, record a decision and reason for each distinct proposed edit, inspect its source and final memory effect, and separate repeated previews from unique proposals. The loss-of-fact merge bug found during review is covered by synthetic engine regressions; these aggregate historical counters cannot establish which past batch, if any, was affected. Existing memories and historical records were left unchanged during this inspection.
