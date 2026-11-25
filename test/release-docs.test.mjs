/**
 * The public README promises things to people deciding whether to install. These
 * checks pin the parts that can drift: the name, the install command, the
 * not-affiliated note, links that also work on npm, honest test results, and
 * real commands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const localPath = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));
const readme = await read('README.md');
const readmeZh = await read('README.zh.md');
const commandsDoc = await read('docs/commands.md');
const commandsSource = await read('src/commands.js');

const REPO_BASE = 'https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/blob/main/';
const pkg = JSON.parse(await read('package.json'));

for (const [name, doc] of [['README.md', readme], ['README.zh.md', readmeZh]]) {
  test(`${name} gives the install command and the not-affiliated note`, () => {
    const archive = `https://github.com/muuuuuuuuuer/dsh-cc-dream-memory/releases/download/v${pkg.version}/${pkg.name}-${pkg.version}.tgz`;
    assert.ok(doc.includes(`\ndsh plugin --profile web add ${pkg.name}\n`), 'Web installs from npm');
    assert.ok(doc.includes(`npx @deepseek-ai/dsh plugin --profile web add ${pkg.name}\n`), 'Web users can use npx if dsh is not on PATH');
    assert.ok(doc.includes(`\n${archive}\n`), 'Desktop falls back to the matching release archive');
    assert.match(doc, /Anthropic/);
    assert.match(doc, /DeepSeek/);
  });

  test(`${name} makes no claims the evidence cannot carry`, () => {
    assert.doesNotMatch(doc, /\b(best|smartest|smarter|world-class)\b|最好的|最强|更聪明地/i);
    assert.doesNotMatch(doc, /\b(official|officially)\b(?! plugin)/i);
  });

  test(`${name} links are absolute and point at files in the repository`, () => {
    assert.doesNotMatch(doc, /<img|\.png\b/, 'the README carries no screenshots');
    const links = [...doc.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    for (const link of links) {
      assert.match(link, /^https:\/\//, `${link} must be absolute so npm can follow it`);
      if (link.startsWith(REPO_BASE)) {
        const file = link.slice(REPO_BASE.length).split('#')[0];
        assert.ok(existsSync(localPath(file)), `${link} is missing`);
      }
    }
  });

  test(`${name} carries no local paths`, () => {
    assert.doesNotMatch(doc, /C:\\Users|\/Users\/|16864/);
  });
}

const RESULTS = [
  ['README.md', readme, '## Test results', /not the full 500/],
  ['README.zh.md', readmeZh, '## 测试结果', /不是完整的 500 题/],
];
for (const [name, doc, heading, sampleLimit] of RESULTS) {
  test(`${name} reports test results with their limits`, () => {
    assert.ok(doc.includes(`\n${heading}\n`), `${name} needs ${heading}`);
    assert.match(doc, sampleLimit, 'a 30-question sample must say it is not the full benchmark');
  });
}

test('both READMEs list the two linked contributors', () => {
  for (const [doc, heading] of [[readme, 'Contributors'], [readmeZh, '贡献者']]) {
    const section = doc.split(`## ${heading}\n`)[1]?.split('\n## ')[0];
    assert.ok(section, heading);
    const accounts = [...section.matchAll(/^- \[[^\]]+\]\(https:\/\/github\.com\/([^)]+)\)/gm)].map((match) => match[1]);
    assert.deepEqual(accounts, ['muuuuuuuuuer', 'claude']);
  }
});

test('the icon label no longer uses the Claude name', async () => {
  const icon = await read('icon.svg');
  assert.doesNotMatch(icon, /aria-label="[^"]*Claude/);
  assert.match(icon, /aria-label="Memory"/);
});

test('the English README opens with the positioning line', () => {
  assert.match(readme, /Claude Code-style auto memory and Dream for DeepSeek Harness\./);
  assert.match(readme, /not affiliated/i);
});

test('the Chinese README says the same', () => {
  assert.match(readmeZh, /Claude Code/);
  assert.match(readmeZh, /无关/);
});

test('every documented /memory command exists in the code', () => {
  const subcommands = new Set([...commandsDoc.matchAll(/\/memory ([a-z-]+)/g)].map((m) => m[1]));
  assert.ok(subcommands.size >= 10, 'the reference should cover the command set');
  for (const sub of subcommands) assert.ok(commandsSource.includes(sub), sub);
});

test('a finished run points at switching, not at a second run', () => {
  assert.doesNotMatch(commandsSource, /apply with \/memory dream run/);
  assert.match(commandsSource, /memory switched to the dream result/);
  assert.match(commandsSource, /undo with \/memory dream undo/);
});

test('screenshots.json lists files that exist', async () => {
  const shots = JSON.parse(await read('screenshots.json'));
  const list = Array.isArray(shots) ? shots : shots.screenshots;
  assert.ok(list.length >= 1 && list.length <= 8);
  for (const file of list) assert.ok(existsSync(localPath(file)), file);
});
