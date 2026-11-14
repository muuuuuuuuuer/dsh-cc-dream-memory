import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './v10-helpers.mjs';
import { gatherDreamInput } from '../src/dream-input.js';

test('v16 watermark: read records move it; apply-ops and probes do not', async (t) => {
  const env = await makeEnv(t);
  const state = env.state;
  await state.ensureSession('full', 1);
  await state.ensureSession('partial', 2);
  await state.clearSessions(['full', 'partial'], {
    reads: [
      { id: 'full', seq: 10, complete: true },
      { id: 'partial', seq: 20, complete: false },
    ],
  });
  let snapshot = state.snapshot();
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.deepEqual(
    snapshot.dreamProcessedSessions.map((entry) => [entry.id, entry.seq, entry.partial === true]),
    [['full', 10, false], ['partial', 20, true]],
  );

  // undo restores the batch's sessions
  await state.restoreDreamProcessed(['full', 'partial']);
  snapshot = state.snapshot();
  assert.deepEqual(snapshot.dreamProcessedSessions, [], 'undo removes the watermark');

  // a partial apply carries no read records, so nothing is skipped later
  await state.ensureSession('partial-apply', 3);
  await state.clearSessions(['partial-apply']);
  snapshot = state.snapshot();
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.deepEqual(snapshot.dreamProcessedSessions, [], 'apply-ops must not watermark sessions');

  // probes are forgotten, never counted as processed
  await state.ensureSession('probe', 4);
  await state.dropSessions(['probe']);
  snapshot = state.snapshot();
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.deepEqual(snapshot.dreamProcessedSessions, []);
});

test('v16 budget: 8 long sessions share the total dream input budget instead of only 4 being read', async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `s-${index}`);
  const text = '这是一个足够长的用户发言，用于测试总预算公平分配。'.repeat(400);
  const sessionQuery = {
    async filterSessions() {
      return ids.map((id, index) => ({ header: { id, createdAt: index } }));
    },
    async readSession(id) {
      return {
        session: { id, createdAt: 1 },
        events: [{ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }],
      };
    },
  };
  const state = { snapshot: () => ({ sessionsSince: ids.map((id) => ({ id, at: 1 })) }) };
  const store = { indexText: async () => '', listEntries: async () => [] };
  const input = await gatherDreamInput({
    ctx: { get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined) },
    store,
    config: {
      dreamInputMaxChars: 96_000,
      dreamMaxFileChars: 20_000,
    },
    workspaceDir: 'C:/workspace',
    state,
  });
  assert.equal(input.sessions.length, 8, 'all candidates must be read, not only the first four');
  assert.ok(input.chars <= 96_000);
  assert.ok(input.sessions.every((session) => session.chunks.length > 0));
});
