<div align="center">

# dsh-cc-dream-memory

**Claude Code-style auto memory and Dream for DeepSeek Harness.**

Your agent remembers across sessions. Every change Dream proposes is one you can review and undo.

[![npm](https://img.shields.io/npm/v/dsh-cc-dream-memory)](https://www.npmjs.com/package/dsh-cc-dream-memory)
[![CI](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

English · [简体中文](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/README.zh.md)

</div>

## Test results

### LongMemEval-S, 30 questions

Each question comes with about 50 earlier chat sessions. Three lines answered the same questions with the same model (`deepseek-flash`), each in a fresh headless DeepSeek Harness session with no shell, file, web or subagent tools:

- **A**: plugin disabled.
- **B**: the plugin's auto-extract reads the history session by session and writes notes.
- **C**: B's notes, then Dream runs over the same history.

| Group | n | A no plugin | B memory | C memory + Dream |
|---|---:|---:|---:|---:|
| **All** | 30 | 8/30 (27%) | **26/30 (87%)** | 25/30 (83%) |
| Knowledge update | 10 | 0/10 | **10/10** | 9/10 |
| Multi-session | 10 | 0/10 | **9/10** | **9/10** |
| Abstention | 10 | **8/10** | 7/10 | 7/10 |

What this shows:

- **Memory is the gain.** Without the plugin the agent cannot see earlier sessions, so it answered none of the 20 knowledge-update and multi-session questions. With memory it answered 19.
- **Dream did not add accuracy here.** C fixed one question and broke two. The evidence check deferred 1,001 of the 1,137 changes Dream proposed (88%).
- **Abstention is slightly worse with memory.** The plugin-less agent correctly says "I don't know" more often, because it has nothing to misread.

Limits: this is a fixed diagnostic sample of 30 questions (10 per group), not the full 500. The judge is DeepSeek with the official LongMemEval answer-check prompts, not the official GPT-4o judge. The run used the 0.25.0 code. 0.26.0 changed how Dream selects and edits notes, and these 30 questions have not been rerun since. [Setup and sample](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/longmemeval/README.md) · [Where Dream spent its time](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/longmemeval/DREAM-SELECTION.zh.md) (Chinese)

### Recall, synthetic cases

Six synthetic recall cases, each run twice per version with DeepSeek Flash through the plugin's recall hook:

| Version | Expected note attached | Answer correct |
|---|---:|---:|
| 0.21.0 | 2/12 | 6/12 |
| 0.22.1 | 12/12 | 12/12 |

In a 0.23.1 check of seven queries run twice, unrelated messages pulled in 2 notes instead of 11, and every target note was still selected. [Paired evaluation](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/RECALL-0.22.0.md) (Chinese) · [Replay script](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/recall-passages.mjs)

### Test suite

`npm run verify` passes 702 assertions across 80 test files. CI runs on Windows and Ubuntu with Node 22 and 24.

## Install

Requires Node 22 or newer and DeepSeek Harness 0.2.2-rc.1 or newer.

npm still has 0.12.0, so install the current release from GitHub:

```bash
dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.26.0
```

If `dsh` is not on your PATH, use `npx`:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.26.0
```

Restart DeepSeek Harness and start a new session.

## Try it

Run these in a session.

1. Tell your agent something worth keeping, or save it yourself:

   ```text
   /remember --type=project Release notes live in docs/releases.md
   ```

2. Start a new session. The agent sees the start of `MEMORY.md`, recall attaches notes that match the current message, and the agent can read other notes on demand.

3. After a few sessions, start a background Dream and check on it:

   ```text
   /memory dream run
   /memory dream status <runId>
   ```

4. Review the result on the **Dream** tab, then switch to it. Undo the switch if you change your mind:

   ```text
   /memory dream switch
   /memory dream undo
   ```

See the [command reference](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md) for everything else.

## How it works

**Memory.** Notes are plain Markdown in a Claude Code-compatible layout: a `MEMORY.md` index plus one file per topic, with type `user`, `feedback`, `project` or `reference`. You can open and edit every file yourself. A **Memory** tab sits next to Chat, and it follows the host's light and dark themes in English or Chinese.

**Auto-extract.** On by default. Every 3 turns it reads only the new part of the conversation and saves what is worth keeping through the same tool the agent uses. Corrections edit the matching passage of the existing note instead of adding a new one. Duplicate, conflict and secret checks apply to every write.

**Recall.** Titles, descriptions and note text rank candidates. One model call per turn picks the relevant ones, and up to 3 are attached by default. For a long note, the matching paragraph is attached with its heading and conditions. The chat shows which notes were attached, with a **Not relevant** button for each.

**Dream.** Dream consolidates notes from past sessions. It runs as a host subagent, reads the sessions it has not reviewed, and writes its changes into a separate copy. Every new fact must quote the session it came from, and changes without a checked quote are deferred. Nothing reaches your notes until you switch, switching backs up the current notes first, and undo restores them. Automatic Dreams are off by default. When turned on, they run only when there is something specific to look at: notes you corrected, notes whose source files changed, recalled notes, then archive candidates.

## Coming from Claude Code

```text
/memory import ~/.claude/projects/<your-project>
```

The import reads `MEMORY.md` and the topic files and keeps their `name`, `description` and `type`. It skips files that already exist, and secret scanning still applies. `/memory export <path>` writes the same layout back.

What is different here:

| | This plugin |
|---|---|
| Consolidation | A copy you review, then switch to or discard, with backups and undo |
| New facts from Dream | Must quote the transcript |
| Recall | One model call per turn selects notes. The chat shows what was attached |
| Sources | A note can list the repository files it depends on. Recall skips a note whose sources are gone |
| User memory | Type `user` notes are shared by every project on this machine; everything else stays per project |
| Per conversation | `/memory session use off` loads nothing; `/memory session learn off` keeps the conversation out of auto-extract and Dream |
| Subagents | No memory by default (`subagentMemory: off`); `shared` or `own` per-agent directories are available |

## Is it right for you?

It suits you if you want to read and correct what your agent remembers, and you work on the same projects for a long time.

Look elsewhere if you need:

- **Vector search or a hosted memory service.** This plugin uses local Markdown and lexical ranking, so a question phrased very differently from the note can miss. `@openviking/dsh-memory-plugin`, `@honcho-ai/dsh-honcho` and `dsh-tdai-memory` take other approaches.
- **Approval for every write.** Auto-extract writes directly, like an ordinary save. Only Dream results wait for your review.

## Your data and cost

- Memories stay on your machine, under `$DSH_HOME/cc-memory/`. The plugin has no telemetry.
- The recall model receives candidate descriptions and short excerpts. Selected notes go to your model provider as context.
- Dream sends session text and notes to the provider you configured, and it is not cheap. In the LongMemEval run, building memory and running Dream over about 50 sessions took around 6.8 million input tokens per question, 93% of them cache reads. `/memory dream estimate` gives a rough figure before you run, and `/memory dream cancel <runId>` stops a run.
- Writes that match common key formats are refused. This is a heuristic and will not catch every secret. See [SECURITY.md](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md).

## Status

**Experimental.** DeepSeek Harness is itself a preview, and its plugin API can change.

- The LongMemEval numbers above come from a 30-question sample, and Dream has not yet shown an accuracy gain there.
- 0.26.0's Dream changes were checked on replays and targeted cases, not on a rerun of the full sample.
- We need reports from long use on real projects. If you try it, please [tell us what it got right and wrong](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/issues/new?template=feedback.yml).

Known limits:

- A quote proves the words exist in the session. It does not prove the conclusion drawn from them is right, so review Dream's result before switching.
- Telling your typing apart from pasted text is a heuristic, and short pastes get through.

## More

- [Command reference](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md) · [Changelog](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CHANGELOG.md)
- [Manual](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md) and [architecture](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/ARCHITECTURE.md) (Chinese)
- [How the evaluation works](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/README.md) (Chinese)
- [Contributing](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CONTRIBUTING.md) · [Security](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md)

## Contributors

- [muuuuuuuuuer](https://github.com/muuuuuuuuuer) — maintainer.
- [Claude](https://github.com/claude) — AI coding assistance through Claude Code.

## Acknowledgements

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) was also used during development.

## License

[MIT](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

This is an independent community plugin, not affiliated with or endorsed by Anthropic or DeepSeek. Claude Code is a product of Anthropic.
