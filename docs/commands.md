# Command reference

Run these in a DeepSeek Harness session. Run bare `/memory` to see the current status and the full usage text.

## Everyday

| Command | What it does |
|---|---|
| `/remember [--type=user\|feedback\|project\|reference] [--scope=project\|user] <text>` | Save one note |
| `/memory` | Show status: entries, index size, Dream state and health |
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
| `/memory dream run --dry-run` | Make a plan without changing anything |
| `/memory dream run --dry-run --focus "<topic>"` | Prefer one topic in this round |
| `/memory dream preview` | Show the plan's operations and the quotes behind new statements |
| `/memory dream apply` | Apply the whole plan |
| `/memory dream apply-ops 0,2` | Apply only the numbered operations |
| `/memory dream reject` | Discard a proposal |
| `/memory dream undo` | Undo the most recent Dream |
| `/memory dream history` | List past Dreams |
| `/memory dream status` | Show what a Dream would read and whether one is ready |
| `/memory dream on` | Turn on automatic Dreams. They are off by default |
| `/memory dream off` | Turn automatic Dreams off |

## Moving memories

| Command | What it does |
|---|---|
| `/memory import <path>` | Import a Claude Code style memory folder |
| `/memory export <path>` | Export this project's memory in that layout |

## Review and recovery

| Command | What it does |
|---|---|
| `/memory writes` | List writes waiting for review |
| `/memory approve <id>` | Approve a waiting write |
| `/memory reject <id>` | Reject a waiting write |
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
