/** Read-only source preflight for the dedicated headless evaluation profile. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mismatch(message) {
  const error = new Error(`Evaluation profile source mismatch: ${message}`);
  error.code = 'EVAL_PROFILE_SOURCE_MISMATCH';
  return error;
}

/**
 * Require the dedicated profile to load the exact owning checkout/release.
 * Matching package versions alone cannot identify which source is evaluated.
 * This reads package metadata and real paths only; it never starts a model.
 */
export function assertProfileSource({
  profileDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'cc-memory-eval'),
  expectedRoot,
}) {
  try {
    const expectedTarget = fs.realpathSync(expectedRoot);
    const expected = JSON.parse(fs.readFileSync(path.join(expectedTarget, 'package.json'), 'utf8'));
    if (expected.name !== 'dsh-cc-dream-memory') throw mismatch('expected root is not dsh-cc-dream-memory');
    const profile = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const bundles = profile.dsh?.profile?.bundles;
    if (!profile.dependencies?.[expected.name]) throw mismatch(`profile must declare ${expected.name}`);
    if (!Array.isArray(bundles) || !bundles.includes(expected.name)) throw mismatch(`profile must enable bundle ${expected.name}`);
    if (bundles.includes('dsh-cc-memory')) throw mismatch('archived dsh-cc-memory bundle remains enabled');
    const target = fs.realpathSync(path.join(profileDir, 'node_modules', expected.name));
    const actual = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    const errors = [];
    if (actual.name !== expected.name) errors.push(`name mismatch: ${actual.name} != ${expected.name}`);
    if (actual.version !== expected.version) errors.push(`version mismatch: ${actual.version} != ${expected.version}`);
    if (path.relative(expectedTarget, target) !== '') errors.push(`canonical target mismatch: ${target} != ${expectedTarget}`);
    if (errors.length > 0) throw mismatch(errors.join('; '));
    return { profileDir, name: actual.name, version: actual.version, target };
  } catch (error) {
    if (error?.code === 'EVAL_PROFILE_SOURCE_MISMATCH') throw error;
    // Avoid printing profile contents, environment values, or config dumps.
    throw mismatch(`cannot inspect package source (${error?.code || error?.name || 'unknown error'})`);
  }
}
