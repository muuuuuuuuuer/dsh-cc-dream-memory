# Dream v2 and the knowledge wiki

This document describes the 0.12.0 additions: the per-session Dream pipeline,
the shared wiki page format, the knowledge-wiki corpus builder, and the
read-only wiki tools. The UI is unchanged; everything here is Host-side.

## Two stores

```
~/.dsh/cc-memory/projects/<project>/
  memory/                 # session memory, written by memory tools + Dream
    MEMORY.md             # injected index
    SKILL.md              # short usage guide
    <topic>.md            # frontmatter + body + [[links]] + provenance
  wiki/                   # corpus knowledge, written only by the host builder
    _index.md
    SKILL.md
    <page>.md
    .sources/             # normalized source text + sha256 manifest
    .builds/<run>/        # build manifest
```

`memory/` and `wiki/` are separate roots. The model can read both, but it can
only write `memory/` through the existing `memory_*` tools. No model tool writes
`wiki/`; `/memory wiki build` and `POST /api/cc-memory/wiki` are host actions.

## Dream v2

Set `dreamPipeline: v2` (the bundle default does this) or pass
`/memory dream run --pipeline v2` / `POST /dream {"pipeline":"v2"}`.

```
export transcripts
  -> analyzer per session (concurrent, small JSON)
  -> host verifier (verbatim quote, source tag, date)
  -> organizer (one call; page writes, links, conflicts, index)
  -> existing validate / backup / apply / undo
```

- A session too long is chunked inside that session only. There is no single
  call that sees every transcript.
- An analyzer failure affects that session only. `manifest.json` records
  `expected`, `processed`, `failed` and `partial`.
- A plan is applied only when the coverage is complete; partial sessions keep
  their watermark and are retried later.
- The final write gate re-checks every added/changed page line against the
  verified claims. A line needs an inline citation with both a `#seq` locator
  and a date; its source must be a transcript that produced a verified claim;
  a `user`/`feedback` line needs a claim from `[user]`, never `[user-pasted]`,
  assistant text or tool output. A line that attributes a requirement to the
  user is checked the same way even on a `project` page. Existing lines may be
  moved without fresh evidence only when the text is exactly identical and the
  source page type is the same; `1.5` cannot become `15`. Page type changes and
  changed injected name/description are checked. `STATUS:` is metadata only for
  its fixed enum; `APPLIES WHEN`/`VERIFY`/`OBSERVED`/`EXCEPTION` content still
  needs evidence. The host rebuilds `MEMORY.md` from the checked pages with
  controlled type headings; an organizer-supplied index heading is not applied.
  This check runs when the plan is made and again in both `applyPending`
  (full/review/last-plan) and `applyPlanOperations` (selective apply). A v2 plan
  with a missing evidence bundle is refused.
- The organizer returns complete pages, not a single monolithic plan. The host
  composes the plan and reuses the classic engine's atomic apply.
- Every applied batch still goes through the existing `.dreams` backup,
  `meta.json`, rollback and hash-guarded undo.

Relevant modules:

| file | role |
|---|---|
| `src/dream-analyzer.js` | analyzer prompt, JSON schema, reply normalization |
| `src/dream-verifier.js` | quote/source/date verification, unsafe-file rejection |
| `src/dream-write-evidence.js` | final-write gate: citations, verified-claim matching, `[user]`-only user/feedback lines |
| `src/dream-organizer.js` | organizer prompt, page writes/deletes/links/conflicts |
| `src/dream-pipeline.js` | export, concurrency, coverage, plan, apply |
| `src/llm-call.js` | one text completion with usage and max-tokens retry |

## Wiki pages

```md
---
name: deal-overview
description: Deal facts, figures and conflicts
domain: deal
type: reference
modified: 2026-01-16T...
---

- Revenue is $123M. ^[doc-1#p12, 2026-01-15]
- Antitrust review is pending. ^[doc-2#p3, 2026-01-16]

CONFLICT: [doc-1#p12, 2026-01-15] says revenue $123M;
[doc-3#p8, 2026-01-17] says $121M.

[[deal-risks]]
```

- `[[slug]]` links are validated by `WikiStore.audit()`.
- A clear later correction keeps the old value as dated history; otherwise both
  values stay and are marked `CONFLICT:`.
- Each fact cites `source#locator, date`. `wiki_answer` checks the cited page and
  optional quote before accepting an answer.
- The organizer builds `_index.md` and `SKILL.md`; if its index is incomplete,
  the host rebuilds the deterministic catalog.

