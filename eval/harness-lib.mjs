/**
 * Pure run-validity rules for the A/B/C evaluation harness.
 *
 * Kept separate from the orchestration so failure paths can be tested without a
 * model or a Host: tool discovery failures, snapshot mismatches, Dream purity
 * violations, model task failures and missing grading are classified here.
 * A condition is only eligible for comparison when its device-level checks pass.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Bump when the runner contract changes; frozen-manifest records it. */
export const HARNESS_CONTRACT = 'v14';

/**
 * Plugin config for one condition. Each condition has its own workspace path, so
 * the project identity is fixed: a path-derived one would make a memory root
 * copied from B invisible to C.
 */
export function conditionConfig(condition, memoryRoot, extra = {}) {
  return {
    memoryRoot: String(memoryRoot).replaceAll('\\', '/'),
    projectId: 'eval-project',
    enabled: true,
    autoMemoryEnabled: condition !== 'A',
    injectIndex: condition !== 'A',
    tools: condition !== 'A',
    injectionMode: 'session',
    userMemoryEnabled: false,
    autoDreamEnabled: false,
    dreamMode: 'apply',
    evalMode: false,
    ...extra,
  };
}

/** A pure consolidation must read no sessions; a transcript scenario must read some. */
export function dreamPurityError(result, scenario) {
  if (!result) return null;
  const reviewed = Number(result.sessionsReviewed) || 0;
  if (scenario?.dreamSessions === true) return reviewed > 0 ? null : `sessionsReviewed=${reviewed}, expected transcripts to be read`;
  return reviewed === 0 ? null : `sessionsReviewed=${reviewed}, expected a pure consolidation`;
}

/**
 * Remove every memory file under a memory root, keeping the state beside them, so
 * a Dream can only learn from the session transcripts.
 */
