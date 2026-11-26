# Command reference

Run these in a DeepSeek Harness session. Run bare `/memory` to see the current status and command usage. Browsing, editing, deleting, rules, toggles, backups, and trash management live in the **Memory** panel and its HTTP API.

## Everyday

| Command | What it does |
|---|---|
| `/remember [--type=user\|feedback\|project\|reference] [--force] <text>` | Save one note. A duplicate or a contradiction of an existing note is refused unless you add `--force`; related notes are listed so you can check them |
| `/memory` | Show status: plugin/auto-memory/auto-dream state, index size, entry count, per-conversation flags, archive candidates, pending Dream status, and health warnings |
| `/memory status` | Same as bare `/memory` |
| `/memory search <query> [--type=...] [--limit=10]` | Search names, descriptions, and current bodies |
| `/memory undo` | Undo the most recent Dream switch (restoring touched notes and moving newly created notes to trash) |
| `/memory session [status]` | Show whether this conversation loads memory (`use`) and is learned from (`learn`) |
| `/memory session use on\|off` | `off`: this conversation loads no memory and recalls nothing |
| `/memory session learn on\|off` | `off`: auto-extract skips this conversation and Dream leaves it out; `memory_save` still works |

## Dream

| Command | What it does |
|---|---|
| `/memory dream status [runId]` | Show Dream status, any pending shadow diff summary, recent run status, or one specific run |
| `/memory dream run [--focus "<topic>"] [--memory-only] [--wait]` | Start a Dream run; it writes a cleaned-up copy of your memory under `.dreams/shadow/` and leaves live notes untouched (`--wait` waits for completion) |
| `/memory dream estimate [--memory-only]` | Estimate input tokens without calling the model or changing memory; actual total usage can be higher |
| `/memory dream resume <runId> [--wait]` | Continue a paused Dream run from its saved checkpoint |
| `/memory dream cancel [runId]` | Stop a running Dream run and discard its work |
| `/memory dream diff <file>` | Show one pending change: removed and added lines, whether its source was checked, its evidence, and what you rejected on that page before |
| `/memory dream switch [--reject <file,...>] [--defer <file,...>] [--confirm <file,...>]` | Apply the copy Dream wrote (backed up first; `/memory undo` returns). `--reject` keeps those files and remembers the change; `--defer` leaves them for later without rejecting; `--confirm` accepts files without a checked source after you read their diff |
| `/memory dream discard` | Defer the pending Dream copy; memory stays as it is and its sessions remain eligible for a later run |

The model has four tools of its own: `memory_save`, `memory_update`, `memory_read`, and `memory_search`.

Configuration options are in the [manual](manual.zh.md) (Chinese).