## Recall and injection

- New sessions load the `MEMORY.md` index (200 lines / 25 KB): every note is
  listed, but a line shows its summary only when the host ledger
  (`verification.json`) matches the note's name, description and exact body.
  Old unverified notes stay listed by name and are read on demand.
- `injectHotOnly: true` (with `injectHotEntries`, default 3) switches to a tiny
  hot set instead: the most-read verified current notes. The same ledger check
  applies, so a hand-typed `STATUS: current`, `VERIFIED:` or `VERIFIED AGAINST:`
  cannot promote a note.
- The same eligibility filter applies to the compaction digest; an old note
  cannot enter it just because it was updated or read often.
- `MEMORY.md` remains the full catalog for `memory_search`/`memory_read`.
- Recall first matches name/description; if that finds nothing, it falls back to
  a body search. So body-only engineering lessons can appear on a related task
  without making every vague request recall them.
- Recall skips non-current pages and appends `APPLIES WHEN`, `VERIFY`,
  `OBSERVED` and `EXCEPTION` lines, even when the body excerpt was clipped.
- Dream organizer should write these metadata lines for engineering lessons:

```md
APPLIES WHEN: changing a route registration ^[s1#12, 2026-11-11]
VERIFY: hit the real entry point ^[s1#12, 2026-11-11]
OBSERVED: the default value looked fine but the route was not registered ^[s1#12, 2026-11-11]
EXCEPTION: a trailing slash is legal ^[s1#15, 2026-11-11]
STATUS: current
```

## Corpus builder

```
/memory wiki build <docs-dir> [--dry-run] [--focus <text>]
```

or:

```http
POST /api/cc-memory/wiki
{"sessionId":"...","action":"build","docsDir":"C:/docs","dryRun":true}
```

The builder accepts `.txt`, `.md`, `.markdown` and `.log`. PDF/DOCX/XLSX must be
converted to text first (the quickstart does the same before ingestion). It
records every source under `.sources/`, extracts claims with exact quotes,
merges them into pages, runs one organizer, writes the wiki, and records
`.builds/<run>/manifest.json` with documents/pages/links/conflicts. A build is
staged in `wiki/.staging/<run>/`; if extractor, analyzer or organizer fails, the
existing wiki pages, `_index.md` and `SKILL.md` remain byte-identical and the
command returns `ok:false` with the failed stage.

## Read-only query tools

| tool | use |
|---|---|
| `wiki_search` | lexical search over pages, returns page/snippet/citations |
| `wiki_read` | full page with `[[links]]`, citations and fact-level claims |
| `wiki_links` | outgoing links and backlinks |
| `wiki_answer` | structured answer + citations; citation may be `{page,claimId}` or a quote; the host rejects claims not on the cited page |

No wiki tool writes. Query instructions are added to the injected context when
`wiki/_index.md` exists. The query path never reads the original documents.

## Configuration

```yaml
dreamPipeline: v2            # classic | v2
injectHotOnly: false         # true = tiny hot set instead of the full index
injectHotEntries: 3
autoRecallBody: true         # body search only when metadata finds nothing
dreamAnalyzerConcurrency: 3
dreamAnalyzerMaxTokens: 8192
dreamAnalyzerMemoryChars: 48000
dreamAnalyzerTranscriptChars: 72000
dreamMaxAnalyzerCalls: 48
dreamMaxClaimsPerSession: 40
dreamMaxPatchesPerSession: 24
dreamOrganizerCurrentChars: 60000
dreamOrganizerAnalysisChars: 60000
dreamAnalyzerProvider: ''    # optional stage model
dreamAnalyzerModel: ''
dreamOrganizerProvider: ''
dreamOrganizerModel: ''
wikiEnabled: true
wikiBuildConcurrency: 2
wikiChunkChars: 20000
wikiMaxPageChars: 100000
wikiMaxPageBytes: 102400
wikiOrganizerMaxChars: 80000
wikiExtractProvider/Model: ''
wikiAnalyzeProvider/Model: ''
wikiOrganizeProvider/Model: ''
```

## Limits

- `wiki build` only accepts pre-normalized text. Binary office formats remain
  outside the plugin by design.
- Read-only is enforced by the tool surface and by the separate `wiki/` root;
  it is not an OS-level read-only mount.
- The builder has no cron. Run it manually; Dream still uses the existing
  turn/end scheduler.
- The UI is frozen. Wiki browsing and build manifests are available through the
  HTTP API and commands, not a new page.
