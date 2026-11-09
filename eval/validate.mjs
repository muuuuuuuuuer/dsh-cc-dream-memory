#!/usr/bin/env node
/**
 * Validate the paired A/B/C evaluation assets without running a model.
 *
 *   node eval/validate.mjs            # schema + leakage checks + checkpoint plan
 *   node eval/validate.mjs --json     # machine-readable summary
 *
 * The validator is intentionally model-free: it proves the scenario pack,
 * checkpoints, and rubric shape are ready before any paid run starts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_FILE = path.join(ROOT, 'eval', 'scenarios.dev.json');
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;

function fail(errors, message) {
  errors.push(message);
}

function checkRubric(errors, where, rubric) {
  if (!rubric || typeof rubric !== 'object') return fail(errors, `${where}: rubric is required`);
  for (const field of ['requiredFacts', 'forbiddenFacts', 'deterministic', 'semantic', 'boundaryFailures']) {
    if (!Array.isArray(rubric[field])) fail(errors, `${where}: rubric.${field} must be an array`);
  }
  if (!['required', 'optional', 'forbidden'].includes(rubric.clarification)) {
    fail(errors, `${where}: rubric.clarification must be required|optional|forbidden`);
  }
  for (const [index, check] of (rubric.deterministic ?? []).entries()) {
    if (!check || typeof check !== 'object') { fail(errors, `${where}: deterministic[${index}] must be an object`); continue; }
    if (!['includes', 'notIncludes', 'regex', 'notMatches', 'maxLines'].includes(check.kind)) {
      fail(errors, `${where}: deterministic[${index}].kind is unknown (${check.kind})`);
    }
    if (check.kind !== 'maxLines' && (typeof check.value !== 'string' || check.value.length === 0)) {
      fail(errors, `${where}: deterministic[${index}].value is required`);
    }
    if (typeof check.label !== 'string' || check.label.length === 0) fail(errors, `${where}: deterministic[${index}].label is required`);
  }
}

function run() {
  const errors = [];
  const warnings = [];
  const raw = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));
  if (raw.version !== 1) fail(errors, 'scenarios.version must be 1');
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length !== 6) {
    fail(errors, `scenarios.scenarios must contain exactly 6 development scenarios (got ${raw.scenarios?.length ?? 0})`);
  }
  const ids = new Set();
  const sessions = [];
  for (const [index, scenario] of (raw.scenarios ?? []).entries()) {
    const where = `scenarios[${index}]`;
    if (!ID_PATTERN.test(scenario.id ?? '')) fail(errors, `${where}: invalid id ${JSON.stringify(scenario.id)}`);
    if (ids.has(scenario.id)) fail(errors, `${where}: duplicate id ${scenario.id}`);
    ids.add(scenario.id);
    if (typeof scenario.type !== 'string' || scenario.type === '') fail(errors, `${where}: type is required`);
    if (typeof scenario.title !== 'string' || scenario.title === '') fail(errors, `${where}: title is required`);
    if (!Array.isArray(scenario.history) || scenario.history.length === 0) fail(errors, `${where}: history is required`);
    for (const [historyIndex, session] of (scenario.history ?? []).entries()) {
      const sessionWhere = `${where}.history[${historyIndex}]`;
      if (typeof session.id !== 'string' || session.id === '') fail(errors, `${sessionWhere}: id is required`);
      if (!Array.isArray(session.messages) || session.messages.length === 0) fail(errors, `${sessionWhere}: messages are required`);
      for (const message of session.messages ?? []) {
        if (typeof message !== 'string' || message.length < 2) fail(errors, `${sessionWhere}: messages must be non-empty strings`);
        if (/test|评估|rubric|必须包含|不得包含/i.test(message)) warnings.push(`${sessionWhere}: message may leak evaluator words: ${message.slice(0, 40)}`);
      }
      sessions.push({ scenarioId: scenario.id, sessionId: session.id, messages: session.messages.length });
    }
    if (!scenario.test || typeof scenario.test.task !== 'string' || scenario.test.task === '') {
      fail(errors, `${where}: test.task is required`);
    }
    checkRubric(errors, `${where}.test`, scenario.test?.rubric);
    for (const [variantIndex, variant] of (scenario.test?.variants ?? []).entries()) {
      const variantWhere = `${where}.test.variants[${variantIndex}]`;
      if (typeof variant.id !== 'string' || variant.id === '') fail(errors, `${variantWhere}: id is required`);
      if (typeof variant.task !== 'string' || variant.task === '') fail(errors, `${variantWhere}: task is required`);
      if (variant.rubricOverride) checkRubric(errors, `${variantWhere}`, variant.rubricOverride);
    }
  }
  const summary = {
    ok: errors.length === 0,
    scenarios: raw.scenarios?.length ?? 0,
    historySessions: sessions.length,
    variants: (raw.scenarios ?? []).reduce((count, scenario) => count + (scenario.test?.variants?.length ?? 0), 0),
    conditions: ['A:no-memory', 'B:memory-no-dream', 'C:memory-after-dream'],
    checkpoints: (raw.scenarios ?? []).map((scenario) => ({
      id: scenario.id,
      history: scenario.history.map((session) => session.id),
      testTask: scenario.test.task,
      variants: (scenario.test.variants ?? []).map((variant) => variant.id),
    })),
    warnings,
    errors,
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`scenarios: ${summary.scenarios} | history sessions: ${summary.historySessions} | variants: ${summary.variants}`);
    for (const checkpoint of summary.checkpoints) {
      console.log(`  - ${checkpoint.id}: history ${checkpoint.history.join(',')} -> test (${checkpoint.testTask.slice(0, 36)}…)${checkpoint.variants.length ? ` [variant: ${checkpoint.variants.join(',')}]` : ''}`);
    }
    for (const warning of warnings) console.log(`  WARN ${warning}`);
    for (const error of errors) console.log(`  ERROR ${error}`);
    console.log(errors.length === 0 ? 'RESULT: PASS (dry-run ready; no model was called)' : 'RESULT: FAIL');
  }
  process.exitCode = errors.length === 0 ? 0 : 1;
}

run();