export function clearTopicFiles(memoryRoot) {
  const projects = path.join(memoryRoot, 'projects');
  if (!fs.existsSync(projects)) return;
  for (const project of fs.readdirSync(projects)) {
    const dir = path.join(projects, project, 'memory');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      if (name === 'MEMORY.md') fs.writeFileSync(path.join(dir, name), '', 'utf8');
      else fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

export function normalizeText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function hashText(text) {
  return `sha256:${createHash('sha256').update(normalizeText(text)).digest('hex')}`;
}

export function hashFile(file) {
  return hashText(fs.readFileSync(file, 'utf8'));
}

/**
 * Tool discovery must succeed and find enough lockable base tools. A failed
 * dump-config (EPERM/EACCES/non-zero/empty) must abort before any model call;
 * silently continuing would generate patches with zero disabled tools.
 */
export function assessToolDiscovery({ status, stdout, stderr, ids } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const reasons = [];
  if (status !== 0) reasons.push(`dump-config exit ${status}`);
  if (list.length < 10) reasons.push(`found only ${list.length} lockable tools`);
  if (typeof stderr === 'string' && /EPERM|EACCES|permission denied/i.test(stderr)) reasons.push('dump-config denied by filesystem');
  return {
    valid: reasons.length === 0,
    ids: list,
    reasons,
  };
}

/**
 * Verify the frozen manifest before the first model request.
 * @param {object} manifest parsed eval/frozen-manifest.json
 * @param {{scenarioHash:string, rubricHashes:Record<string,string>, pluginVersion:string, runnerContract:string}} actual
 */
export function validateFrozenManifest(manifest, actual) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['missing or unreadable frozen manifest'] };
  if (manifest.harnessContract !== actual.runnerContract) {
    errors.push(`manifest contract ${manifest.harnessContract ?? '(none)'} != runner ${actual.runnerContract}`);
  }
  if (manifest.pluginVersion !== actual.pluginVersion) {
    errors.push(`manifest pluginVersion ${manifest.pluginVersion ?? '(none)'} != installed ${actual.pluginVersion}`);
  }
  if (actual.scenarioHashes && typeof actual.scenarioHashes === 'object') {
    const frozenFiles = manifest.scenarioFiles && typeof manifest.scenarioFiles === 'object' ? manifest.scenarioFiles : {};
    for (const [name, hash] of Object.entries(actual.scenarioHashes)) {
      if (frozenFiles[name] !== hash) errors.push(`scenario file ${name} changed since freeze; re-run node eval/freeze.mjs`);
    }
    for (const name of Object.keys(frozenFiles)) {
      if (!(name in actual.scenarioHashes)) errors.push(`frozen scenario file missing: ${name}`);
    }
  } else if (manifest.scenarioHash !== actual.scenarioHash) {
    errors.push('scenario file changed since freeze; re-run node eval/freeze.mjs');
  }
  for (const [name, hash] of Object.entries(actual.rubricHashes ?? {})) {
    if (manifest.rubrics?.[name] !== hash) errors.push(`rubric ${name} changed since freeze; re-run node eval/freeze.mjs`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Classify one test/condition outcome.
 *
 * - snapshot/dream validity failure => device invalid (excluded from comparisons)
 * - model call failure/timeout      => valid device, task failed
 * - judge missing/invalid JSON      => grading missing (excluded, queued for re-review)
 * - otherwise                       => scored and comparison eligible
 *
 * @param {{
 *   snapshotValid:boolean,
 *   dreamValid:boolean,
 *   modelOk:boolean,
 *   judgeMissing:boolean,
 *   deterministicOk:boolean,
 *   judged?:{taskCompleted?:boolean, boundaryFailure?:boolean, fabricatedHistory?:boolean}
 * }} input
 */
export function classifyTestOutcome({
  snapshotValid = true,
  dreamValid = true,
  modelOk = true,
  judgeMissing = false,
  deterministicOk = false,
  judged = null,
  // Judges flag headings and lists unprompted; that only counts when the task set a format.
  formatRequired = true,
} = {}) {
  const invalidReasons = [];
  if (!snapshotValid) invalidReasons.push('snapshot hash mismatch');
  if (!dreamValid) invalidReasons.push('Dream purity/result missing');
  if (invalidReasons.length > 0) {
    return {
      validity: 'invalid',
      comparisonEligible: false,
      failureKind: 'harness-invalid',
      success: false,
      reasons: invalidReasons,
    };
  }
  if (!modelOk) {
    return { validity: 'valid', comparisonEligible: true, failureKind: 'task-failed', success: false, reasons: ['model execution failed or timed out'] };
  }
  if (judgeMissing || !judged) {
    return { validity: 'valid', comparisonEligible: false, failureKind: 'grading-missing', success: false, reasons: ['judge unavailable or returned invalid JSON'] };
  }
  const success =
    deterministicOk === true &&
    judged.taskCompleted === true &&
    judged.boundaryFailure !== true &&
    judged.fabricatedHistory !== true &&
    (formatRequired !== true || judged.formatViolation !== true);
  return {
    validity: 'valid',
    comparisonEligible: true,
    failureKind: success ? null : 'task-failed',
    success,
    reasons: success ? [] : ['task requirements not met or boundary/fabrication flag'],
  };
}

/** Count device-invalid and grading-missing conditions for the run report. */
export function summarizeValidity(records) {
  const summary = { valid: 0, invalid: 0, gradingMissing: 0, taskFailed: 0, invalidReasons: [] };
  for (const run of records) {
    for (const test of Object.values(run.variants ?? {})) {
      for (const [condition, item] of Object.entries(test)) {
        if (!item || typeof item !== 'object') continue;
        const validity = item.validity ?? (item.failureKind === 'harness-invalid' ? 'invalid' : 'valid');
        if (validity === 'invalid') {
          summary.invalid += 1;
          for (const reason of item.reasons ?? []) summary.invalidReasons.push(`${run.scenario}/${condition}: ${reason}`);
        } else if (item.failureKind === 'grading-missing') summary.gradingMissing += 1;
        else if (item.failureKind === 'task-failed') summary.taskFailed += 1;
        else summary.valid += 1;
      }
    }
  }
  summary.invalidReasons = [...new Set(summary.invalidReasons)];
  return summary;
}

export function comparisonEligible(left, right) {
  return Boolean(left?.comparisonEligible && right?.comparisonEligible);
}
