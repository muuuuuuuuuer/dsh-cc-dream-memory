<div align="center">

<img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/icon.png" width="88" alt="">

# dsh-cc-dream-memory

**Claude Code-style auto memory and Dream for DeepSeek Harness.**

Your agent remembers across sessions. Every change Dream proposes is one you can review and undo.

[![npm](https://img.shields.io/npm/v/dsh-cc-dream-memory)](https://www.npmjs.com/package/dsh-cc-dream-memory)
[![CI](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

English · [简体中文](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/README.zh.md)

</div>

## Before and after

Tell your agent something once, then ask in a new session. Same project, same model, same question. The only difference is the plugin.

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/before-after.png" width="860" alt="Two answers to the same request. Without the plugin, the answer uses section headings and tells you to run the retired legacy-deploy.sh. With the plugin, it opens with the conclusion and risks and tells you to run make release.">
</p>

Without the plugin, the agent replied "Both noted" and promised not to recommend the old script, then recommended it in the next session. With the plugin, it saved two notes on its own and used them.

We ran the second session three times on each side. The deploy step was `legacy-deploy.sh` in all three runs without the plugin, and `make release` in all three with it. The picture shows the first run of each. The project is made up, and its README still names the old script on purpose. This is one example, not a benchmark. See [Status](#status).

## Install

**GitHub v0.20.0:** Install from the GitHub tag using the command below. The npm instructions install the version available on npm.

Requires Node 22 or newer and DeepSeek Harness 0.2.2-rc.1 or newer.

```bash
dsh plugin --profile web add dsh-cc-dream-memory
```

Restart DeepSeek Harness and start a new session. If `dsh` is not on your PATH, use `npx`:

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-cc-dream-memory
```

In the desktop app, open **Plugins → Add plugin** and enter `dsh-cc-dream-memory`.

You can also install directly from GitHub:

```bash
dsh plugin --profile web add github:muuuuuuuuuer/dsh-cc-dream-memory#v0.20.0
```

## Dream

Notes go stale. Here, three sessions changed the facts while five older notes stayed as they were. A Dream read those sessions and proposed six changes, and all six were applied.

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/dream-before-after.png" width="860" alt="The Memories tab before and after a Dream. Before: five notes, with two duplicates and stale deploy and freeze facts. After: four notes, with the duplicates merged, the facts corrected and the handoff format added.">
</p>

The screenshots show an earlier Dream interface. The current Dream stages one copy. Review its changes, then switch to that copy or discard it. One command undoes the switch.

## The interface

A **Memory** tab sits next to Chat in every session, and the status bar shows how many notes the project has.

The **Inbox** tab is the review surface: it lists auto-extract proposals (open one to read the notes, then accept all or discard) and any Dream result waiting to be switched to. The **Settings** tab has switches for memory, auto memory, automatic Dreams and auto-extract, plus the current recall and subagent memory policies.

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/memory-tab.png" width="860" alt="DeepSeek Harness with the Memory tab open, listing four notes with search, type filters and a New button">
</p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/dream-plan.png" alt="Earlier Dream interface with one change expanded">
      <br>
      <b>Dream.</b> Review the result before switching to the prepared copy.
    </td>
    <td width="50%" valign="top">
      <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/settings.png" alt="Settings with switches for memory and automatic Dreams, and an editable list of what to remember">
      <br>
      <b>Settings.</b> Switches for memory and automatic Dreams, and the rules for what is worth saving.
    </td>
  </tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/assets/memory-light.png" width="680" alt="The Memories tab in the light theme">
  <br>
  <sub>It follows the host's light and dark themes. Every screenshot is real, from DeepSeek Harness, with a made-up project.</sub>
</p>

## Why this one

**Bring your memories.** Notes are plain Markdown in a Claude Code-compatible layout: a `MEMORY.md` index plus one file per topic. Already have Claude Code memories? `/memory import` brings them over, and you can open every file in your editor.

**Dream shows its sources.** Dream reads session chunks and checks each new fact against a transcript quote. It keeps superseded values in the note's history.

**You control when Dream takes effect.** Dream writes a separate copy. Switching backs up the current notes first, and undo restores the notes touched by the switch. Automatic Dreams are off by default.

## Try it

Run these in a session.

1. Tell your agent something worth keeping, or save it yourself:

   ```text
   /remember --type=project Release notes live in docs/releases.md
   ```

2. Start a new session. The agent receives a snapshot of the start of `MEMORY.md` (up to 200 lines or 25 KB by default). Compaction, config or rule changes, and `/memory refresh` rebuild it. The per-turn selector can attach relevant notes, and the agent can read other topics on demand.

3. After a few sessions, start a background Dream. It returns a run ID and prepares a copy of your notes.

   ```text
   /memory dream run
   /memory dream status <runId>
   ```

   A long session is split into parts and each part is analyzed once. `/memory dream cancel` stops a run and keeps the parts it finished; `/memory dream resume` retries only the missing parts. `/memory dream run --wait` still waits for the run to finish.

4. Review the result in Memory and switch to it when ready. Undo the switch if you change your mind.

   ```text
   /memory dream switch
   /memory dream undo
   ```

You can do steps 3 and 4 on the **Dream** tab of the Memory view too. See the [command reference](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md) for everything else.

## Coming from Claude Code

```text
/memory import ~/.claude/projects/<your-project>
```

The import reads `MEMORY.md` and the topic files, and keeps their `name`, `description` and `type`. It skips files that already exist, and secret scanning still applies. `/memory export <path>` writes the same layout back.

What is different here:

| | This plugin |
|---|---|
| Consolidation | A validated copy you can switch to or discard, with backups and undo |
| New facts from Dream | Must quote the transcript |
| Automatic Dream | Off by default |
| Recall | A cheap model selector picks at most 5 candidates per turn; autoRecallMaxFiles (default 3) still caps what is attached. There is no lexical fallback |
| Auto-extract | Off by default; proposals stage in an Inbox for review; never writes directly |
| Subagents | One `subagentMemory` policy: `off` (default), `shared`, or `own` per-agent directories |

## Is it right for you?

This plugin suits you if you want to read and correct what your agent remembers, and you work on the same projects for a long time.

Look elsewhere if you need:

- **Vector search or a hosted memory service.** This plugin has neither. Recall is a cheap model selector over note names and descriptions, so a rephrased question can still miss. `@openviking/dsh-memory-plugin`, `@honcho-ai/dsh-honcho` and `dsh-tdai-memory` take other approaches.
- **Approval for every write.** The Inbox lets you review auto-extract proposals. Ordinary memory saves run through the write policy immediately.

## Your data

- Memories stay on your machine, under `$DSH_HOME/cc-memory/`. The plugin has no telemetry.
- Memory text goes to your model provider as part of normal prompts.
- Dream sends session text and memories to the provider you configured. The synthetic three-short-session demo used 6,500 to 11,000 tokens. One real-project batch used **149,984 reported total tokens and about 263 seconds**, then applied two memory writes and one index update. These are different workloads, not a typical-use estimate. See the [aggregate observations](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/REAL-WORKSPACE-OBSERVATIONS-2026-11-09.md).
- Before starting a run, use `/memory dream estimate`, or review the input estimate shown when starting Dream in the interface. Estimation reads the input without calling the model. Starting a run calls the model. Actual total usage can exceed the rough input estimate. `dreamMaxTotalTokens: 0` means unlimited; set an explicit budget and `dreamCostMode: block` if you need the existing cost guard.
- Writes that match common key formats are refused. This is a heuristic and will not catch every secret. See [SECURITY.md](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md).

## Status

**Experimental, and we do not yet know how much it helps.** DeepSeek Harness is itself a preview, and its plugin API can change.

What has been checked:

- The test suite runs on Windows and Ubuntu with Node 22 and 24.
- The packed plugin was installed into a clean profile on DeepSeek Harness 0.2.2-rc.1. An earlier release completed a real-model Dream there using synthetic sessions, from preview to selective apply and undo.

What has not:

- **Whether memory improves answers in general.** The comparison at the top is one scenario built to show the difference. In a [small pilot](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/RELIABILITY-REPORT-2026-11-08.md), stored memory helped with a stable preference, failed a one-paragraph instruction like every other group, and gave a result on a user correction that we do not trust. Dream changed nothing in that pilot, so it says nothing about Dream.
- **Long use on real projects.** We are looking for this feedback. If you try Dream on real work, please [tell us what it got right and wrong](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/issues/new?template=feedback.yml).

Known limits:

- A quote proves the words exist in the session. It does not prove the conclusion drawn from them is right, so review the result before switching.
- Telling your typing apart from pasted text is a heuristic, and short pastes get through.
- The interface comes in English and Chinese.

## More

- [Command reference](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/commands.md)
- [Manual](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/manual.zh.md) and [architecture](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/docs/ARCHITECTURE.md) (Chinese)
- [How the evaluation works](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/eval/README.md) (Chinese)
- [Contributing](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CONTRIBUTING.md) · [Security](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/SECURITY.md) · [Changelog](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/CHANGELOG.md)

## Contributors

- [muuuuuuuuuer](https://github.com/muuuuuuuuuer) — maintainer.
- [Claude](https://github.com/claude) — AI coding assistance through Claude Code.

## Acknowledgements

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) was also used during development.

## License

[MIT](https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/LICENSE)

This is an independent community plugin, not affiliated with or endorsed by Anthropic or DeepSeek. Claude Code is a product of Anthropic.
