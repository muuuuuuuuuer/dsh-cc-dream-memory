# UI freeze

**Status: FROZEN.** Backend, data, command and documentation changes are not affected, but they must not change the interface along the way.

## What is frozen

| File | Covers |
|---|---|
| `client.js` | The Memory view: layout, interaction, styles and card structure |
| `locale/en.json`, `locale/zh.json` | All interface text |
| `icon.svg` | The plugin icon |

## How it is enforced

`.ui-freeze.json` stores normalized SHA-256 hashes (LF, no BOM) of these files. `test/ui-freeze.test.mjs` checks them on every test run, and `node scripts/ui-freeze.mjs` checks them on its own. A UI change without an updated manifest fails the tests on purpose. Do not delete or bypass that test.

## Changing the UI

1. Open an issue that says what should change and why, and get explicit approval from a maintainer.
2. Change `client.js`, the locale files or the icon.
3. Run `node scripts/ui-freeze.mjs --update`.
4. Start the commit message with `UI-FREEZE:` and name the approval and the reason.
5. Run `node --test "test/*.test.mjs"` and `node scripts/verify.mjs`.

The freeze does not mean the UI will never change. It means the default is no change, and every change is approved and on record.
