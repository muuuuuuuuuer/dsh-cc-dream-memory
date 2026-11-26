# Changelog — dsh-cc-dream-memory

## 0.27.0 (2026-11-26)

Highlights:

- Dream's main job is now lessons that span sessions. It sees tool calls and results, can search the project's other sessions, and decides for itself what to read.
- Dream can write wiki pages (`wiki_<topic>.md`) that sum up a topic across notes and sessions. Only Dream writes them; links and size are checked.
- One citation check for every write: the main session, auto-extract and Dream all cite quotes, and the plugin checks that each quote exists and records who said it. The claim-matching check that deferred most Dream changes is gone.
- Slash commands are trimmed to `/remember` and `/memory` with `status`, `search`, `undo`, `session`, `import`, `export` and `dream` (`run`, `status`, `estimate`, `resume`, `cancel`, `diff`, `switch`, `discard`). Browsing, editing, deleting, settings, backups and trash live in the Memory panel. The `/dream` alias, the Inbox and the other `/memory` verbs are removed; `/memory dream undo` is now `/memory undo`.
- `/memory dream discard` defers the pending copy instead of rejecting its facts for good; its sessions stay eligible for a later run.
- The Web client is built from `web/` with esbuild (`npm run build`); `npm run verify` and CI check that `client.js` matches its sources.

Details:

