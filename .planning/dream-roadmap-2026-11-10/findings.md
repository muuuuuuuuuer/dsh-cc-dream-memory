# Findings

- GitHub repository is public; default branch main. Local snapshot commit: 27e927f (0.11.1 release snapshot).
- Existing capabilities include Markdown source-of-truth memories, session-frozen index injection, lexical auto-recall/search, structured Dream plans, transcript chunking, citations, selective apply, optimistic concurrency, backup and undo.
- Prior rollout described a small diagnostic pilot with zero applied Dream operations and formatting-adherence failures. Must inspect current owning report before using these claims.
- User priority (2026-11-10): 探索 Dream / 长期记忆的新能力.
- Current GitHub main is 0.12.0 at f0a8a9f9d545614f787db0d102727e2f48401e17, newer than local 0.11.1. All roadmap judgments must use the remote snapshot. 0.12.0 already repairs merge preservation and recall/policy issues and adds model-free cost estimation.
- Current Dream prompt allows lessons from failures and Why/How-to-apply, but exposes a generic write/delete/index plan. It directs later corrections to replace active old values and discourages progress logs. Proposed episodic/temporal/procedural layers must distinguish supporting evidence history from active memory and avoid duplicating repository facts.
- Real-workspace observations: one applied batch used 149,984 reported total tokens, 263,258 ms, two memory writes and one index operation. This is one workload, not a typical cost or benefit comparison. Existing aggregate counters cannot measure acceptance rate or reasons for non-application.
- Current recall is lexical on names/descriptions, project+opt-in user scopes, max 3 files/3,000 chars by default, once per scoped file per session. No semantic retrieval demonstrated.
- Current long-session analyst emits at most 12 facts per chunk, each a self-contained sentence (max 300 chars), kind and quote; this is a concrete seam for an optional experience schema preserving situation/action/observed result/counterexample rather than another general rewrite prompt.
- Current scheduler is time/session-count gated with throttle/backoff, not utility/event-sensitive.
- Primary-source prior art: Hindsight distinguishes facts, experiences, observations and refreshed mental models; Graphiti preserves temporal validity and episode provenance; LangMem exposes functional background consolidation and prompt refinement; Letta sleep-time compute transforms raw into learned context asynchronously. These are design references, not evidence of benefit for this plugin.
- Repository already has paired A/B0/B/C eval and transcript-only Dream scenarios. Reuse these and add novel-situation transfer, negative transfer, temporal/contextual exceptions and incremental-cost cases instead of rebuilding the harness.
- ACE paper (arxiv:2510.04618v3) motivates incremental playbooks and warns about losing detailed knowledge under repeated rewriting; do not transfer its reported benchmark gains to this plugin.
- LongMemEval source provides useful ability categories (multi-session reasoning, updates, temporal reasoning, abstention), but coding-workflow transfer requires plugin-specific cases.

## Recommended sequence
1. Experience episodes: context, action, observed outcome, evidence references; distinguish observation from inferred cause. Reuse source transcripts rather than copying all history.
2. Temporal/scoped active memory: current vs superseded values, applicability, conflicts and evidence lineage. Old history stays outside normal injection; forgetting invalidates descendants.
3. Conditional lessons/procedures: synthesize across relevant episodes; record limitations and counterexamples; candidate-to-accepted lifecycle with human decisions and fresh-task checks.
4. Task-sensitive recall: sparse baseline plus optional semantic retrieval; metadata aliases and scope/time/applicability filtering; measure downstream use and negative transfer.
5. Focused mental models and incremental Dream: regenerate only affected derived views; reuse chunk analyses keyed by source+prompt+model version without moving application watermarks; value-sensitive triggers with explicit budgets.

## First experiment
Build 10 development scenario families with separate transfer and counterexample tasks, plus untouched held-out families. Compare same-tool saved-memory baseline, full Dream, and same-source summary-only control. Preserve source snapshots, repeated runs, model settings, failures, total learning+query cost, and memory deltas. Predeclare criterion as better held-out task outcomes without worse current-instruction/context errors at a stated budget; small pilot is diagnostic only.
- Initial web search found Hindsight, Mem0, Graphiti, LangMem and Claude-mem as useful GitHub prior art. Only primary sources will support technical claims; third-party comparisons and benchmark leaderboards are insufficient.
