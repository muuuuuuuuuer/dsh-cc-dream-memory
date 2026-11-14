/**
 * Tests for src/commands.js pure parsers (ui-commands).
 *
 * Contract (see the module's documented semantics): the host passes a command
 * handler only the text *after* the command name, so
 * `parseCommandLine('dream run --dry-run')` → `{ verb: 'dream', args: ['run', '--dry-run'] }`.
 * A complete slash line is also accepted and normalizes to the same result:
 * `parseCommandLine('/memory dream run --dry-run')`. For `/remember` the verb is
 * the command name and the flags/text stay in `args`; `parseRememberInput`
 * extracts `--type` and preserves the free-form text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers.mjs';

let commandsModulePromise;

function commandsModule() {
  if (!commandsModulePromise) {
    commandsModulePromise = loadModule('../src/commands.js', {
      requireExports: ['registerCommands', 'parseCommandLine', 'parseRememberInput'],
    });
  }
  return commandsModulePromise;
}

/** Parse and normalize `args` shape (must always be a string array). */
async function parse(raw) {
  const { parseCommandLine } = await commandsModule();
  const result = parseCommandLine(raw);
  assert.ok(result && typeof result === 'object', `parseCommandLine(${JSON.stringify(raw)}) must return an object`);
  assert.equal(typeof result.verb, 'string', `parseCommandLine(${JSON.stringify(raw)}).verb must be a string`);
  assert.ok(Array.isArray(result.args), `parseCommandLine(${JSON.stringify(raw)}).args must be an array`);
  for (const arg of result.args) assert.equal(typeof arg, 'string', 'command args must be strings');
  return result;
}

test('/memory handler input parses the subcommand as verb', async () => {
  // This is how the host calls the /memory handler: rawInput excludes "/memory".
  assert.deepEqual(await parse(''), { verb: '', args: [] });
  assert.deepEqual(await parse('status'), { verb: 'status', args: [] });
  assert.deepEqual(await parse('json'), { verb: 'json', args: [] });
  assert.deepEqual(await parse('list'), { verb: 'list', args: [] });
  assert.deepEqual(await parse('index'), { verb: 'index', args: [] });
  assert.deepEqual(await parse('show user_role.md'), { verb: 'show', args: ['user_role.md'] });
  assert.deepEqual(await parse('delete old.md'), { verb: 'delete', args: ['old.md'] });
  assert.deepEqual(await parse('dream on'), { verb: 'dream', args: ['on'] });
  assert.deepEqual(await parse('dream run --dry-run'), { verb: 'dream', args: ['run', '--dry-run'] });
});

test('complete /memory slash lines are accepted and identify the subcommand', async () => {
  // The module documents "a complete slash line is also accepted"; depending on
  // whether the root command name stays in `verb`, the subcommand is either in
  // `verb` or the first `args` token — assert the combined shape identifies it.
  const joined = async (raw) => {
    const result = await parse(raw);
    return [result.verb, ...result.args];
  };
  const noSub = await parse('/memory');
  assert.deepEqual(noSub.args, []);
  assert.ok(['', 'memory'].includes(noSub.verb), `unexpected empty-line verb ${JSON.stringify(noSub.verb)}`);
  assert.deepEqual((await joined('/memory json')).slice(-1), ['json']);
  assert.deepEqual((await joined('/memory list')).slice(-1), ['list']);
  assert.deepEqual((await joined('/memory show user_role.md')).slice(-2), ['show', 'user_role.md']);
  assert.deepEqual((await joined('/memory delete old.md')).slice(-2), ['delete', 'old.md']);
  assert.deepEqual((await joined('/memory dream run --dry-run')).slice(-3), ['dream', 'run', '--dry-run']);
  assert.deepEqual((await joined('/memory dream on')).slice(-2), ['dream', 'on']);
});

