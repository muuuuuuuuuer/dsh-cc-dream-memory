/**
 * Dream gathering is a pure read: a dry run must not change which sessions count
 * as pending or processed. Every session arrives as ordered chunks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gatherDreamInput } from '../src/dream-input.js';
import { DEFAULTS } from '../src/config.js';
import { makeEnv } from './v10-helpers.mjs';

const TIME = Date.parse('2026-11-08T15:00:00Z');
const turn = (seq, text) => ({
  type: 'user/message',
  seq,
  time: TIME,
  data: { role: 'user', id: `u${seq}`, content: [{ type: 'text', text }], source: { kind: 'user' } },
});
const reply = (seq, text) => ({
  type: 'assistant/message',
  seq,
  time: TIME,
  data: { message: { content: [{ type: 'text', text }] } },
});
const record = (id, createdAt = 1) => ({ header: { id, createdAt } });
const textOf = (session) => session.chunks.map((chunk) => chunk.text).join('\n');

function gather(state, sessions, { records = [], config = {}, store = null } = {}) {
  const sessionQuery = {
    readSession: async (id) => ({ session: { id, createdAt: 1 }, events: sessions[id] }),
    filterSessions: async () => records,
  };
  return gatherDreamInput({
    ctx: { get: (name) => (name === 'sessionQuery' ? sessionQuery : undefined) },
    store,
    config: { ...DEFAULTS, ...config },
    workspaceDir: 'C:/workspace',
    state,
  });
}

/** A session longer than one transport chunk. */
const longSession = () => {
  const events = [turn(1, '帮我梳理部署方案')];
  for (let seq = 2; seq <= 40; seq += 1) events.push(reply(seq, `第${seq}段${'过程'.repeat(600)}`));
  return events;
};

test('gathering changes nothing in state, on disk or in memory', async (t) => {
  const env = await makeEnv(t);
  await env.state.ensureSession('active', 1);
  await env.state.ensureSession('probe', 2);
  const sessions = {
    active: [turn(1, 'a real request'), reply(2, 'done')],
    old: [turn(1, 'an older real request'), reply(2, 'done')],
    probe: [turn(1, 'Reply with exactly: OK'), reply(2, 'OK')],
  };
  const before = JSON.stringify(env.state.snapshot());
  const diskBefore = await readFile(env.paths.stateFile, 'utf8').catch(() => '');
  const input = await gather(env.state, sessions, { records: [record('old')] });
  assert.deepEqual(input.sessions.map((session) => session.id).sort(), ['active', 'old']);
  assert.equal(JSON.stringify(env.state.snapshot()), before);
  assert.equal(await readFile(env.paths.stateFile, 'utf8').catch(() => ''), diskBefore);
  assert.deepEqual(input.droppedSessions, ['probe'], 'a probe is reported, and dropped only by an apply');
});

test('a short session arrives as one chunk with its last sequence number', async (t) => {
  const env = await makeEnv(t);
  await env.state.ensureSession('short', 1);
  const input = await gather(env.state, { short: [turn(4, 'short request'), reply(9, 'short reply')] });
  const [session] = input.sessions;
  assert.equal(session.chunks.length, 1);
  assert.ok(textOf(session).includes('[user] short request') && textOf(session).includes('[assistant] short reply'));
  assert.equal(session.maxSeq, 9);
});

test('a long session is never sampled: it arrives as ordered chunks covering all of it', async (t) => {
  const env = await makeEnv(t);
  await env.state.ensureSession('long', 1);
  const input = await gather(env.state, { long: longSession() }, { config: { dreamMapChunkChars: 6000 } });
  const [session] = input.sessions;
  assert.ok(session.chunks.length > 1);
  const joined = textOf(session);
  for (const marker of ['第2段', '第20段', '第40段']) assert.ok(joined.includes(marker), `${marker} is covered`);
});

test('a watermark limits reading to new events, and a partial one keeps the session eligible', async (t) => {
  const env = await makeEnv(t);
  const sessions = {
    finished: [turn(1, 'FINISHED_OLD'), reply(2, 'ack')],
    partial: [turn(1, 'PARTIAL_OLD'), reply(2, 'ack'), turn(3, 'PARTIAL_NEW'), reply(4, 'ack new')],
    resumed: [turn(1, 'RESUMED_OLD'), reply(2, 'ack'), turn(3, 'RESUMED_NEW'), reply(4, 'ack new')],
  };
  await env.state.ensureSession('finished', 1);
  await env.state.ensureSession('partial', 1);
  await env.state.ensureSession('resumed', 1);
  await env.state.clearSessions(['finished', 'partial', 'resumed'], {
    reads: [
      { id: 'finished', seq: 2, complete: true },
      { id: 'partial', seq: 2, complete: false },
      { id: 'resumed', seq: 2, complete: true },
    ],
  });
  await env.state.ensureSession('resumed', 2); // the user continued this one
  const input = await gather(env.state, sessions, { records: [record('finished'), record('partial'), record('resumed')] });
  const text = Object.fromEntries(input.sessions.map((session) => [session.id, textOf(session)]));
  assert.equal(text.finished, undefined, 'a fully read session with no new activity is skipped');
  assert.ok(text.partial.includes('PARTIAL_NEW') && !text.partial.includes('PARTIAL_OLD'));
  assert.ok(text.resumed.includes('RESUMED_NEW') && !text.resumed.includes('RESUMED_OLD'));
});

test('a watermark survives a state reload', async (t) => {
  const env = await makeEnv(t);
  await env.state.ensureSession('a', 1);
  await env.state.clearSessions(['a'], { reads: [{ id: 'a', seq: 10, complete: false }] });
  await env.state.ensureSession('other', 2);
  const { ProjectState } = env.mods.state;
  const reloaded = new ProjectState(env.paths);
  await reloaded.load();
  const [entry] = reloaded.snapshot().dreamProcessedSessions;
  assert.equal(entry.id, 'a');
  assert.equal(entry.seq, 10);
  assert.equal(entry.partial, true);
});

test('sessions that do not fit the budget are deferred whole, not cut', async (t) => {
  const env = await makeEnv(t);
  const sessions = {};
  for (let i = 1; i <= 4; i += 1) {
    await env.state.ensureSession(`s${i}`, i);
    sessions[`s${i}`] = [turn(1, `请求${i}`), reply(2, `回复${i}${'内容'.repeat(1400)}`)];
  }
  const input = await gather(env.state, sessions, { config: { dreamInputMaxChars: 8000 } });
  assert.deepEqual(input.sessions.map((session) => session.id), ['s1', 's2'], 'a third 2.8k session would pass the 8k budget');
  assert.ok(input.sessions.every((session) => !textOf(session).includes('...[truncated]...')));
  assert.deepEqual(input.deferredSessions, ['s3', 's4'], 'deferred sessions wait for the next pass');
  assert.equal(input.truncated, true);
});

test('clearing sessions without read records moves no watermark', async (t) => {
  const env = await makeEnv(t);
  await env.state.ensureSession('a', 1);
  await env.state.clearSessions(['a']);
  const snapshot = env.state.snapshot();
  assert.deepEqual(snapshot.sessionsSince, []);
  assert.deepEqual(snapshot.dreamProcessedSessions, [], 'without read records the session stays re-readable');
});
