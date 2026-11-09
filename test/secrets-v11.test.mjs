/**
 * v11 step 5: expanded secret scanning with deny/warn severity.
 * Contract `docs/superpowers/specs/2026-11-07-v11-user-six-steps.md` §5.
 * os.tmpdir(); no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, toolsEnv } from './v10-helpers.mjs';
import { loadModule } from './helpers.mjs';

const SAMPLES = {
  'sk-proj': `sk-proj-${'AbCdEfGhIjKlMnOpQrStUvWx'.slice(0, 24)}`,
  'sk-ant': `sk-ant-${'ZzYyXxWwVvUuTtSsRrQqPpOo'.slice(0, 24)}`,
  github_pat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
  gho: 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
  'google-api-key': 'AIzaSyD-1234567890abcdefghijklmnopqrstuvw',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'connection-string': 'postgres://admin:sup3rSecret@db.internal:5432/app',
  'chinese-password': '密码：hunter2supersecret',
  'chinese-password-colon': '数据库密码: abcdef123456',
};

const WARN_SAMPLES = {
  'generic assignment': 'api_key=abcdefghijklmnopqrstuvwxyz1234567890',
  'high entropy': 'Xk9fJ2mQ7pL3vN8wR4tY6uI1oP5aS0dFgH2jK4mN6',
};

let secretsPromise;

function secretsModule() {
  if (!secretsPromise) {
    secretsPromise = loadModule('../src/secrets.js', {
      requireExports: ['scanSecrets', 'secretWarnings', 'SECRET_RULES', 'SECRET_DETECTED'],
    });
  }
  return secretsPromise;
}

test('v11 secrets: every previously-missed credential format is a deny match', async (t) => {
  await makeEnv(t);
  const { scanSecrets } = await secretsModule();
  for (const [label, sample] of Object.entries(SAMPLES)) {
    const result = scanSecrets(`token: ${sample}`);
    assert.equal(result.hasDeny, true, `${label} must be denied: ${JSON.stringify(result.matches)}`);
    assert.ok(Array.isArray(result.matches) && result.matches.length >= 1);
    const match = result.matches.find((item) => item.severity === 'deny');
    assert.ok(match, `${label} must expose a deny-severity match: ${JSON.stringify(result.matches)}`);
  }
});

test('v11 secrets: generic assignments and high-entropy strings stay warn-only', async (t) => {
  await makeEnv(t);
  const { scanSecrets } = await secretsModule();
  for (const [label, sample] of Object.entries(WARN_SAMPLES)) {
    const result = scanSecrets(sample);
    assert.equal(result.hasWarn, true, `${label} must produce a warning: ${JSON.stringify(result.matches)}`);
    assert.equal(result.hasDeny, false, `${label} must not be a deny match`);
  }
});

test('v11 secrets: scanSecrets returns hasDeny/hasWarn and secretWarnings formats excerpts', async (t) => {
  await makeEnv(t);
  const { scanSecrets, secretWarnings } = await secretsModule();

  const clean = scanSecrets('nothing secret here');
  assert.deepEqual(clean.matches, []);
  assert.equal(clean.hasDeny, false);
  assert.equal(clean.hasWarn, false);

  const mixed = scanSecrets(`deploy key ${SAMPLES['sk-ant']} and api_key=abcdefghijklmnopqrstuvwxyz1234567890`);
  assert.equal(mixed.hasDeny, true);
  assert.equal(mixed.hasWarn, true);
  assert.equal(mixed.matches.some((item) => item.severity === 'deny'), true);
  assert.equal(mixed.matches.some((item) => item.severity === 'warn'), true);

  const warnings = secretWarnings(mixed.matches);
  assert.ok(Array.isArray(warnings) && warnings.length >= 1);
  const text = warnings.join('\n');
  assert.doesNotMatch(text, new RegExp(SAMPLES['sk-ant']), 'warnings must not echo the full secret');
  assert.match(text, /deny|sk-ant/i);
});

test('v11 secrets: the write layer rejects deny matches and warns for warn matches', async (t) => {
  await toolsEnv(t);
  const denyEnv = await toolsEnv(t);
  const save = denyEnv.definitions.get('memory_save');
  const exec = { agent: { id: 'agent-1' }, sessionId: 'sess-1' };

  const denied = await save.execute(
    {
      name: 'leak attempt',
      type: 'reference',
      description: 'contains a key',
      content: `deploy with ${SAMPLES['github_pat']}`,
      force: true,
    },
    exec,
  );
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.match(String(denied.error), /secret[-_]detected/i, `expected a secret rejection, got ${JSON.stringify(denied)}`);
  assert.equal((await denyEnv.pctx.store.listEntries()).some((entry) => entry.name === 'leak attempt'), false);

  const warned = await save.execute(
    {
      name: 'warn note',
      type: 'reference',
      description: 'assignment-shaped text',
      content: 'config line: api_key=abcdefghijklmnopqrstuvwxyz1234567890',
      force: true,
    },
    exec,
  );
  assert.equal(warned.ok, true, JSON.stringify(warned));
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length >= 1, JSON.stringify(warned));
});

test('v11 secrets: store-level scan produces deny/warn severity on the result', async (t) => {
  const env = await makeEnv(t);
  await assert.rejects(
    env.store.saveEntry({
      name: 'store deny',
      type: 'reference',
      description: 'd',
      content: `AIza${'SyD-1234567890abcdefghijklmnopqrstuvw'.slice(0, 35)}`,
    }),
    (error) => {
      assert.equal(error.code, 'SECRET_DETECTED');
      assert.ok(Array.isArray(error.matches));
      assert.equal(error.matches.some((item) => item.severity === 'deny'), true);
      return true;
    },
  );
  const warned = await env.store.saveEntry({
    name: 'store warn',
    type: 'reference',
    description: 'd',
    content: 'api_key=abcdefghijklmnopqrstuvwxyz1234567890',
  });
  assert.equal(warned.ok, true);
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length >= 1);
});