- A `dream_submit` with `done: true` no longer ends the run while one of its changes failed to apply (for example an edit without the note's `version`). The reply names the failed notes and the model can fix them in the same run; previously the corrected retry was refused as "already finished" and the run ended with `unfinished-writes`.
- A passage edit (Dream's `edit` op, `memory_update` with `old_text`) whose replacement still contains the old passage only adds to it, and no longer writes a `- Superseded:` line for text that is still current. Found in a real Dream run that appended to a note and marked the kept line as superseded.
- With `subagentMemory: 'own'`, Dream can merge what subagents learned in their private `agents/<preset>/memory` stores into the project notes. Notes that are new or changed since Dream last reviewed them (tracked per `agent:<preset>/<file>` by content hash in `dreamAgentNotes`) are listed in a separate prompt block, at most 12 per run. The model reads one with `dream_read_note` by that name and may cite it with `{memory_file: 'agent:<preset>/<file>', quote}`; the quote is checked against the private note's current text (History excluded). The evidence is recorded with source `agent-memory` and role `subagent`, a subagent's claim rather than the user's, so it never produces a ledger record or `STATUS: current`. A private note counts as reviewed when read completely or listed in `skipped_sessions`, and settles with the run's switch, rejection or undo the way sessions do. Private stores are never written by Dream. With any other `subagentMemory` value nothing changes.
- Dream no longer hands the model numbered per-session tasks with a paging protocol. It gets a short purpose statement, the current index and note list, a list of suspect notes, and a list of candidate sessions, and decides for itself what to read (`dream_read_session`) and what to change (`dream_submit`). The review-before-switch flow, undo and the shadow copy are unchanged.
- Suspect notes are listed from signals the plugin has: corrected since the last Dream, dismissed in recall as not relevant, broken `sources` anchors, and long unused notes. The plugin does not judge whether they are wrong. A suspect note's `source_session` is offered to the model as a lookup even when that session was already reviewed.
- `dreamMaxTasks` now caps the candidate sessions offered per run (it used to cap the number of per-session tasks). Sessions named by suspect notes take at most half of the cap (the only slot when the cap is 1 and no recent session is waiting).
- The plugin checks each citation only for existence and role: the session was offered, the event exists and is not host-injected, and the quote is in it (or in a note's current text). The review panel and `/memory dream diff` show who said it: user, pasted by the user, assistant, or tool. A change with no valid citation is returned to the model as an error in the same run, and nothing in that submission is applied.
- Removed the claim-versus-quote matching that deferred most Dream changes for confirmation. Changes with at least one valid citation now count as sourced; whether a note follows from its quote is left to the model and to the reviewer reading the diff.
- A session counts as reviewed when the model read it to its end or listed it in `skipped_sessions`; others stay pending for the next run. Each submission saves a checkpoint, so a paused run resumes from its saved draft.
- The main session, auto-extract and Dream share one write vocabulary and one provenance check. `memory_save` and `memory_update` take `citations: [{quote, seq?}]` instead of `basis`, `evidence` and `confidence`. The host checks each quote exists in a non-injected event of the calling session (`seq` optional) and records who said it, with the same function Dream uses for `dream_submit` (`src/citation.js`). A quote that does not hold is reported in `citationProblems`; the write still happens.
- `memory_update` gains `old_text`: with `content` as the replacement it changes one unique passage of the body and keeps the replaced text in History, like Dream's `edit` (`replacePassage`). Not found or ambiguous returns `OLD_TEXT_NOT_FOUND` or `OLD_TEXT_AMBIGUOUS`.
- A write that cites at least one held quote from a message the user wrote (not pasted text) gets `STATUS: current` and a ledger record; a Dream switch records the ledger for pages whose final revision cites such a quote. "Verified" in the Memory panel now means the note cites the user's own words (or the user saved it), not that its content was checked; the panel text no longer says a note stays out of the loaded set until a Dream verifies it.
- A near-duplicate or a same-topic opposite note no longer stops `memory_save` or `memory_update`; both are reported (`advisory`, `candidates`, `conflicts`, `hint`) so the model can merge. `/remember` still stops a person on those. Legacy `basis`, `evidence`, `confidence` and `force` arguments are accepted and ignored, and the two tool schemas no longer set `additionalProperties: false`.
- Removed the lexical claim-support check (`support.js`, `user-evidence.js`, `bindUserClaim`) and the `DUPLICATE` and `CONFLICT` write errors. Auto-extract passes citations like the main session and still never deletes.
- Dream's note list marks a note whose `source_session` is one of the offered sessions with `(from offered session <id>)`, so the model can connect a wrong note to the transcript it came from even when no suspect signal names it.
- A manual Dream with every session already reviewed now still runs when a suspect note's source session is offered for lookup (a note dismissed in recall, for instance); it used to finish with "nothing to change" without starting the model. That early exit also crashed with `maintenance is not iterable`.
- Dream's session view now shows the work: every tool call (name and arguments cut to 400 characters), every tool result (first and last 400 characters, so `[stderr]`, `[exit code: N]`, timeout and truncation markers survive) and every assistant message (cut to 1,500), labelled `[tool-call]`, `[tool-result]` or `[tool-error]`. Auto-extract's transcript is unchanged. A quote from a tool call's arguments can now be cited. The recorded role of a tool event is now `tool-call` or `tool-result` (it was `tool`): only a result is an observation. Calls and results of the `memory_*` tools are shown in Dream's view but can never be cited, in Dream or in the main session.
- Dream can search the project's other sessions when the host has a search backend: `dream_search_sessions({query, since?, until?})`, `dream_search_events({session_id, query})` and `dream_read_event({session_id, seq, before?, after?})`, thin wrappers over `ctx.sessionQuery`. Results are limited to the sessions Dream may use (same project including worktrees, not `learn off`, not git-ignored, not delegated, not Dream's own children) and never show host-injected events. Without a search backend the tools are not offered and the prompt says so.
- A quote from an event read with `dream_read_event` can be cited even when its session was not offered. The same existence and role check applies. Such a session is not marked reviewed; only offered sessions count towards coverage.
- The session list in Dream's prompt shows the host title (first user message when there is none), the date, the event count and how many tool results failed (an error or a non-zero `[exit code: N]`). `dreamMaxTasks` now defaults to 10 sessions per run (was 4).
- Dream's purpose is reordered: lessons that span sessions first (rule, conditions and exceptions, how it was verified, traps; tool results are observations, an assistant saying "fixed" is a claim), then keeping notes correct against what happened, then a small high-signal index. It is told to search other sessions before treating something as a one-off.
- One recording standard for the main session, auto-extract and Dream (`MEMORY_SELECTION`): record what a future session cannot recover from the repository, its history or its instruction files; when a fact lives in a repository file, record why it matters and point to it with the note's `sources` instead of copying the value. The duplicate wording in the auto-extract and main-session prompts is gone, so debugging lessons are no longer barred by a blanket "no debugging recipes" rule in the main-session prompt. `dream_submit` changes can now carry `sources`.
- Wiki pages: a layer only Dream writes. A page is a flat `wiki_<slug>.md` file with `type: wiki` that synthesizes several notes and sessions on one topic (a workflow, a module, an environment, a device type) and links related pages and notes with `[[file-name]]`. Dream creates, edits and deletes pages through the same `dream_submit` ops and citations as notes, and may delete a note that a page fully covers with `moved_to: wiki_<slug>.md`; the note and the page are one decision in the review, so the shadow copy, diff, partial switch, undo, trash and export work unchanged. Provenance is the citations recorded per change, shown in the review; inline `^[source]` tokens are not required.
- The host guards the hard boundaries of the wiki and reports them to the model: every `[[link]]` in new page text must resolve to a page or note that exists once the call is applied, and a file cannot be deleted while a page still links to it (the whole call is rejected with the list); a page holds at most `wikiPageMaxChars` (default 8000) characters and all pages together at most `wikiTotalMaxChars` (default 40000), so a wiki cannot grow past the notes it summarizes; every `dream_submit` reply and the prompt state the current usage, and the Dream review shows wiki pages and characters before → after. A wiki page needs a description (its index line).
- The main session, auto-extract and subagents can read wiki pages (`memory_read`, `memory_search`, recall) but not write them: `memory_save`, `memory_update`, rename, the panel editor and merge refuse them with `WIKI_READONLY`. To correct a page, save a note with the right fact; Dream folds it in.
- `MEMORY.md` lists wiki pages first, then notes, under the same 200-line / 25 KB budget; an over-budget index keeps wiki lines ahead of the most used notes, and notes moved into a page leave the index. The injected index text tells the model about `wiki_*` entries only when there are some. Recall treats wiki pages like any current page (the selector is told to prefer a page over the notes it links), and the body attaches within `autoRecallMaxChars`.
- Dream's purpose now says that lessons and multi-note topics live in wiki pages that are shorter than what they replace, and that a note a page fully covers is deleted with `moved_to`.
- A page's first `STATUS:` line decides whether the whole page is current, so a body written as `STATUS: superseded` that was in fact the corrected decision vanished from the index and recall. A Dream change whose resulting body would make a current page non-current (`stale`, `superseded`, `disputed`, `review-needed`, `retired`) is now rejected with an explanation unless the change sets `retire: true`; to retire a page, delete it with `moved_to` or `merges`, and an old value belongs under `## History`. `memory_save` and `memory_update` refuse the same bodies (`STATUS_HIDES_PAGE`) with no override: retire a memory with `delete`.
- The Memory panel shows wiki pages with their own badge and filter chip, lists them first, opens `[[links]]` between pages and notes, and keeps them read-only (delete still works); the Dream review shows the wiki size change. Claude Code export writes wiki pages as `type: reference` files like any other note; importing a `wiki_*.md` file brings it back as a wiki page.

## 0.26.0

- Dream screens long conversations with a compact overview and opens the source pages needed for decisions or evidence. For conversations organized around numbered task cards, the overview points to each card's first request, follow-ups, and latest reply.
- Short conversations can pass their source page directly to the next task. Batches containing only recognized greetings or sessions without dialogue can finish locally without starting a subagent.
- Dream uses source-event dates for historical observations and checks those dates against the cited event. Project progress files remain the source for test counts, commit IDs, and temporary blockers.
- The worker can add a fact or replace a specific passage in an existing note. The host checks the batch before writing and gives the worker one chance to narrow or correct unsupported changes. The review panel shows when source text was found but some claims still need confirmation.
- Dream gives unreviewed conversations priority over deferred ones. Automatic runs wait for new activity before reconsidering a deferred conversation.

## 0.25.0

- Dream uses one `standard` host subagent per run. Each task repeats the full rules, reads redacted source pages through a scoped tool and submits proposed note edits with citations. The plugin checks and checkpoints each task before passing on the next one. A paused run can resume from its saved work.
- The in-plugin model loop and its session tools (`session_search`, `session_read`, `memory_index`, `memory_search` for Dream) are removed. Without the host subagent service or a live conversation of the project to parent the children, Dream skips with `subagent-unavailable`; a paused run stays resumable. Dream now needs the host to read whole transcripts (`sessionQuery.readSession`).
- `dreamMaxTasks` (default 4) caps how many tasks the child processes in one run. At the host's activation limit Dream waits for a subagent to end and retries. A cancelled run stops waiting at once.
- `dreamYieldToSubagents` (default off): Dream starts only once no subagent the user started is running, then runs to the end even if the user starts more. Off, Dream takes a slot like any other subagent.
- Dream children cannot use the memory tools or receive memory injection, whatever `subagentMemory` says. Their token usage is read from the child session and added to the run record.
- The Dream tab shows the conversations of the current workspace: a bar and a list of which ones Dream reviewed, which wait for your switch, which went on since, which are not dreamed yet, and which are kept out with `learn off`. The status payload carries it as `dreamTasks`. Conversations of other workspaces are not listed; memory and the list follow the same project identity.
- A pending copy records which session's task changed each file. When a deferred change has no bound evidence, a partial switch now holds only those sessions and settles the rest, instead of holding every session of the run.
- The child brief asks for source sentences copied verbatim, one per line in their original language, and `<type>_<topic>.md` names. In the desktop check, the first brief produced English paraphrases that bound no quote; with this one two of three notes passed the evidence check.
- The worker uses scoped tools to read the current task's source and the shadow notes. The plugin tracks which source pages it delivered and does not export raw transcript copies.
- A child paused or interrupted from the host no longer leaves Dream waiting: 15 seconds after its turn ends without a result, the task counts as aborted and the run pauses (resumable). A cancelled run waits at most 5 seconds for the host to tear a child down.
- Dream children (and any session whose directory is inside the memory root) get no memory project: the plugin used to open one for the shadow-copy path. The memory tab in such a session says it is a Dream task session.
- Conversations started in a git-ignored folder of the project (for example `eval/runs/`) are not Dream tasks; Dream and the task list leave them out.
- A note saved with a name that already carries its type (`feedback_handover`) keeps one prefix instead of `feedback_feedback_handover.md`.
- The Dream estimate uses a rough 30k tokens per task based on earlier measurements.
- A task that submits `done:false` with drafts ends the batch: no later task is handed out, so no later task's checkpoint can carry its unchecked drafts. With finished tasks before it the run pauses (`unchecked-draft`) and resumes from the last finished task; alone, its drafts reach review as an incomplete review. A `done:false` without drafts still moves on, and its session stays unreviewed.
- `dreamAnalyzerProvider` / `dreamAnalyzerModel`, when both are set, are passed to the child as its model route; otherwise the child uses the conversation's model.

## 0.24.0

- Corrections land in the live note. The instructions and the auto-extract prompt tell the model to fix the matching passage with `memory_update` instead of writing a new note. The host records which notes a live session corrected.
- The automatic Dream runs only when the host can name what to look at: notes corrected since the last Dream, notes whose `sources` changed, notes recalled since then, and archive candidates last. Otherwise it skips with `no-focus`. Manual runs are unchanged. A successful switch clears only the corrections that run saw; later ones wait for the next Dream.
- Recall shows in the chat as one compact row ("Recalled N memories: a.md · b.md") that expands to the attached text. **Not relevant** excludes that note from automatic recall in the conversation, including after reopening it. `/memory recall dismiss <file> [--scope user]` and `POST /recall-dismiss` use the same saved dismissal. Repeated requests count as one dismissal.
- A long note can surface its best matching unseen passage even when the new question also mentions a passage already shown.
- Notes can carry `sources` (repo-relative paths, optionally `path#symbol`, at most 10) through `memory_save` / `memory_update`. The host checks them against the project root with file reads only. Recall does not attach a note whose sources are broken, `memory_read` adds a check and a note, and write receipts warn.
- `userMemory: global` (default) keeps type `user` notes in `<memoryRoot>/user/memory`, shared by every project on the machine, with its own index and its own injected block. Read, update, search and recall look in the project first, then the user layer. Dream never touches it, and `own` subagent stores have none. `userMemory: project` keeps the old layout. Existing user notes are not migrated.
- `/memory session [status | use on|off | learn on|off]`: `use off` loads no memory and recalls nothing in that conversation; `learn off` skips auto-extract and keeps it out of Dream. `autoExtractSkipExternal` (default off) skips a window with `mcp__*` or web search/fetch tool calls. The status payload carries the two switches.
- An over-budget `MEMORY.md` injects its most used entries (reads plus recalls) first; the file on disk is unchanged. `/memory status` and the status payload list notes unread and unrecalled for `archiveHintDays` (default 60) as archive candidates. Nothing is deleted automatically.
- The panel and the composer chip use `--dsw-alias-*` theme tokens only.
- Not changed: the runtime switches still live in `.plugin-state.json`. Declaring a `Config` schema with `.volatile()` fields needs the Harness schema package. This bundle imports only Node builtins, and loading that package from a local bundle has not been verified.

## 0.23.1

- Dream finds sessions from the repository root, its subdirectories and linked worktrees in either open order. A profile-wide memory directory override does not bring unrelated repositories into the transcript review.
- The composer badge follows the active conversation and requests a compact project summary. The Memory panel can reconnect without reloading DSH.
- Concurrent edits of different runtime switches now survive together on disk.
- The recall selector is told that the agent already sees the memory index and that an empty selection is the usual answer. In a live check with DeepSeek Flash, seven queries run twice, unrelated messages pulled in 2 notes instead of 11, and every target note was still selected. `eval/recall-selector.mjs` reruns it.

## 0.23.0

- Dream checks which recommendation each applicability condition belongs to. New descriptions require support from the current page or a checked source.
- Dream binds quotes that span multiple sentences and reports unsupported claims while the model can still revise the draft. Review rechecks the final bytes before applying.
- Runs that stop with unread sessions report incomplete review. Run status records application, deferral, rejection and undo. The panel identifies memory versions confirmed through manual saves.
- Recall keeps Chinese exceptions with clipped passages and preserves literal Markdown examples. The evaluation harness passes the original prompt and requires a successful switch for any Dream draft before scoring the Dream condition.

## 0.22.1

- Recall uses the latest user message for ranking and selection. Concurrent steps for that turn use one selector request. A truncated reply is discarded, and timeout or cancellation releases the turn even if the provider stalls.
- Attaching a clipped note only deduplicates the matched paragraph for that file revision. A later turn can recall another paragraph from the same note. Complete notes are still deduplicated by revision.
- Automatic recall skips candidates whose descriptions or current bodies match the credential scanner, including notes edited directly on disk.
- Dream checks the saved checkpoint before offering resume. Missing or damaged checkpoints in paused runs are reported as failed. Repeating resume while that run is active returns the existing run.

## 0.22.0

- When a selected note is too long to attach, recall delivers the matched paragraph with its heading and adjacent applicability, verification, and exception lines. Short notes keep their original order. If the matched passage and its conditions exceed the budget, the attachment points to `memory_read` for the full note.

## 0.21.0

- Automatic recall now ranks current note text alongside titles and descriptions. An error code, command, or applicability condition in an older note can reach the selector even when its description omits it. The selector receives bounded excerpts, excludes superseded text from body matches, and can only choose files in the manifest. Recall still uses one selector call per user turn.

- **Eight low-severity problems from the same review.**
  - `MEMORY.md` keeps the link when a name nearly fills a line: the old fallback cut the line at 199 characters, `](file.md)` included, so the page could not be indexed and every save appended another orphan line. Index lines are now matched by their own link target (`referencedFile`) instead of a `](file)` substring, so a description that links another page no longer takes or removes that page's line.
  - A body clipped to a budget always carries `…(use memory_read for the rest)`, and a body with no room for that pointer is left out instead of reading as the whole page.
  - A pending Dream whose copy directory is gone no longer blocks every run: `dropStaleShadowPending` clears the record before readiness is consulted (also from the auto-dream scheduler, which can now reach the repair). A conflicted run clears its copy like every other terminal path.
  - `/memory restore` refuses delegated sessions like the other write verbs and keeps the page it replaces in `.history/` before copying over it.
  - The panel matches the codes the host sends (`LOCK_BUSY`, `stale-dream`), so the locked and stale sentences appear again.
  - The never-populated `verifiedFiles`/`verifiedClaims` switch fields and the ledger loop behind them are gone; nothing could set them, and if enabled the loop would have recorded Dream output as `user-explicit`.

- **Ten problems from the 2026-11-16 review.**
  - `/memory edit` re-reads the page and sends the hash it read, so the verb can save again; `/memory export` prints the number of files it wrote; an unknown `/memory dream` verb and the removed `apply` answer with usage instead of returning nothing.
  - Duplicate detection reads the body again: `normalizeCandidate` published the text as `content` while `FIELD_WEIGHTS` scored `body`, so two notes with the same title but different facts scored 1.0 and were blocked. A read→update round trip no longer erases the `## History` section that `memory_read` deliberately hides.
  - The index keeps a superseded page out across refreshes instead of re-appending the line it just pruned, and an auto-dream that finished records its scan so the next turn does not restart it.
  - A switch stops with `conflict` when a page the dream cited as `{memory_file, quote}` was edited during review. The web editor compares one stale-write code spelling and adopts the hash a conflict reload returned, so a retry can succeed; rule secret-scan warnings are shown when the rules save.

- **`session_read` says where it looked and where the text is.** Every windowed read now starts with a line such as `[window seq 4–10: 7 events, 7 without text; next text at seq 14]`, so a window that lands inside a long run of tool calls no longer answers with `No visible text in this window.` and no way forward. Two headless runs against a 6,800-event session spent eleven turns re-reading one seq at different widths and never proposed a change; review progress only counts text events, so the range and the next seq are what the agent needs in order to move.
- **Dream can write what it learned, and can improve descriptions.** The agent's rules no longer stop at preferences, corrections, decisions and references: it may record what a session observed and the repository cannot (the symptom, what was tried, the result that followed, and the condition via `Applies when:`), and must mark a cause it only infers as unconfirmed. The conflict rule no longer falls back to the more recently modified page — a rewritten page is not evidence — and two values that hold under different conditions are kept side by side instead of averaged into one. A description rewritten over unchanged facts now passes review as its own `description` kind instead of asking for a citation a rewording cannot have. The in-session memory rules and auto-extract bans are unchanged: experience pages are a Dream output, not something a session writes mid-turn.
- **Classic-engine residue removed.** `pendingShadowDir` and `describePending` in `src/dream.js` had no callers and are gone, with the `oneLine` helper and the `shadowDirOf` import that only they used. `/status` no longer advertises `capabilities.claimMerge`, which described a claim-merge pipeline that no longer exists. `ARCHITECTURE.md`, `INTERFACES.md` and `manual.zh.md` no longer name `validateDreamPlan` or `DreamEngine.executePlan`, and the documented `DreamEngine` signature matches the code. The engine itself was already retired: `--maintenance`, `--pipeline`, `DreamEngine.run`/`estimate` and the prompt/map/organizer modules are gone. What remains in `dream.js` is the human switch/discard/undo over the shadow.
- **Fixes from a hands-on DSH web session (2026-11-16).**
  - Dream compares memory pages with each other before reading sessions, and can cite another current page (`{memory_file, quote}`) as evidence. A page that another page says is retired can now be removed and applied, also in memories-only mode. The quote must be in the cited page's current text before and after the run.
  - The review card starts changes without a checked source as rejected and disables their pass button. A refused switch shows a localized message.
  - A Dream that ran is recorded as `done` with its model, sessions and token usage. It no longer shows as "skipped". A run that hits the turn limit without a change says so (`unfinished`) instead of "nothing to change". Sessions with no text to review are settled up front instead of offered to the agent.
  - The estimate counts every turn of the tool loop, and the tool loop retries one transport failure per turn.
  - `/remember` uses the same duplicate/conflict gate as `memory_save` (`--force` overrides) and lists related notes. Note names no longer end in half a Latin word.
  - Corrections recognize `**Why:**` / `**How to apply:**` lines. `memory_read` no longer returns `raw`, which carried superseded values.
  - The verification ledger is now `.verification.json`. The old `verification.json` is read once and removed on the next write.
  - Memory type definitions follow Claude Code: answer style is `feedback`, and release/run facts are `project`. UI copy no longer says "shadow" or mentions the removed review queue.
- **Review follow-ups (2026-11-16).**
  - The "facts kept" check compares each fact together with the headings above it, so renaming `## 用户喜欢` to `## 用户讨厌` is no longer treated as a fact-preserving edit. Only bullet markers and whitespace are ignored.
  - A change without a checked source can be accepted after the reviewer opens its diff (`confirm`, or `/memory dream switch --confirm`). Without that, it is left out (`defer`) and not recorded as a rejection. The run id and page revisions still bind the decision to the reviewed bytes, and the switch record lists `confirmedWithoutSource`. New `/memory dream diff <file>`.
  - Recall orders the whole catalog by overlap with the message before the 200-entry / 12,000-character manifest cap. Recency only breaks ties, so an old relevant decision still reaches the selector.
  - A rejection records the page version and the exact lines it removed and added. The next run sees rejections of existing pages first and may re-propose only with new evidence. The review card shows what was rejected on that page before.
  - Auto-extract refuses content over 4,000 characters with `TOO_LONG` instead of cutting it. The failed write keeps the extraction cursor from advancing.

- **External review fixes.** Dream sessions derive their end from `sessionQuery.listEvents()` and complete only after an explicit `session_done` plus a read to the end; switch/undo run under the project lock and report partial state instead of success. `memory_read` returns a content hash and `memory_update` rejects a stale `expectedHash`; Dream and auto-extract share `memory-rules`; plugin-injected recall events are labeled and cannot become cited evidence; the recall manifest dedupes by file and orders by `modified`. Still open: paginated reads for truncated content and the product semantics of reject/forget.
- **Dream data-loss and concurrency hardening.** The Dream file lock is now actually acquired (`waitMs:0` previously skipped it) with strict `LOCK_BUSY`; a note created while a Dream runs is a switch conflict instead of a deletion; a manual run refuses to overwrite a pending shadow; session reads are recorded per session and completed ones stop being re-read; the extractor can no longer forward `memory_update.delete`; Dream session tools reject ids outside the candidate set. Dream now has a wall-clock timeout, uses the configured provider/model, and shares a per-project extract→Dream queue. Auto-extract persists its per-session cursor in `ProjectState.extractSeqs` and only advances it after a completed tool loop.
- **Dream is an agent.** The only Dream path is `src/dream-agent.js`: the host gives the model the `MEMORY.md` head, note metadata and candidate session ids, then the model calls `memory_index`/`memory_read`/`memory_search`, `session_search`/`session_read`, and writes only a shadow copy with `memory_write`/`memory_delete`. Page bodies and transcripts are no longer pushed up front; one run is one in-process tool loop (14 turns, 2,000 tokens each). Human `switch`/`discard`/`undo` and the shadow-conflict guard are unchanged.
- **Evidence provenance for human review.** The agent records the session id, event seq and quote for each memory write and each session search/read. Pending shadow state carries that evidence, and the Dream tab shows it beside each changed page. There is no automatic quote gate: the human sees where each claim came from and decides. `memory_write` accepts `citations` so the model can point at its source.
- **Old Dream pipeline deleted.** `src/dream-pipeline.js`, its analyzer/verifier/merge/input modules, the `dreamAgent` config toggle and the 21 pipeline tests are gone. Production has one Dream implementation; the old config key is ignored.
- **Inbox copy cleanup.** Auto-extract proposals are no longer produced, so the Inbox tab renders only a pending Dream result. The stale auto-extract proposal list and its enable/disable copy were removed; no other UI changed.
- **Dead Dream config removed.** `dreamAnalyzerConcurrency`, `dreamAnalyzerMaxTokens`, `dreamAnalyzerMemoryChars`, `dreamInputMaxChars`, `dreamMapChunkChars` and `dreamMaxToolChars` are gone; they were no longer read after the agent rewrite.

## 0.20.0 (2026-11-13)

- Automatic Dream scheduling, execution and status share the same readiness rules. Start and resume share one active run registry. A live lock owner keeps ownership during a resume, and a fresh state read protects a pending copy produced by another runtime.
- Dream model settings resolve to one analyzer provider/model pair. Older profile keys are read at configuration load. The unused `llmMaxTokens` setting is removed.
- Subagent detection and memory access decisions are shared across runtime, injection, commands, tools and Dream input. Linked Git worktrees use Git's `commondir` to share the repository memory.

- Memory uses one session snapshot of `MEMORY.md` and the memory instructions. Compaction, rule and config changes, and `/memory refresh` rebuild it. Removed `injectIndex`, `injectInstructions`, `injectionMode`, `injectHotOnly`, `injectHotEntries`, `compactionDigest`, `refreshIntervalMs`, `/memory live` and `/session-live`.
- Dream has one background launcher. `/memory dream run --wait` waits for completion. Results are staged as a copy for switching or discarding. History and undo share the same switch metadata reader, and older batch formats are skipped. Dream input uses chunks and no longer reads `sessionLookback` or `dreamMaxSessionChars`.
- The Memory page uses HTTP for all data and gets its API token from `GET /api/cc-memory/bridge`. Saving empty rules clears that layer. Memory writes with no `basis` use `inference`, and deletion moves notes to the trash.

- **Breaking cleanup: one canonical data path per feature.** Removed the lexical recall matcher, `autoRecall`/`autoRecallBody`, `autoExtractMode`, `perAgentMemory`, `injectSubagents` and `subagentWriteMode`. Old config keys are ignored; there are no compatibility aliases for them.
- **Model recall only (`recallMode:'model'|'off'`).** Each user turn builds a manifest from note names, descriptions, types and modification dates, makes one cheap selector call capped at 5 candidates, filters by recently used tools and memories already surfaced this session, and attaches up to `autoRecallMaxFiles` (default 3) selected bodies. Timeout or a failed/invalid reply attaches nothing—there is no second lexical ranker. The selector is keyed by the last typed user message, so later model steps inside the same user turn do not call it again.
- **Metadata catalog.** `MemoryStore.listEntries` now reads only frontmatter heads (`_readHead`, 8 KiB) and caches `{mtime,size,meta}`; it no longer parses every full note body per turn, status poll, recall or save. `readEntry` still reads one selected body on demand and refreshes the cached metadata.
- **Automatic extraction is on by default and runs a tool loop (`autoExtract:true`, `autoExtractEveryTurns:1`).** On the mainline `turn/end` after a turn that did not write memory, it reads only events after the stored cursor and runs an in-process 5-turn loop over `memory_read`/`memory_search`/`memory_save`/`memory_update` (`src/tool-loop.js`). Saves/updates are forced to `basis:inference`, `confidence:low`, and go through the normal `memory_save` duplicate/conflict/secret/index gates; extractor writes do not suppress the next turn's mutex. No live Agent or session is created. Inbox remains for manually staged proposals and Dream only.
- **Subagent memory is one enum (`subagentMemory:'off'|'shared'|'own'`).** `off` = no injection and no writes; `shared` = project store read/write; `own` = `agents/<preset>/memory` (optionally restricted by `agentMemoryPresets`), injected and writable only there. No snapshot merging; state and Dream remain project-level.
- Expanded `MEMORY_INSTRUCTIONS` from three lines to a 19-line compact manual: four types, save/don't-save lists, `**Why:**`/`**How to apply:**`, absolute dates, verify-before-recommending and update-not-duplicate.
- `MEMORY.md` lines longer than ~200 characters now clip the hook with an ellipsis; `reconcileIndex` drops stale/superseded lines, rewrites over-long ones, and enforces both the entry count and the 25 KB byte budget.
- Inline `## History` is capped at 20 lines / 4 KB; Dream analyzer memory per unit is capped at 12 KB; run-mode Dream input obeys `dreamInputMaxChars` instead of reading the whole corpus.
- Auto-extraction keeps a per-session event cursor and only sends events newer than the last successful extraction; an empty delta skips the model. The tool loop is capped at 5 turns, 2,000 output tokens per turn, 12,000 characters per tool result, and a 60-second total timeout. `/status` inbox items are clipped to 400 characters each so the 60-second dock poll stays small.
- New config fields: `recallMode`, `recallProvider`/`recallModel`, `recallTimeoutMs`, `recallMaxCandidates`, `autoExtract*`, `subagentMemory`, `agentMemoryPresets`, `lastExtract*` state.
- **Removed the classic Dream engine.** The v2 claim pipeline is now the only path: `DreamEngine.run`/`estimate`, `dream-prompt.js`, `dream-map.js`, `dream-organizer.js`, the `dreamPipeline` and `dreamOrganizerMode` settings, and the `--pipeline` / `--maintenance` flags are gone. Dream appends sourced fact lines, replaces a contradicted value while keeping the old one in history, merges the same fact from several sessions into one line, and may improve a page's one-line summary; it no longer rewrites whole pages, merges duplicate pages or writes `SKILL.md`.
- **Removed the knowledge wiki.** The `wiki_search`, `wiki_read`, `wiki_links` and `wiki_answer` tools, `/memory wiki build|status`, `POST /api/cc-memory/wiki`, the Wiki tab and every `wiki*` setting are gone. This plugin now does memory and Dream only. Pages already built stay on disk under `projects/<id>/wiki/`; nothing reads them any more, and you can delete the folder.
- Removed duplicate Dream action names: `apply-operations`, `background`, `run-status`, `run-cancel` and `run-resume`. Use `start`, `status`, `cancel`, `resume`, `switch` and `discard`; `/memory dream status <runId>` replaces `/memory dream run-status`.
- **Inbox and Settings now expose the modes.** The Inbox tab lists manually staged proposals (expand, accept all or discard, and the last attempt with its result), while automatic extraction writes directly and Dream results keep their existing card. Settings shows the recall mode and extract mode, adds a switch for `autoExtract`, and reads `subagentMemory` from config (no per-agent toggle). `/memory status` prints recall/extract/Inbox/subagent state. `autoExtract` can be toggled at runtime; `recallMode` and `subagentMemory` stay config values. Status and HTTP add `inbox` plus `lastExtract*` fields; `GET/POST /inbox` and `createStatusService().inbox()` mirror the existing `/memory inbox` actions.

## 0.12.0 (2026-11-09)

First public release, under a new name.

- Added recall/injection currentness: new sessions can inject a tiny hot set (`injectHotOnly`, top 3 most-read eligible notes) instead of the whole index. A note is eligible only with explicit `STATUS: current` plus `VERIFIED:`/`USER CONFIRMED:`/`CONFIRMED:` date; unmarked old notes remain searchable but are never promoted. Default recall excludes `STATUS: stale|superseded|disputed|review-needed|retired` pages, carries `APPLIES WHEN`/`VERIFY`/`OBSERVED`/`EXCEPTION` lines, and falls back to body search only when name/description matching finds nothing. The compaction digest uses the same eligibility filter.
- Added a final Dream write gate: every added/changed page line must carry a citation with a matching `#seq` locator and date to a transcript that produced a verified claim; a `user`/`feedback` line must rest on `[user]` evidence, never `[user-pasted]`, assistant text or tool output; user-attribution wording is checked on every page type. Existing-line exemptions require byte-for-byte body text and the same source page type, so `1.5` cannot become `15`. Page-type changes and changed injected name/description are part of the check. `STATUS:` is metadata only for its fixed enum; `APPLIES WHEN`/`VERIFY`/`OBSERVED`/`EXCEPTION` content still needs evidence. The host rebuilds `MEMORY.md` from checked pages with controlled headings. Full apply, review/last-plan apply and selective `apply-ops` share the same check; a v2 plan with a missing evidence bundle is refused.
- SKILL.md now participates in the same batch backup, hash validation and undo as notes and index; selective `apply-ops` never applies unselected guidance. Analyzer `contradicts` results become a deterministic current line plus dated `Superseded:` history.
- Added Dream v2 (`dreamPipeline: v2`): one analyzer per transcript with host-side quote/source verification, one organizer, coverage manifest (`expected/processed/failed/partial`), and the existing atomic apply/backup/undo. A failed analyzer or partial transcript keeps its watermark instead of poisoning the batch.
- Added the shared wiki page format (`[[slug]]`, `_index.md`, `SKILL.md`, inline `^[source#locator, date]` provenance, `CONFLICT:`/superseded history) and a memory `SKILL.md`.
- Added knowledge-wiki corpus build (`/memory wiki build <dir>`, `POST /api/cc-memory/wiki`): normalized text sources, extractors, analyzers, one organizer, build manifest. Binary office formats must be converted to text first.
- Added read-only wiki tools (`wiki_search`, `wiki_read`, `wiki_links`, `wiki_answer`); no model tool writes `wiki/`, and `wiki_answer` validates cited pages and quotes.
- New config fields: `dreamPipeline`, per-stage analyzer/organizer models, analyzer concurrency/limits, `wikiEnabled`, wiki build/page limits.
- Redesigned the Memory page (UI-FREEZE re-frozen with maintainer approval). The header says what a new conversation loads. Five tabs: Memories (type and trust filters; a reader showing loaded / verified / edited-since-verified / outdated, conditions, `CONFLICT:` callouts, earlier values, citation chips and change history), Inbox (queued writes with their reasons and proposed text, plus the Dream plan), Dream (estimate → plan → review, v2 coverage and per-change evidence; incomplete coverage disables apply), Wiki (status and audit, a page reader with working `[[links]]`, the build form) and Settings (what new conversations load). New read-only API data for it: per-entry trust facts and `injection` on `/status`, `action`/`file` and optional proposed text (`?content=1`) on `/pending-writes`, `pages`/`read` actions on `POST /wiki`, and v2 coverage fields in the Dream preview.

- Fixed Dream merge preservation: existing user/feedback facts can move across files; filtered writes cannot leave dependent deletions or index edits; partial apply protects merge destinations, and repeated mutations of one file are refused. Incomplete filtered batches retain their session watermarks.
- Previously saved incomplete plans with destructive operations are refused; reject those proposals and generate a new dry-run after upgrading.
- Dream previews now list removed body lines. Evidence is operation-level with host-resolved sources; new user facts still require typed-user evidence, while memory-sourced preference corrections require explicit review. Generated bodies must remain within the full-read limit.
- Fixed write-conflict false positives with English word boundaries and clause-level polarity; real conflicts enter the existing review queue instead of being discarded. Balanced lexical recall and enabled recall from opted-in user memory without mixing scopes.
- Added a model-free Dream input estimate in commands and the interface before paid dry-run; documented the 149,984-token real-project observation separately from the small synthetic demo. The existing unlimited default is explicit rather than presented as a spending cap.
- Added an explicit loopback Host allowlist before bridge token discovery and API actions. Evaluation now verifies the installed profile's package identity and canonical source before real model execution.
- Corrected the author and contributor metadata to list muuuuuuuuuer and Claude, with DeepSeek Harness acknowledged separately.
- Prepared public npm publishing with verification before publish, included the security notice, and made README documentation links absolute. Both npm package-name and GitHub installation commands are documented.
- **Renamed to `dsh-cc-dream-memory`.** npm's `dsh-cc-memory` is an unrelated plugin. Your memories stay in `$DSH_HOME/cc-memory/`. Remove the old package and install this one.
- **The row id is now `cc-dream-memory`.** That plugin also used `cc-memory`, and when two rows share an id the later one silently replaces the earlier one. If your profile patch overrides `id: cc-memory`, rename it.
- The interface title is now "Memory" / "记忆".
- Fixed: in a clean web profile the Memory page could not reach its API, because `webServer` starts after the plugin. The API now registers when the service comes up.
- Fixed: the memory prompt asked for absolute dates without giving today's date, so models guessed one and stored it in notes. It now states the date.
- Fixed: a name written like a file name (`deploy-process.md`) no longer produces `project_deploy_process_md.md`.
- Fixed: a Dream that only restyles a note's name (`deploy_command` for "Deploy command") keeps the original name.

## 0.11.1 (2026-11-08)

- 统一模型 save/update 的低置信和 confirm 审阅，force 只跳过重复拦截；词面冲突返回原记忆，不再创建第二条有效事实。
- 待审更新、删除、改名和直接模型更新携带原文件哈希，在存储写锁内核对，拒绝覆盖并发编辑。
- Dream 结构化引文逐新增行检查，保存本轮可核验的来源位置；旧操作级引文保持手动兼容并提示审阅。
- 自动 Dream 语义改写和未经证明的删除转待审；大幅缩减也保留为提案；未处理提案不再被下一轮覆盖。工具引文保留独立 call/result 序号。
- 保留现有 UI 冻结、纯 Markdown 存储与四工具预算；真实模型试点结果单独记录，不将回归测试当成效果证明。

## 0.11.0 (2026-11-08)

重写 Dream 的读取与证据链，补齐记忆侧的自动召回和删除。

**Dream**

- **不再抽样**：短会话整段进入；长会话切块，每块一次模型调用提取笔记（`dreamMapChunkChars`、`dreamMapMaxChunks`）。此前每个会话只抽样读 12KB，长会话的大部分内容进不了 Dream。
- **收集阶段改为纯读取**：`gatherDreamInput` 不再写 state；读到哪里记在计划的 `reads` 里，只有 apply 成功才移动水位线。dry-run、失败、未批准的 review 都不会让会话被跳过。只读了一部分的会话下轮从断点继续。
- **来源标签**：`[user]` 只代表用户手打的字；转发的长材料标 `[user-pasted]`（启发式）；宿主注入的内容和自动召回不进转写。
- **证据检查**：读过会话时，新增内容须带能在原文找到的引用，否则丢弃；`user`/`feedback` 须引用 `[user]` 行。长会话笔记的来源和日期由插件按命中位置确定，不信模型自称。过度收缩的写入：自动 Dream 丢弃，手动 Dream 警告。
- 记忆中指向已不存在路径的内容作为“可能过时”提示给模型。
- `--focus <主题>` 与 `POST /dream {focus}`：指定这一轮优先关注的内容。
- 重写 system prompt：不再沿用 Orient/Gather 四阶段结构，改用自己的措辞，并写明来源标签和证据要求。
- 修复预检成本估算（此前按输入 0 字符估算，`block` 模式形同虚设）。
- `apply-ops` 只应用部分操作，因此不再移动水位线。

**记忆**

- **自动召回**（`autoRecall`，默认开）：用户消息明显涉及某条记忆时附上它，词面匹配，不调模型，每条每会话一次。`/memory metrics` 显示次数。
- `memory_update` 支持 `delete`（软删除，confirm 模式下进待审队列）。
- `memory_read` 对超过 30 天的记忆附 `ageDays`/`staleness`。
- 注入文本增加写法指引（Why/How to apply、绝对日期、引用前核实、可用 `session_search` 查历史）。
- 预算提示和写入警告不再说模型没有删除手段。

**评测**

- 修复 v0.10.14 runner 的多处错误：`dreamInstruction`、`objective` 未定义导致运行即崩；Dream 工作目录错误；纯度检查无条件报错；开放工具场景下 C 看不到 B 的记忆；dev-09 实际没有测到 transcript；dev-06 的正则把引用的记录日期判为失败。
- 新增 `--fake-model` 与 `test/eval-run-smoke`：不花钱跑完整编排。`--plan` 走不到这些路径，所以此前的错误没被发现。
- contract 从 v13 升到 v14。

**测试与文档**

- 修复间歇性失败：临时目录清理与后台 metrics 写入竞争（ENOTEMPTY），改为带重试的清理。
- README、ARCHITECTURE、eval 文档按当前行为更新；清理文档中的本机路径。

**未验证**：尚未用真实模型跑评测，也未在真实宿主内跑过新 Dream。效果没有结论。

**升级提示**：0.10.x 生成但未应用的 `plan.json` 不要再 apply，它来自旧的抽样读取，也没有经过证据检查；重新 dry-run 一次。

## 0.10.14 (2026-11-08)

评测装置与 identity/预算修复：

- **manifest 覆盖所有场景文件**：`frozen-manifest.json` 记录 `scenarios.dev.json`、`scenarios.coding.dev.json`、`scenarios.dream-session.dev.json` 的哈希；`--plan` 也先过门禁，`--scenario-file` 不再绕过冻结校验。
- **开放工具隔离**：编码场景工作区改到系统临时目录并单独 `git init`，不再暴露插件仓库/rubric/git 历史；客观检查在 agent 跑完后执行 `node --test`，并对比测试文件哈希（agent 前捕获）。
- **记忆价值场景**：新增 dev-08（JSDoc 约定只在历史里，任务文本不提），通过 `sourceIncludes` 客观检查约定是否被应用。
- **Dream transcript 路径**：新增 `scenarios.dream-session.dev.json`，C 组 `memory_eval_dream({sessions:true})` 要求 `sessionsReviewed>0`，不再只测 `noSessions` 纯整理。
- identity：裸仓库/separate-git-dir/submodule 根含 `HEAD`+`objects` 也识别为 `git`，不再误报 workspace 共享警告；budget-notice 显示索引真实行/字节数（`totalLines/totalBytes`），不是注入采样后的数字。
- 文档：ARCH 工具数与 Dream 输入描述、README/eval 隔离说明、本机路径与未核实事故编号清理。

## 0.10.13 (2026-11-08)

复核 43e309d 的 Dream 输入回归：

- **时间线**：对话与工具证据统一按事件 order 排序；工具调用/结果成对采样（错误对优先、全 session 均匀），不再出现工具堆末尾、只留调用不留结果。assistant 文本与 tool 参数也做行首转义。
- **corpus 水位线**：corpus fallback 读到的 session 会 `ensureSession` 后 `noteSessionRead`，成功 Dream 后可被 clearSessions 标记；`dreamProcessedSessions` 的 seq 在 normalize 后保留；新增两轮 + 状态重载回归测试。
- **最近用户消息**：采样后若最近 5 条用户消息缺失，从最早一条开始拼接尾部窗口，保证摘录按时间排序且最近消息可见。
- 验收指标改为结构指标（时间排序、最近 5 条用户消息、连续两轮不重复读），弃用真人发言占比。
- 文档：ARCH 工具数 4、输入描述改为事件顺序/成对工具证据；README 去掉默认不删除与未核实事故编号、绝对路径；eval 去掉硬编码安装路径并移除版本库里的 `eval/rescores/`；dream prompt 注释不再称 mirror Claude Code。
- 真实 dry-run（2026-11-08，备份 `.state.json` 后）：`ran=true`、`applied=false`、`sessionsReviewed=8`、`ops=4`、`inputChars=63010`；状态新增 8 个 session 的 seq/complete，`lastError` 清空；未 apply。

## 0.10.12 (2026-11-08)

复核 43e309d/v0.10.10 的剩余项：

- **转义所有非用户文本**：assistant 文本与 tool-call 参数此前未转义，`\n[user] ...` 仍可伪造用户行；现在 assistant/tool-call/tool-result 统一行首转义，只有 host 生成的 `[user]` 行代表用户。
- **探针不再满足 minSessions**：新增 `pruneProbeSessions`，在 minSessions 闸门前读取并删除 probe-only session；读不出的 session 保留。5 个 `Reply with exactly` 不再唤醒自动 Dream。
- **超预算提示**：不再要求模型“重写索引”（模型无 merge/delete 工具），改为建议 memory_update、避免重复、由人类在 Memory 页（Dry run）或 /dream 处理。
- 测试：`review-v18` 覆盖 assistant/tool-call 伪造、pre-gate 探针、隔离 dry-run；`npm test` 366 条，`npm run verify` PASS。

## 0.10.11 (2026-11-08)

复核 979e67b 的回归修复：

- **字节预算**：`buildIndexHead` 在字节超限时按整行同时保留最早 head 与最新 tail，加截断标记，不再把末行切半；中文索引（约 176 字节/行）测试覆盖。
- **confirm + rename**：`normalizeRecord` 保留顶层 `name`；批准时 rename 与 content/description 合并为一次 store 操作；工具 + 待审 + 批准全流程测试。
- **worktree identity**：读取 `<gitdir>/commondir`，覆盖裸仓库、`--separate-git-dir` 与 linked worktree；不再出现同一仓库 SPLIT。
- **memory_update 原子性**：改名与正文先校验后写入；失败不留半生效状态；仅大小写改名的同一文件不再报 CONFLICT。
- **子代理**：`subagentWriteMode` 默认 `off`（看不见记忆就不写），注入默认不变。
- **文档**：ARCH 工具数 8→4、版本 0.10.11；README/ARCH 预算默认值与“写入混入推断=已加规则、未验证”状态。
- **评测装置**：新增 B0 对照组（相同工具、空记忆），报告比较改为 A→B0→B→C；新增 `eval/scenarios.coding.dev.json` 开放工具普通编码场景（测试阶段不锁工具，评分含改动文件）。
- 真实重跑未执行：当前进程没有 `DEEPSEEK_API_KEY`，`eval/run.mjs` 会直接退出；已用 `--plan`/`validate` 验证装置，等 key 后重跑。

## 0.10.10 (2026-11-08)

**外部复核 979e67b 的发布阻断项修复**

- **安全：工具输出伪造 `[user]` 行**：`dream-session-text.js` 对工具调用/结果做行首转义（`\[user]`），Dream prompt 明确 transcript 是 untrusted data，`user`/`feedback` 类型只能来自真实 `[user]` 行。
- **水位线回归**：undo 会移除该批 watermark；`apply-ops` 部分应用不再把整批 session 标记为已处理；只有完整读完（未 truncation）的 session 才推进 `dreamProcessedSessions`，并按 `id + seq` 支持增量读取。
- **工具证据**：只保留 `tool/call` 事件（assistant block 不再重复）；结果 id 从 `data.message.toolCallId`/`source.callId` 读取；保留 `isError` 结果并优先分配预算；工具预算改为全 session 均匀采样，不再只覆盖前 3.4%。
- **探针**：去掉 `/m`（一行探针不再丢弃整个长 session）；探针从 `sessionsSince` 删除，不满足 `minSessions`。
- **总预算**：`dreamInputMaxChars` 60k→96k，8 个长 session 按候选数公平分配（8×12k），不再只读前 4 个。
- **文档/发布**：README/ARCHITECTURE 去掉“复刻”；修 README 表格错位与“删除关闭”错误；修 CHANGELOG 0.10.8 关于 README 的失实说法；`private` 移除；Dream prompt 首句不再照抄社区文本。
- 子代理写入默认改为 `off`（看不见记忆就不写）；注入提醒之外，写入时也会在索引 80% 预算返回 warning。

## 0.10.9 (2026-11-08)

官方 memory 对照审计修复：

- **Worktree 共享记忆**：`resolveProjectRoot` 解析 `.git` 文件里的 `gitdir: .../.git/worktrees/<name>`，worktree 归到主仓库根；同时归一化 Windows 盘符大小写（`C:\` 与 `c:\` 不再分裂）。
- **预算对齐官方**：项目索引默认 200 行 / 25KB（原 100/8KB）；超限时注入最早 + 最新条目（不再只保留最老的行），达到 80% 预算时提前提醒模型优先 `memory_update`/合并。
- **子代理默认**：`injectSubagents` 默认改为 `false`（官方主记忆不加载进 subagent）；写入仍由 `subagentWriteMode` 控制并写入文档。
- **写入质量**：默认规则新增“区分用户原话与推断，推断/示例不得写成用户事实”；`memory_update` 支持 `name` 改名（保留 created/provenance，旧文件进回收站；confirm 待审批准后也执行改名）。
- 文档修正：worktree 共享、预算、子代理默认、rename，以及与官方的已知差异（无自动召回/fact-check/instructions/独立 subagent 目录）。

## 0.10.8 (2026-11-08)

**Dream 输入审计修复（最严重：Dream 基本没读到真实对话）**

- `extractSessionText` 现在只把 `source.kind === 'user'`（或无 source 的旧事件）当用户发言；`agent-instructions`、`runtime-context`、`skill-catalog`、`time-context` 等注入内容全部过滤，不再以 `[user]` 进入 Dream。
- 会话文本纳入 **assistant 文本 + tool call/result 证据**（每个 session 工具内容上限 `dreamMaxToolChars`，默认 4000），不再只读首尾文本；session 上限默认从 6000 提升到 **12000**。
- 新增**已处理水位线** `dreamProcessedSessions`：成功 Dream 后记录 session id；corpus fallback 不再重读已处理且未重新活跃的 session（此前 11-05 的 session 会被反复读取）。
- 过滤探针/无真人发言的 session（如 `Reply with exactly: OK`）；退化数据仍保留在 skippedSessions。
- 本次修复的验收改为结构指标：摘录按时间排序、最近 5 条用户消息都在、连续两轮不重复读已读完 session；不再用真人发言占比作为指标。
- 定位说明：package.json 改为“实验性、可审计的 auto memory/Dream，受 Claude Code 启发”；README/ARCHITECTURE 当时实际未改（0.10.9 已改）。不宣传复刻或超过官方；与原版的差距写入已知限制。

## 0.10.7 (2026-11-08)

评估运行门禁与评分校准：

- **门禁**：tool 发现失败（非零退出/EPERM/空列表）在首个模型请求前中止；frozen manifest（场景/rubric/插件版本/contract）不匹配即拒绝启动。
- **运行有效性**：snapshot hash 不符、Dream 结果缺失或 sessionsReviewed≠0 → device-invalid，不参与比较；模型失败/超时按任务失败；judge 缺失/JSON 无效 → grading-missing，进入重评。
- **纯逻辑行为测试**：新增 `eval/harness-lib.mjs` 与 `test/eval-harness.test.mjs`（发现失败、manifest 过期、快照/Dream 失效、评分缺失、成功门槛）。
- **评分表述**：旧答案重评分改名“对 v2 约束的兼容性检查”，不再据此断言违反当时指令；新增 formatViolation / providedForbiddenContent 区分“提到禁词”与“实际提供操作”，格式违规单独记录。
- 更新 frozen manifest（contract v13、0.10.7 与资产哈希）和 PILOT-REPORT 说明。

## 0.10.6 (2026-11-08)

评估装置修复（首轮试点的结论作废，仅保留为装置诊断）：

- **工具隔离**：eval 每个会话禁用全部模型侧基础工具（保留 memory 工具与 executor），修复 A 组读取 evaluator 数据的污染；headless 探针验证只剩 4 个 memory 工具。
- **B/C 快照分离**：`checkpoint-before-dream` / `checkpoint-after-dream`，测试前按组恢复并校验 sha256，修复 C 的 Dream 结果被 B 快照覆盖。
- **纯整理 Dream**：`noSessions` 贯通 dream-input/dream/runtime/eval 工具，评估时 `sessionsReviewed` 必须为 0；非 0 记错误。
- **评分冻结**：dev-01 变体 rubric v2（任务与评分一致），旧 v1 保留；`eval/rescore.mjs` 对旧回答匿名重评，旧评分不覆盖。
- **无模型断言**：`eval/assert-harness.mjs` 27 项；`eval/freeze.mjs` + `eval/frozen-manifest.json` 冻结场景/rubric/版本。
- 更新 `eval/PILOT-REPORT.md`（污染、C 恢复、rubric 歧义、口径修正；效果结论待重跑）与 `eval/README.md`。

## 0.10.5 (2026-11-08)

- **评估工具链（eval/）**：A/B/C 配对实验的 6 个开发场景、rubric、检查点协议、headless runner；`node eval/run.mjs`（真实模型）与 `node eval/validate.mjs`（无模型 dry-run）。
- **eval-only 管理工具**：config `evalMode`（默认 false）为 true 时注册 `memory_eval_dream`，让 headless 评估可以在 C 组触发一次真实 Dream；正常 profile 不出现该工具，4 个模型工具不变。
- 首轮开发试点结果与校准记录见 `eval/PILOT-REPORT.md`（n=1，仅诊断；未作为正式收益结论）。
- 修复 runner 的按组隔离 memoryRoot、A 组不重复历史、测试产物纳入评分、judge 注入已知历史与材料、eval 工具返回 lossless 摘要。

## 0.10.4 (2026-11-08)

**关键修复：Memory Web UI 一直显示「页面在记忆插件加载前打开」只读横幅、Dream 按钮不可用。**

- 根因：Host `webserver` 的 prefix 路由匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`；插件注册的路由多了一个尾部斜杠（`/api/cc-memory/`），导致真实 Host 上 **所有** `/api/cc-memory/*` 请求都不匹配、静默 404。此前的测试直接调用 handler，因此没有覆盖到真实路由匹配。
- 修复：注册路径改为 `/api/cc-memory`（无尾部斜杠）；新增回归测试同时验证「prefix 必须能匹配 /status、/bridge」。
- UI-FREEZE（用户批准范围：修复 Dream 不可用）：client.js 的 bridge 恢复逻辑由同步 XHR 改为 **异步 fetch**（`apply` 变为 async，DSH 客户端 loader 会 await），页面在全局 `__CC_MEMORY_API__` 缺失时从 `GET /api/cc-memory/bridge` 取回 base/token；可见 UI 文案/布局未变（Dream 命名保持不变），已重新冻结 UI 哈希。
- 新增 client 测试：缺少注入 global 时成功从 /bridge 恢复 API 模式；测试 342 条。

## 0.10.3 (2026-11-07)

UI-FREEZE: 用户明确要求把功能从「整理 / Tidy」更名为 **Dream**（Claude Code 的 dreaming 语义），并修复 Dream 入口不可用。

- **UI 更名（已重新冻结）**：Memory 页第二 tab 与全部可见文案从 Tidy/整理 改为 Dream；`client.js`/locale 哈希已更新（UI-FREEZE 批准来源：用户 2026-11-07 消息）。
- **Dream 入口修复**：新增 `GET /api/cc-memory/bridge`（loopback + DSH auth 门禁，返回与 index 注入相同的 base/token）；client 在 `__CC_MEMORY_API__` 缺失时同步 XHR 恢复 API 模式，页面早于插件加载/桌面缓存注入缺失不再降级为只读。
- **新增 `/dream` 短命令**：`/dream run [--dry-run]`、`/dream status`、`/dream apply`、`/dream history`、`/dream undo`（等价 `/memory dream …`），即使 UI 降级也能触达。
- README/ARCHITECTURE 同步 Dream 命名与 `/dream`、/bridge 说明；测试 340 条。

## 0.10.2 (2026-11-07)

**UI 设计冻结**（用户明确指令）：

- 冻结范围：`client.js`、`locale/en.json`、`locale/zh.json`、`icon.svg`。
- 新增 `.ui-freeze.json`（规范化 sha256）+ `scripts/ui-freeze.mjs`（verify/re-freeze）+ `test/ui-freeze.test.mjs`（每次全量测试校验）。
- 未获用户明确批准并运行 `node scripts/ui-freeze.mjs --update` 前，任何 UI 改动都会让测试失败；commit 需以 `UI-FREEZE:` 说明批准来源。
- 新增 `npm run ui:verify` / `npm run ui:freeze` 与 [UI-FREEZE.md](UI-FREEZE.md)。

## Client v4 UI (between 0.10.1 and 0.10.2)

Memory 页重做（client v4 UI）：

- **三个标签代替 8 张堆叠卡片**：「记忆」（搜索 + 类型筛选 + 列表/详情，可新建、编辑、删除，待确认写入置顶）、「整理」（生成方案 → 逐条查看改动 → 应用所选 → 撤销）、「设置」（全局开关、记忆规则、回收站/备份恢复、存储位置）。
- 统一的动作反馈：toast、两段确认、一次只跑一个动作；窄屏单列；亮/暗主题跟随宿主；输入框下的状态 chip 自带样式并显示待处理数。
- 页面上移除：效果趋势、健康分、合并、文件历史、导入/导出、changelog 尾部（命令与 HTTP API 仍保留）；client 删除对应未使用的请求方法。
- `GET /dream-history` 的条目新增 `undone`，已撤销的批次 `undoable:false`（之前会被当成可撤销）。
- client 测试改为覆盖新 UI 的纯函数与 locale 键完整性；测试 333 条全绿，verify PASS。

## 0.10.1 (2026-11-07)

外部 review 修复（v12）：

- **Bug 1 运行时开关不生效**：DreamEngine/MemoryStore 接受 live config provider，切换 on/off、user on/off 后已存在的 engine/store 立即生效，不再需要重载插件。
- **Bug 2 confirm 可绕过**：writeMode:'confirm' 下 memory_save（含 force:true）与 memory_update 都进待审队列；approve update 保留 created/provenance。
- **Bug 3 回滚丢并发写**：dream 失败回滚改为 touched-only + 应用后哈希校验，未触碰文件/被并发修改的文件不动；返回 conflicts，回滚前快照到 .dreams/<ts>-rollback/。
- **Bug 4 lastPlan 指针被误清**：applyLastPlan 仅在 applied:true 时清计划；applyPending 统一返回 {applied:boolean}（锁冲突 {applied:false,error:'dream-locked'}）。
- **Bug 5 bySession 泄漏**：agent/disposed 时 runtime.forgetSession 清理；LRU 上限 500。
- **覆写历史**：模型 update/save 覆盖与 dream 写入前保留旧版本到 .history/<file>/（keepHistory:true，historyMaxPerFile:20）。
- **user scope 可写**：memory_save/update 支持 scope:'project'|'user'。
- **注入提示修正**：不再让模型执行 /memory dream run、不再要求 merge/delete stale、不暴露绝对记忆路径。
- **其它**：memory_read 指标 best-effort；重复检查只读 ≤12 个候选 body；锁 stale 回收检查 pid 存活；dream 会话摘录改为头/中/尾三段抽样。
- 测试 332 条；10 连全绿 + verify PASS；文档按当前行为重写（历史移入本文件）。

## 0.10.0 (2026-11-08)

v11 用户六步（第 1–5 步）：

- **撤销 dream 数据安全**：meta 记录被触碰文件 sha256（apply 后）、created/rewritten/deleted/operations；undo 只处理这些文件，当前哈希不一致则整体拒绝（conflicts）；undo 前整体备份；索引由 reconcile 修正不覆盖 MEMORY.md；旧批次无 hashes → legacy-batch 只读。
- **模型侧写入**：注入新增 When-to-save；强制规则（不存密钥/记忆不覆盖指令）不可被用户规则删除，用户规则追加在内置规则之后；写入策略放宽（短正文直接写、冲突/疑似重复改 advisory、只有高度重复拦截、低置信仅 confidence:'low'/confirm）；机密扫描分级 deny/warn（sk-proj/sk-ant/github_pat_/gho_/AIza/JWT/连接串/中文密码 → deny）。
- **dream 真正整理**：prompt 改为保留仍然成立的事实、被取代状态直接替换；禁止版本号/测试数/提交哈希/行数/流水账/一次性事务；dreamAllowDelete 默认 true。
- **桌面 API**：移除 tapIndex/.api-tap.log，改用 webserver/index-inject 结构化 row（kind:'global'），仅 owner peer 注入 token（peer 缺失 fail-closed）；桌面 Electron 会应用 global row，相对 base 经 dsh-app:// 转发并带认证 cookie。
- **client**：降级 banner 文案准确化（不再承诺刷新必好）、命令模式待审写入入口。
- 模型侧工具精简到 4 个（save/update/read/search，描述+Schema ≤3000 字符）、recall 排序并入 search（本次后续提交）。
- 测试 313 条（第 1–5 步全部覆盖）；10 连绿 + verify PASS（以最终输出为准）。

## 0.9.0 (2026-11-07)

v10 P1 修复（恢复语义 / 编辑审计 / 检索 / 指标价值 / CC 互通 / 子会话 / 事务锁 / compaction 摘要）：

- **恢复语义**：每次 apply/apply-ops 写 `.dreams/<ts>/meta.json`；新增 `runtime.undoLastDream` / `DreamEngine.undoLastDream`（恢复备份、新增文件移 trash、索引 reconcile、changelog）；`GET /dream-history`、`/memory dream history|undo`；UI Dream 历史时间线（legacy 批次只读）。
- **编辑/合并/审计**：status/HTTP/命令新增 `writeFile`（POST /file）、`mergeFiles`（POST /merge）、`fileHistory`（GET /file-history）；UI Edit 表单、文件多选 Merge、History 折叠（provenance/changelog/planRefs）。
- **检索**：store.search 升级（name/desc/body 权重、phrase bonus、recency、type 过滤、offset、score/snippets）；新工具 `memory_recall`；`GET /search`、`/memory search`；UI 搜索框。
- **指标价值**：metrics 增 daily 桶（60 天）/adoptions/recordAdoption/dreams.quality；`GET /metrics?days=7` 返回 summary+trend+quality；效果卡 7 日趋势 + dream quality。
- **Claude Code 互通**：新增 `src/import-export.js`（importClaudeMemory/exportClaudeMemory）；`POST /import|/export`、`/memory import|export`；UI Import/Export。
- **子会话归属**：config `subagentWriteMode:'shared'|'off'`；off 时 subagent 写工具返回 `subagent-readonly`；status.subagentPolicy。
- **事务一致性**：新增 `src/lock.js` `withFileLock` + paths.writeLockFile；store mutating 方法持跨进程写锁。
- **compaction 记忆摘要**：compaction 刷新时注入 `<memory-digest>`（最近修改 top5 + 最多读取 top3，≤400 字符），config `compactionDigest:true`。
- locale 288 键/语言；测试 282 条；verify PASS（60 JS / 30 test files）。

## 0.8.0 (2026-11-07)

v9 P0 语义层修复（5 个“信任”缺口）：

- **写入策略层**：新增 `src/policy.js`（CJK/latin 相似度、同主题极性冲突检测、低置信判定）与 `src/pending-writes.js`（待审写入队列）。`memory_save` 新增 `force`/`confidence`，返回 duplicate/possible-duplicate/conflict/queued-review/allow；`memory_update` 跨文件检查；新增 `memory_refresh` 工具；`/memory writes|approve|reject`；HTTP `GET/POST /pending-writes`；`/status.pendingWrites`。
- **项目身份/多记忆空间**：新增 `src/identity.js`（config.projectId > workspace 标记 `.cc-memory.json`/`.dsh-memory-project` > git root > workspace）；`paths.buildPaths` 支持显式 projectId sanitize；user scope 独立预算（`userIndexMaxLines:30`/`userIndexMaxBytes:4096`）；`/memory user on|off` + UI 开关。
- **会话即时刷新**：`runtime.setSessionMode/sessionMode/refreshSession`；`injectionMode` 会话级 live 优先；`manual` 原因强制重建冻结快照；`POST /session-live`；`/memory refresh|live on|off` + UI pill。
- **dream 触发/可见/阻塞**：新增 `src/readiness.js`（`dreamReadiness` 闸门与 nextEligibleAt、`memoryHealth` 0-100 分 + suggestions、`expireStaleProposal` TTL）；pending 提案 72h 超时自动归档，不再永久阻塞；`/status.readiness`/`healthScore`；UI 显示就绪/阻塞原因/健康度。
- **预算与成本联动**：索引超预算注入提示「去整理」；健康度建议 over-budget/many-never-read/dream-overdue/pending-stale/non-git-sharing/rules-truncated；新增 `dreamCostMode:'warn'|'review'|'block'`（预检 block 不调 LLM；review 不应用转提案；block 不写记忆）与 `dreamMaxTotalTokens` 联动。
- config 新增 `writeMode/policy thresholds/pendingProposalTtlHours/dreamCostMode/projectId/userIndex*`；UI 新增待审写入卡、Dream 就绪/成本、健康度徽标+suggestions、User memory 开关、Session live pill；locale 207 键/语言。

## 0.7.0 (2026-11-07)

v8：效果指标 + 成本展示。

- **效果指标**：新增 `src/metrics.js`（`<projectDir>/.metrics.json`，跨进程锁 + 写前重读合并 + 原子写）；记录注入次数、每条记忆的读/写、search 次数/命中、dream proposed/applied/rejected/failed/appliedOps、最近成本；派生 Top read、neverRead、dream 接受率。
- **埋点**：注入构建、`memory_read/save/update/search`、`/memory show`、`/remember`、dream 生命周期。
- **暴露**：`/status.metrics`、`GET /metrics`、`memory_status.metrics`、`/memory metrics`、`/memory json.metrics`；Web 新增「效果」卡（6 格 + top/neverRead + 无数据提示）。
- **成本**：plan/changelog/state/metrics 记录 `durationMs/inputChars/outputChars/usage`；Dream 卡与计划预览展示耗时/tokens；新增 `dreamMaxTotalTokens`（默认 0=off）软上限，超限 `costExceeded` + warning 仍应用并显示徽标。
- **状态**：`lastDreamCostExceeded/lastDreamUsage` 进入 status；client `normalizeMetrics`；locale 157 键/语言（+24）。
- **测试**：新增 `test/metrics-v8.test.mjs` 9、`test/dream-v8.test.mjs` 6，client 测试更新；全量总数见 verify 输出。

## 0.6.0 (2026-11-07)

v7 backlog：可靠性收口后的能力补齐。

- **共用状态服务** `src/status.js`：`createStatusService(runtime)` 成为 HTTP 与 commands 的唯一状态来源（status/file/rules/toggle/delete/dream/backups/trash/restore），消除两套并行组装。
- **Dream diff 与按条应用**：`runtime.previewPlan()` 返回逐条 before/after/changed；`runtime.applyPlanOperations({indexes})` 只应用选中操作（备份+回滚+reconcile+changelog）；HTTP `POST /dream {action:'preview'|'apply-ops'}`；命令 `/memory dream preview|apply-ops`；UI 勾选 + 两段确认。
- **备份/回收站恢复**：`GET /backups`、`GET /trash`、`POST /restore`（整批或单文件，写 changelog + reconcile）；命令 `/memory backups|trash|restore`；UI「备份与回收站」卡。
- **Provenance**：frontmatter 新增可选 `created`/`source_session`/`via`；tools/commands/dream 写入自动标注，update 保留 created；`/status.entries`、`/memory list`、UI 文件行展示。
- **机密扫描**：`src/secrets.js`（8 类规则 + 高熵 base64），配置 `secretScan: warn|deny|off`（默认 warn）；写入/dream/rules 前扫描，deny 拒绝落盘、warn 带 warnings，excerpt 只留 12 字符。
- **锁与成本**：人工 apply/apply-ops 现在持 `.consolidate-lock`（冲突 `dream-locked`）；plan/changelog/state 记录 `durationMs`/`inputChars`/`outputChars`/`usage`。
- **客户端**：provenance 徽标、Dream 计划 diff 预览+按条应用、备份/回收站恢复卡；测试钩子 `window.__CC_MEMORY_INTERNALS__`；locale 133 键/语言。
- **仓库/交付**：git 仓库、MIT LICENSE、GitHub Actions CI（Windows/Ubuntu × Node 22/24）、`npm pack` 校验、client 自动化测试入库。

## 0.5.0 (2026-11-07)

可靠性修复轮（按 review 反馈，未加新功能）：

- **可等待卸载**：新增 `createMemoryPlugin()`，`dispose()` 会 `runtime.drain()` 等待后台写入；修复 `hardening-v5` 测试的 ENOTEMPTY 竞态，测试套件 155 条、连续 10 次全量运行全绿。
- **静默 API 安全与稳定**：仅接受 loopback 来源；POST 校验 Origin；token 持久化 `~/.dsh/cc-memory/.api-token`（插件重载不再失效）；rules 写入追加 `.memory-rules.log` 审计（scope/source/bytes/sha256）。
- **客户端降级可诊断**：API bridge 缺失/401 时显示明确 banner（区分「页面早于插件加载」与「token 轮换」）并提供「刷新页面」按钮，不再静默退回命令模式。
- **不再错放记忆**：`workingDirectory.ensure` 返回空时该会话禁用记忆功能（不再回退 `process.cwd()`）。
- **跨进程状态合并**：`.state.json` 每次写前在 `<state>.lock` 下重读磁盘并合并（多 Host 进程交错写不丢 sessions/counters）。
- **中文检索**：`store.search` 增加 CJK bigram 分词，无空格中文查询可命中。
- **UI 决策**：保留紧凑单页布局；记忆正文默认 Markdown 渲染并可切原文；运行时开关标注「全局」。
- **tap 诊断**：`~/.dsh/cc-memory/.api-tap.log` 记录 index 注入次数，用于排查“页面仍降级”是页面/时序问题还是 Host 未走 tap。
- **文档纠偏**：locale 实际 97 UI 键（JSON 99 = 97 + 2 meta）；README Web 视图描述与实际实现对齐；已知限制补齐多进程状态覆盖/来源字段/机密扫描/客户端测试/指标等未完成项。

语义化版本。数据默认在 `~/.dsh/cc-memory`，与插件版本解耦；升级/回滚插件不会删除记忆数据。

## 0.4.0 (2026-11-07)

- **会话级冻结注入（默认）**：会话开始注入一次索引后冻结，compaction 时刷新；`memory_save`/dream/其他会话写入不再改动本会话注入。新增 `injectionMode: 'session' | 'live'`。
- **预算收紧**：`indexMaxLines` 100、`indexMaxBytes` 8192（原 200/25600）。
- **子会话开关**：`injectSubagents`（默认 true）；false 时 `parentSession`/`origin:'subagent'` 会话不注入。
- **注入无效化来源**：`runtime.invalidateInjection(sessionId, reason)`（memory-write/config/rules）；冻结模式只响应 config/rules + compaction。
- 注入文本使用可编辑的 `memory-rules.md`（project > global > 内置默认）。

## 0.3.0 (2026-11-07)

- **静默 HTTP API**：`/api/cc-memory/*`（token 注入页面 index），Memory 视图/状态 chip 不再走斜杠命令，轨迹不再新增 `memory · …` 行；无 webServer 时降级命令模式。
- **运行时开关**：`~/.dsh/cc-memory/.plugin-state.json` 覆盖（enabled / autoMemoryEnabled / autoDreamEnabled），`/memory plugin on|off` 与 UI 开关即时生效、可逆。
- **可编辑 rules** + **Memory 视图重做** + composer dock 状态 chip。

## 0.2.0 (2026-11-07)

- 外部 review 修复：截断文件禁写、unicode 文件名/冲突后缀、subagent 会话过滤与 prompt 权威规则、按 projectRoot 缓存、软删除 `.trash/`、索引 reconcile、dry-run 计划复用、apply 失败回滚、`/memory plugin` 语义、review reject、失败退避。

## 0.1.0 (2026-11-07)

- 首个版本：auto memory 索引注入、8 个 `memory_*` 工具、`/memory` 与 `/remember`、确定性 dream 引擎（闸门/四阶段/备份/changelog）、Memory Web 视图、locale/icon。
