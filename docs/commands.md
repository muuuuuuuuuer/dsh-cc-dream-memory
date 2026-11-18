# Command reference

Run these in a DeepSeek Harness session. Run bare `/memory` to see the current status and the full usage text.

## Everyday

| Command | What it does |
|---|---|
| `/remember [--type=user\|feedback\|project\|reference] [--force] <text>` | Save one note. A duplicate or a contradiction of an existing note is refused unless you add `--force`; related notes are listed so you can check them |
| `/memory` | Show status: entries, index size, recall mode, auto-extract and Inbox state, per-agent policy, Dream state and health |
| `/memory status` | Same as bare `/memory` |
| `/memory list` | List memories |
| `/memory show <file>` | Show one memory |
| `/memory search <query>` | Search names, descriptions and bodies |
| `/memory edit <file> --content <text>` | Edit a memory. `--name`, `--type` and `--description` also work |
| `/memory merge <file1> <file2>` | Merge notes into the first file |
| `/memory delete <file>` | Move a memory to the trash |
| `/memory metrics` | Show injections, reads, writes, recalls and Dream usage |

## Dream

`/dream` is a short alias for `/memory dream`.

| Command | What it does |
|---|---|
| `/memory dream run` | Start a background run; it writes a cleaned-up copy of your memory under `.dreams/shadow/` and leaves the real notes untouched; `/memory dream status [runId]` shows progress, `cancel` stops it (a stopped or failed run is started again with `run`) |
| `/memory dream run --focus "<topic>"` | Prefer one topic in this round |
| `/memory dream diff <file>` | Show one pending change: removed and added lines, whether its source was checked, its evidence, and what you rejected on that page before |
| `/memory dream switch [--reject <file,...>] [--defer <file,...>] [--confirm <file,...>]` | Apply the copy Dream wrote (backed up first; `undo` returns). `--reject` keeps those files and remembers the exact change so it is not proposed again without new evidence; `--defer` keeps them without remembering anything. A change without a checked source applies only with `--confirm`, after you read its diff |
| `/memory dream discard` | Reject every change; memory stays exactly as it is and these facts are never proposed again |
| `/memory dream undo` | Undo the most recent switch (only the notes that switch touched) |
| `/memory dream history` | List past Dreams |
| `/memory dream status` | Show what a Dream would read and whether one is ready |
| `/memory dream estimate [--memory-only]` | Estimate input tokens without calling the model or changing memory. Actual total usage can be higher. |
| `/memory dream on` | Turn on automatic Dreams. They are off by default |
| `/memory dream off` | Turn automatic Dreams off |

## Inbox (manual API; UI shows only Dream)

Automatic extraction writes directly through `memory_save` and does not stage proposals. The web Inbox tab now shows only a Dream shadow awaiting review. The commands below remain as a manual/legacy staging API: `/memory inbox accept <id>` applies the `memory_save` gates; `/memory inbox discard <id>` removes the proposal.

| Command | What it does |
|---|---|
| `/memory inbox list` | List pending proposals |
| `/memory inbox show <id>` | Show one proposal as JSON |
| `/memory inbox accept <id>` | Apply the proposal through `memory_save`; the file is removed only when every item succeeds |
| `/memory inbox discard <id>` | Delete a proposal without writing memory |

## Moving memories

| Command | What it does |
|---|---|
| `/memory import <path>` | Import a Claude Code style memory folder |
| `/memory export <path>` | Export this project's memory in that layout |

## Review and recovery

| Command | What it does |
|---|---|
| `/memory history <file>` | List earlier versions of a memory |
| `/memory backups` | List the backups taken before Dreams |
| `/memory trash` | List deleted memories |
| `/memory restore <backup or trash id> [file]` | Restore a backup or a deleted memory |

## Settings

| Command | What it does |
|---|---|
| `/memory on` | Turn auto memory on |
| `/memory off` | Turn auto memory off |
| `/memory plugin on` | Turn the whole plugin on |
| `/memory plugin off` | Turn the whole plugin off |
| `/memory user on` | Turn on memory shared across projects |
| `/memory user off` | Turn off memory shared across projects |
| `/memory rules` | Show the rules injected with memory |
| `/memory rules reset` | Restore the default rules |
| `/memory refresh` | Rebuild what the current session sees |
| `/memory index` | Show `MEMORY.md` |
| `/memory json` | Print the status as JSON |

The model has four tools of its own: `memory_save`, `memory_update`, `memory_read` and `memory_search`.

Configuration options are in the [manual](manual.zh.md) (Chinese).
