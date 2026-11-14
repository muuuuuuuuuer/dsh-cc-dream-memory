/**
 * Plugin identity and health for upgrade-safe operation.
 *
 * Version comes from the package manifest (single source of truth). Health is a
 * best-effort diagnostic assembled defensively: every probe is isolated so a
 * broken data file, a missing optional Host service, or a failed dream report
 * becomes a warning the UI/status tool can show instead of an exception that
 * propagates into the Harness.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Data schema version written by `src/state.js`; readers tolerate older/missing. */
export const DATA_SCHEMA = 1;

function readPackageVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'));
    return parsed && typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Plugin version from `package.json`. */
export const VERSION = readPackageVersion();

/** Optional Host services whose absence degrades one capability only. */
const OPTIONAL_SERVICES = ['commands', 'agents', 'workingDirectory', 'webServer'];

/**
 * Build the health block returned by the HTTP status endpoint and
 * `memory_status`. Never throws.
 * @param {{runtime?:object, projectContext?:object, rules?:object}} input
 * @returns {Promise<{ok:boolean, warnings:string[], version:string, dataSchema:number, services:Record<string,boolean>}>}
 */
export async function buildHealth({ runtime, projectContext, rules } = {}) {
  const warnings = [];
  try {
    if (rules && rules.truncated === true) {
      warnings.push(`memory rules exceed the ${rules.maxChars}-character cap and are truncated`);
    }
  } catch {
    /* ignore probe failure */
  }
  try {
    const store = projectContext && projectContext.store;
    if (store) {
      const audit = await store.auditIndex('project');
      if (audit && Array.isArray(audit.missing) && audit.missing.length > 0) {
        warnings.push(`${audit.missing.length} memory file(s) are missing from MEMORY.md (run a dream to reconcile)`);
      }
      if (audit && Array.isArray(audit.dangling) && audit.dangling.length > 0) {
        warnings.push(`${audit.dangling.length} MEMORY.md line(s) point at missing files`);
      }
    }
  } catch (error) {
    warnings.push(`index audit failed: ${error?.message ?? error}`);
  }
  try {
    const snapshot = projectContext?.state?.snapshot() ?? {};
    if (snapshot && snapshot.lastError) warnings.push(`last dream failed: ${String(snapshot.lastError).slice(0, 200)}`);
    if (snapshot && snapshot.shadowPending) warnings.push('a dream result is waiting for the human to switch to it or discard it');
  } catch (error) {
    warnings.push(`state unreadable: ${error?.message ?? error}`);
  }
  try {
    runtime?.overrides();
  } catch (error) {
    warnings.push(`runtime overrides unreadable: ${error?.message ?? error}`);
  }
  const services = {};
  for (const name of OPTIONAL_SERVICES) {
    let present = false;
    try {
      const ctx = runtime && runtime.ctx;
      if (ctx && typeof ctx.get === 'function') present = Boolean(ctx.get(name));
    } catch {
      present = false;
    }
    services[name] = present;
    if (!present) warnings.push(`optional host service unavailable: ${name}`);
  }
  return {
    ok: warnings.length === 0,
    warnings,
    version: VERSION,
    dataSchema: DATA_SCHEMA,
    services,
  };
}

// v0.5.0: version is read from package.json at module load; reload picks it up.
// v0.6.0: bump triggers module re-import on plugin reload.
// v0.7.0: metrics/cost batch.
// v0.8.0: v9 P0 semantics (policy/identity/refresh/readiness/cost modes).
// v0.9.0: v10 P1 fixes (undo/edit/search/metrics/import-export/lock/digest).
// v0.10.0: v11 user six-step batch (undo safety/prompt/tools/http/secrets).
// v0.10.1: v12 review fixes (live config, confirm, rollback, lastPlan, session leak, history, user scope, prompt).
// v0.10.2: UI design frozen (client.js/locale/icon + .ui-freeze.json guard).
// v0.10.3: Dream rename (UI-FREEZE approved) + /bridge recovery + /dream command.
// v0.10.4: fix webserver prefix route (no trailing slash); async /bridge recovery (UI-FREEZE approved: Dream availability).
// v0.10.5: eval harness (eval/) + eval-only memory_eval_dream (evalMode default false).
// v0.10.6: eval isolation/snapshot fixes + noSessions pure-dream + harness assertions/frozen manifest.
// v0.10.7: eval run gates (manifest/tool discovery), validity classification, scoring format/boundary distinction.
// v0.10.8: Dream input filters injected context, reads tools, adds processed-session watermark; experimental positioning.
// v0.10.9: worktree shared memory, official budget 200/25KB + tail injection, subagent default off, rename, write-quality rule.
// v0.10.10: tool-output marker escaping, seq watermark + undo/apply-ops safety, dedup/error tool evidence, probe fix, 96k fair budget, docs/private corrections.
// v0.10.11: byte-budget head+tail whole lines, commondir worktree identity, atomic rename+content, pending name fix, eval B0 control + open-tool coding scenarios.
// v0.10.12: escape assistant/tool-call transcript text too, prune probes before minSessions gate, over-budget warning names the human path.
// v0.10.13: chronological paired tool evidence, corpus watermark persistence + seq reload, recent-user tail guard, docs/eval path cleanup.
// v0.10.14: all-scenario frozen manifest, open-tool temp git workspaces + objective checks, memory-convention and dream-session scenarios, git identity/budget notice fixes.
// v0.11.0: Dream reads whole sessions (chunked analysis, verified quotes, watermarks moved only on apply) with an evidence gate; lexical auto recall, memory_update delete, staleness hints.
// v0.12.0: Dream v2 pipeline (per-session analyzer, host verifier, organizer, coverage), wiki-lite memory pages, knowledge-wiki corpus build and read-only wiki query tools.
