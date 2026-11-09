/**
 * The public README promises things to people deciding whether to install. These
 * checks pin the parts that can drift: the name, the install command, the
 * not-affiliated note, images that also work on npm, and real commands.
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

const IMAGE_BASE = 'https://raw.githubusercontent.com/muuuuuuuuuer/dsh-cc-dream-memory/main/';

for (const [name, doc] of [['README.md', readme], ['README.zh.md', readmeZh]]) {
  test(`${name} gives the install command and the not-affiliated note`, () => {
    assert.match(doc, /dsh plugin --profile web add dsh-cc-dream-memory/);
    assert.match(doc, /npx @deepseek-ai\/dsh plugin --profile web add dsh-cc-dream-memory/, 'desktop users have no dsh on PATH');
    assert.match(doc, /Anthropic/);
    assert.match(doc, /DeepSeek/);
  });

  test(`${name} makes no claims the evidence cannot carry`, () => {
    assert.doesNotMatch(doc, /\b(best|smartest|smarter|world-class)\b|最好的|最强|更聪明地/i);
    assert.doesNotMatch(doc, /\b(official|officially)\b(?! plugin)/i);
  });

  test(`${name} images use absolute URLs and exist in the repository`, () => {
    const urls = [...doc.matchAll(/(?:src="|\]\()(https:\/\/raw\.githubusercontent\.com[^")]+|assets\/[^")]+)/g)].map((m) => m[1]);
    assert.ok(urls.length >= 2, 'the page needs its icon and a screenshot');
    for (const url of urls) {
      assert.ok(url.startsWith(IMAGE_BASE), `${url} must be absolute so npm can show it`);
      assert.ok(existsSync(localPath(url.slice(IMAGE_BASE.length))), `${url} is missing`);
    }
  });

  test(`${name} carries no local paths`, () => {
    assert.doesNotMatch(doc, /C:\\Users|\/Users\/|16864/);
  });
}

const SHOWCASE = [
  ['README.md', readme, /not a benchmark/i],
  ['README.zh.md', readmeZh, /不是评测/],
];
for (const [name, doc, disclaimer] of SHOWCASE) {
  test(`${name} shows the interface and a real before-and-after`, () => {
    const images = [...doc.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    for (const shot of ['before-after', 'dream-before-after', 'memory-tab', 'dream-plan', 'settings', 'memory-light']) {
      assert.ok(images.some((url) => url.endsWith(`/assets/${shot}.png`)), `${name} needs ${shot}.png`);
    }
    assert.match(doc, disclaimer, 'the comparison is one example and must say so');
  });
}

test('both READMEs credit DeepSeek Harness as a contributor', () => {
  assert.match(readme, /## Contributors\s[^#]*DeepSeek Harness/);
  assert.match(readmeZh, /## 贡献者\s[^#]*DeepSeek Harness/);
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

test('the dry-run message points at preview and apply, not at another run', () => {
  assert.doesNotMatch(commandsSource, /apply with \/memory dream run/);
  assert.match(commandsSource, /dry-run: no memory file was changed; review with \/memory dream preview, then \/memory dream apply\./);
});

test('screenshots.json lists files that exist', async () => {
  const shots = JSON.parse(await read('screenshots.json'));
  const list = Array.isArray(shots) ? shots : shots.screenshots;
  assert.ok(list.length >= 1 && list.length <= 8);
  for (const file of list) assert.ok(existsSync(localPath(file)), file);
});
