import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir, loadModule } from './helpers.mjs';

async function fixture(t, { declaredName = 'dsh-cc-dream-memory', installedName = declaredName, installedVersion = '0.12.0', otherTarget = false, oldBundle = false } = {}) {
  const root = await makeTempDir(t, 'eval-profile-source-');
  const profileDir = path.join(root, 'dsh', 'profiles', 'cc-memory-eval');
  const installedRoot = path.join(profileDir, 'node_modules', declaredName);
  const expectedRoot = otherTarget ? path.join(root, 'release') : installedRoot;
  await fs.mkdir(path.join(profileDir, 'node_modules'), { recursive: true });
  await fs.mkdir(expectedRoot, { recursive: true });
  await fs.mkdir(installedRoot, { recursive: true });
  await fs.writeFile(path.join(expectedRoot, 'package.json'), JSON.stringify({ name: 'dsh-cc-dream-memory', version: '0.12.0' }));
  if (otherTarget) await fs.writeFile(path.join(installedRoot, 'package.json'), JSON.stringify({ name: installedName, version: installedVersion }));
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { unrelated: '^1.0.0', [declaredName]: `link:${installedRoot}` },
    dsh: { profile: { bundles: ['unrelated', declaredName, ...(oldBundle ? ['dsh-cc-memory'] : [])] } },
  }));
  const { assertProfileSource } = await loadModule('../eval/profile-source.mjs', { requireExports: ['assertProfileSource'] });
  return { profileDir, expectedRoot, installedRoot, assertProfileSource };
}

test('eval source preflight accepts the owning release and reports its canonical source without writing', async (t) => {
  const env = await fixture(t);
  const before = await fs.readFile(path.join(env.profileDir, 'package.json'), 'utf8');
  const result = env.assertProfileSource(env);
  assert.equal(result.name, 'dsh-cc-dream-memory');
  assert.equal(result.version, '0.12.0');
  // Windows sync/async realpath may spell the same directory as 8.3/long paths.
  assert.equal(await fs.realpath(result.target), await fs.realpath(env.expectedRoot));
  assert.equal(await fs.readFile(path.join(env.profileDir, 'package.json'), 'utf8'), before);
});

test('eval source preflight rejects the archived package alias', async (t) => {
  const env = await fixture(t, { declaredName: 'dsh-cc-memory', otherTarget: true, installedVersion: '0.11.1' });
  assert.throws(() => env.assertProfileSource(env), { code: 'EVAL_PROFILE_SOURCE_MISMATCH' });
});

test('eval source preflight rejects another checkout even when name and version match', async (t) => {
  const env = await fixture(t, { otherTarget: true });
  assert.throws(() => env.assertProfileSource(env), /canonical target/);
});

test('eval source preflight rejects stale installed package metadata', async (t) => {
  for (const installed of [{ installedName: 'dsh-cc-memory', message: /name mismatch/ }, { installedVersion: '0.11.1', message: /version mismatch/ }]) {
    const env = await fixture(t, { otherTarget: true, ...installed });
    assert.throws(() => env.assertProfileSource(env), installed.message);
  }
});

test('eval source preflight rejects an old bundle left enabled alongside the current package', async (t) => {
  const env = await fixture(t, { oldBundle: true });
  assert.throws(() => env.assertProfileSource(env), /archived.*bundle/);
});

test('eval source preflight follows the host DSH_HOME rather than another profile directory', async (t) => {
  const env = await fixture(t);
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.dirname(path.dirname(env.profileDir));
    const result = env.assertProfileSource({ expectedRoot: env.expectedRoot });
    assert.equal(await fs.realpath(result.target), await fs.realpath(env.expectedRoot));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('eval source preflight rejects a package left installed but missing from the enabled bundles', async (t) => {
  const env = await fixture(t);
  const file = path.join(env.profileDir, 'package.json');
  const profile = JSON.parse(await fs.readFile(file, 'utf8'));
  profile.dsh.profile.bundles = ['unrelated'];
  await fs.writeFile(file, JSON.stringify(profile));
  assert.throws(() => env.assertProfileSource(env), /must enable bundle/);
});
