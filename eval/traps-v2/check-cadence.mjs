#!/usr/bin/env node
/**
 * No-model check of LME_EXTRACT_EVERY_TURNS wiring: runs the plugin's real runAutoExtract against
 * makeHost with a fake llm that answers DONE and records the transcript it was shown. Prints, per
 * extraction run, the visible seq limit and the user messages in the window; asserts the cadence
 * slicing (groups of N user turns, one chunk per run, final tail run) and that without a limit the
 * session is one run. Exit code 1 on a mismatch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRuntime } from '../../src/runtime.js';
import { resolveConfig } from '../../src/config.js';
import { runAutoExtract } from '../../src/auto-extract.js';
import { registerTools } from '../../src/tools.js';
import { extractLimits, makeHost, sessionsOf } from '../longmemeval/lme-lib.mjs';

const data = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'traps.json'), 'utf8'));
const item = data.find((q) => q.question_id === 'v2_wa_01');
const sessions = sessionsOf(item, 'C:/tmp/x').filter((s) => s.id.endsWith('-s3')); // the long session: 5 user turns
let failed = 0;
const expect = (ok, message) => { if (!ok) { failed += 1; console.log('FAIL', message); } };

async function replay(every) {
  const seen = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-'));
  const host = makeHost({ workspaceDir: dir, sessions });
  host.services.llm = { stream: (request) => (async function* fake() {
    const prompt = request.messages.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n');
    seen.push(prompt.split('<transcript>')[1]?.split('</transcript>')[0] ?? '');
    yield { type: 'text-delta', text: 'DONE' };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })() };
  const config = resolveConfig({ memoryRoot: path.join(dir, 'mem'), projectId: 'p', userMemory: 'project', autoExtract: true, autoMemoryEnabled: true, autoDreamEnabled: false });
  const runtime = new MemoryRuntime(host, config);
  registerTools(host, runtime);
  const pctx = await runtime.storeFor(dir);
  const session = sessions[0];
  const runs = [];
  const limits = every > 0 ? extractLimits(session.events, every) : [Infinity];
  for (const limit of limits) {
    if (every > 0) host.visibleSeq.set(session.id, limit);
    const before = seen.length;
    const result = await runAutoExtract({ runtime, pctx, sessionId: session.id, agent: { id: session.id }, trigger: 'eval' });
    runs.push({ limit, called: seen.length - before, reason: result.reason ?? (result.ok ? 'ok' : ''), text: seen.at(-1) ?? '' });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { runs, users: session.events.filter((e) => e.type === 'user/message').length };
}

const cadence = await replay(3);
console.log(`session ${sessions[0].id}: ${cadence.users} user turns, ${sessions[0].events.length} events, limits ${JSON.stringify(extractLimits(sessions[0].events, 3))}`);
cadence.runs.forEach((run, i) => console.log(`  run ${i + 1}: visible seq <= ${run.limit}, model called ${run.called}x, user messages shown: ${(run.text.match(/^\[user(-pasted)?\]/gmu) ?? []).length}, ${run.text.length} chars, result ${run.reason}`));
expect(cadence.users === 5, 'expected 5 user turns in the long session');
expect(cadence.runs.length === 2, `cadence 3 over 5 turns must run twice (3 + tail), got ${cadence.runs.length}`);
expect(cadence.runs.every((r) => r.called === 1), 'each run calls the model once (one chunk per run)');
expect((cadence.runs[0].text.match(/^\[user(-pasted)?\]/gmu) ?? []).length === 3, 'run 1 shows exactly the first 3 user turns');
expect(/reconcile-daily/u.test(cadence.runs[0].text) && !/刚才那个方案作废/u.test(cadence.runs[0].text), 'run 1 holds the decision and not the retraction');
expect(!/reconcile-daily 不再用系统 cron/u.test(cadence.runs[1].text) && /刚才那个方案作废/u.test(cadence.runs[1].text), 'run 2 holds the retraction and not the decision');
expect(extractLimits(sessions[0].events, 0).length === 0, 'unset / 0 gives no limits');

const whole = await replay(0);
console.log(`default (unset): ${whole.runs.length} run(s) over the whole session, ${whole.runs[0].text.length} chars in the first window`);
expect(/reconcile-daily/u.test(whole.runs[0].text), 'default run 1 starts from the beginning');
console.log(failed ? `${failed} check(s) failed` : 'cadence wiring ok');
process.exitCode = failed ? 1 : 0;
