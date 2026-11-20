# Dream Conversation Review Implementation Plan

Current Dream runs complete the selected work and record usage. This plan records the initial budget experiment and the transcript and checkpoint work carried forward.

> Use writing-plans and test-driven-development with the existing Dream integration harness.

**Goal** Deliver bounded transcript review through the normal Dream command and scheduler.

**Architecture** Freeze DSH session snapshots behind the existing Dream tools. Persist review ranges and request reservations alongside the shadow draft. Keep existing approval and evidence checks on every proposal.

**Spec** [Dream conversation review](../specs/2026-11-18-dream-conversation-review-design.md)

- [x] Freeze the transcript before the first request. Cover an unmarked conversation, a late correction amid long tool results, a literal search with the host index disabled, and an event appended during pause.
- [x] Reserve the complete request and output capacity before each dispatch. Test a request with no usage, budget exhaustion, and a timed-out stream using synthetic data.
- [x] Keep version 1 checkpoints readable. Verify that pending drafts, evidence and coverage use the normal approval flow.

The DSH rc.5 headless integration replay uses DeepSeek Flash with two synthetic history sessions and an empty temporary memory. It measures Dream usage independently of the outer evaluation request. The directed replay supplied the two exact source locations to check the quote-only creation path. Open-ended success rate and production cost require additional paired runs.