test('extra whitespace, newlines, casing and a missing leading slash are tolerated', async () => {
  const joined = async (raw) => {
    const result = await parse(raw);
    return [result.verb, ...result.args];
  };
  assert.deepEqual((await joined('   /memory    list   ')).slice(-1), ['list']);
  assert.deepEqual((await joined('/memory\nlist\r\n')).slice(-1), ['list']);
  assert.deepEqual((await joined('memory list')).slice(-1), ['list']);

  // Handler-style input (no command prefix): the verb is the first token.
  assert.deepEqual(await parse('dream   run    --dry-run'), { verb: 'dream', args: ['run', '--dry-run'] });
  const upper = await parse('DREAM RUN --dry-run');
  assert.equal(upper.verb, 'dream', 'unknown verbs are lowercased');
  assert.deepEqual(upper.args, ['RUN', '--dry-run'], 'argument tokens keep their original case');
});

test('/remember keeps the command verb and the flag/text tokens', async () => {
  assert.deepEqual(await parse('/remember hello world'), { verb: 'remember', args: ['hello', 'world'] });
  assert.deepEqual(await parse('remember hello world'), { verb: 'remember', args: ['hello', 'world'] });

  const flagged = await parse('/remember --type=project --scope=user the deploy pipeline lives in ci/');
  assert.equal(flagged.verb, 'remember');
  assert.equal(flagged.args[0], '--type=project');
  assert.equal(flagged.args.includes('--scope=user'), true, `expected --scope flag in ${JSON.stringify(flagged.args)}`);
  assert.match(flagged.args.join(' '), /the deploy pipeline lives in ci\//);
});

test('unknown slash commands are parsed without throwing', async () => {
  assert.deepEqual(await parse('/unknown foo bar'), { verb: 'unknown', args: ['foo', 'bar'] });
  assert.deepEqual(await parse('unknown foo'), { verb: 'unknown', args: ['foo'] });
});

test('empty commands parse to an empty verb with empty args', async () => {
  for (const raw of ['', '   ', '\n', undefined, null]) {
    const result = await parse(raw);
    assert.equal(result.verb, '', `empty command ${JSON.stringify(raw)} must have an empty verb`);
    assert.deepEqual(result.args, []);
  }
});

test('quoted arguments survive tokenization', async () => {
  const show = await parse('/memory show "user role.md"');
  assert.deepEqual([show.verb, ...show.args].slice(-2), ['show', 'user role.md']);
  const remember = await parse('/remember "spaces  kept"');
  assert.equal(remember.verb, 'remember');
  assert.deepEqual(remember.args, ['spaces  kept']);
});

test('parsing is stateless: repeated calls return fresh args arrays', async () => {
  const first = await parse('/memory show user_role.md');
  first.args.push('mutated');
  const second = await parse('/memory show user_role.md');
  const tokens = [second.verb, ...second.args];
  assert.equal(tokens.includes('mutated'), false, 'a previous mutation must not leak into a new parse');
  assert.deepEqual(tokens.slice(-2), ['show', 'user_role.md']);
});

test('parseRememberInput extracts flags and preserves the message text', async () => {
  const { parseRememberInput } = await commandsModule();

  assert.deepEqual(parseRememberInput('plain note text'), {
    type: 'user',
    text: 'plain note text',
  });

  const flagged = parseRememberInput('--type=feedback use tabs for indentation');
  assert.equal(flagged.type, 'feedback');
  assert.equal(flagged.text, 'use tabs for indentation');

  const spaced = parseRememberInput('--type project never commit secrets');
  assert.equal(spaced.type, 'project');
  assert.equal(spaced.text, 'never commit secrets');

  const multiline = parseRememberInput('--type=reference line one\nline two');
  assert.equal(multiline.type, 'reference');
  assert.match(multiline.text, /line one/);
  assert.match(multiline.text, /line two/);

  assert.equal(parseRememberInput('').type, 'user', 'default type is user');
  assert.equal(parseRememberInput('').text, '');
});
