# Contributing

Bug reports, real-world Dream results and small fixes are the most useful contributions right now.

## Set up

You need Node 22 or newer. The plugin has no runtime dependencies, so there is nothing to install.

```bash
node --test "test/*.test.mjs"
node scripts/verify.mjs
```

To try your copy in DeepSeek Harness, pack it and add the tarball to a test profile:

```bash
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-cc-dream-memory-<version>.tgz
```

## Rules for changes

- **Test first.** Write a test that fails, watch it fail, then fix the code.
- **Keep the UI as it is.** The Web UI is frozen. Read [UI-FREEZE.md](UI-FREEZE.md) and open an issue before you change it.
- **Keep the data format readable.** Memories are plain Markdown, and users edit them by hand.
- **Say what you can prove.** Do not claim that a change makes answers better unless you have the evaluation to show it. See [eval/README.md](eval/README.md).
- **Do not paste private data.** Remove memories, session text, paths and keys from issues, tests and logs.

## Project layout

| Path | What is there |
|---|---|
| `index.js`, `src/` | The plugin host side |
| `client.js`, `locale/` | The Web view (frozen) |
| `test/` | Tests that run with `node --test` |
| `eval/` | Paired evaluation scenarios, runner and reports |
| `docs/` | Manual, architecture and internal interfaces (mostly in Chinese) |
