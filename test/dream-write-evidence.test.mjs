import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, checkWriteOperations } from '../src/dream-write-evidence.js';

const ANALYSES = [{
  sessionId: 's1',
  summary: 'route rule',
  claims: [
    {
      text: '路由改动后要经过真实入口验证',
      quote: '路由改动后要经过真实入口验证',
      source: 'user',
      date: '2026-11-11',
      seq: 1,
      kind: 'feedback',
      confidence: 'high',
    },
  ],
  patches: [],
  verify: [],
}, {
  sessionId: 's2',
  summary: 'forwarded note',
  claims: [
    {
      text: '转发材料说路由改动要加测试',
      quote: '转发材料说路由改动要加测试',
      source: 'user-pasted',
      date: '2026-11-11',
      seq: 1,
      kind: 'reference',
      confidence: 'medium',
    },
  ],
  patches: [],
  verify: [],
}];

test('final write gate accepts a change backed by a [user] claim', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'feedback',
      file: 'feedback_route_testing.md',
      name: 'Route testing',
      description: 'Verify routes through a real entry point',
      body: '- 路由改动后要经过真实入口验证。 ^[s1#1, 2026-11-11]',
    }],
  });
  assert.deepEqual(result.dropped, []);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].evidence[0].quote, '路由改动后要经过真实入口验证');
});

test('final write gate rejects a user attribution taken only from forwarded material', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'user',
      file: 'user_route_testing.md',
      name: 'Route testing preference',
      description: 'Route testing',
      body: '- 转发材料说路由改动要加测试。 ^[s2#1, 2026-11-11]',
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /no \[user\] claim|forwarded/);
});

test('final write gate requires the citation locator and date to match the claim', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'feedback',
      file: 'feedback_route.md',
      name: 'Route',
      description: 'Route',
      body: '- 路由改动后要经过真实入口验证。 ^[s1#99999, 1900-01-01]',
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /does not match any verified claim/);
});

test('final write gate rejects user attribution on a project page when only forwarded material exists', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'project',
      file: 'project_route.md',
      name: 'Route',
      description: 'Route',
      body: '- 用户明确要求：转发材料说路由改动要加测试。 ^[s2#1, 2026-11-11]',
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /attributes a requirement to the user/);
});

test('existing-line exemption requires exact text and the same page type', () => {
  const evidence = buildEvidence([{
    sessionId: 's1',
    summary: 'timeout',
    claims: [{
      text: '发布检查超时为 1.5 秒',
      quote: '发布检查超时为 1.5 秒',
      source: 'user',
      date: '2026-11-11',
      seq: 1,
    }],
    patches: [],
    verify: [],
  }]);
  const current = [{
    file: 'project_release.md',
    type: 'project',
    body: '- 发布检查超时为 1.5 秒。 ^[s1#1, 2026-11-11]',
  }];
  const changedNumber = checkWriteOperations({
    currentPages: current,
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_release.md',
      name: 'Release', description: 'Release',
      body: '- 发布检查超时为 15 秒。 ^[s1#1, 2026-11-11]',
    }],
  });
  assert.equal(changedNumber.operations.length, 0, '1.5 -> 15 must not reuse the old line');
  const exactSameType = checkWriteOperations({
    currentPages: current,
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_release_copy.md',
      name: 'Release copy', description: 'Release',
      body: '- 发布检查超时为 1.5 秒。 ^[s1#1, 2026-11-11]',
    }],
  });
  assert.equal(exactSameType.operations.length, 1, 'an exact same-type move is allowed');
  const feedbackToProject = checkWriteOperations({
    currentPages: [{ file: 'feedback_release.md', type: 'feedback', body: '- 发布检查超时为 1.5 秒。 ^[s1#1, 2026-11-11]' }],
    evidence: [],
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_release_moved.md',
      name: 'Release moved', description: 'Release',
      body: '- 发布检查超时为 1.5 秒。 ^[s1#1, 2026-11-11]',
    }],
  });
  assert.equal(feedbackToProject.operations.length, 0, 'a feedback line cannot become project without evidence');
});

test('final write gate allows dated verification metadata but not unverified text behind it', () => {
  const evidence = buildEvidence(ANALYSES);
  const accepted = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'feedback', file: 'feedback_route.md',
      name: 'Route', description: 'Route',
      body: [
        'STATUS: current',
        'VERIFIED: 2026-11-11',
        'USER CONFIRMED: 2026-11-11',
        '- 路由改动后要经过真实入口验证。 ^[s1#1, 2026-11-11]',
      ].join('\n'),
    }],
  });
  assert.equal(accepted.operations.length, 1);
  const rejected = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_route.md',
      name: 'Route', description: 'Route',
      body: 'VERIFIED: 发布检查已经取消',
    }],
  });
  assert.equal(rejected.operations.length, 0);
});

test('a stale page cannot be promoted back to current with typed metadata only', () => {
  const evidence = buildEvidence(ANALYSES);
  const promoted = checkWriteOperations({
    currentPages: [{ file: 'project_old.md', type: 'project', body: 'STATUS: stale\n- 旧事实。 ^[s0#1, 2026-11-01]' }],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_old.md',
      name: 'Old', description: 'Old',
      body: 'STATUS: current\nVERIFIED: 2026-11-11\n- 旧事实。 ^[s0#1, 2026-11-01]',
    }],
  });
  assert.equal(promoted.operations.length, 0, 'adding STATUS: current + VERIFIED must not revive a stale page');
  assert.match(promoted.dropped.join(';'), /STATUS: current needs a verified claim/);

  const demoted = checkWriteOperations({
    currentPages: [{ file: 'project_old.md', type: 'project', body: 'STATUS: current\n- 旧事实。 ^[s0#1, 2026-11-01]' }],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'project', file: 'project_old.md',
      name: 'Old', description: 'Old',
      body: 'STATUS: stale\n- 旧事实。 ^[s0#1, 2026-11-01]',
    }],
  });
  assert.equal(demoted.operations.length, 1, 'demoting a page needs no fresh evidence');
});

test('final write gate allows non-factual applicability metadata lines when cited', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'feedback',
      file: 'feedback_route.md',
      name: 'Route',
      description: 'Route',
      body: [
        'APPLIES WHEN: 路由改动后要经过真实入口验证 ^[s1#1, 2026-11-11]',
        'VERIFY: 路由改动后要经过真实入口验证 ^[s1#1, 2026-11-11]',
        'OBSERVED: 路由改动后要经过真实入口验证 ^[s1#1, 2026-11-11]',
        'EXCEPTION: 路由改动后要经过真实入口验证 ^[s1#1, 2026-11-11]',
        'STATUS: current',
        '- 路由改动后要经过真实入口验证。 ^[s1#1, 2026-11-11]',
      ].join('\n'),
    }],
  });
  assert.deepEqual(result.dropped, []);
  assert.equal(result.operations.length, 1);
});

test('final write gate rejects a metadata label used as a fact shortcut', () => {
  const evidence = buildEvidence(ANALYSES);
  for (const body of ['STATUS: 发布检查已经取消', 'EXCEPTION: 发布检查已经取消']) {
    const result = checkWriteOperations({
      currentPages: [],
      evidence,
      operations: [{
        op: 'write', scope: 'project', type: 'project', file: 'project_release.md',
        name: 'Release', description: 'Release', body,
      }],
    });
    assert.equal(result.operations.length, 0, body);
    assert.match(result.dropped.join(';'), /no source citation|not supported/);
  }
});

test('final write gate refuses a project line moved into a feedback page without [user] evidence', () => {
  const evidence = buildEvidence([{
    sessionId: 's2', summary: 'forwarded', claims: [{
      text: '转发材料说路由改动要加测试', quote: '转发材料说路由改动要加测试',
      source: 'user-pasted', date: '2026-11-11', seq: 1,
    }], patches: [], verify: [],
  }]);
  const line = '- 转发材料说路由改动要加测试。 ^[s2#1, 2026-11-11]';
  const result = checkWriteOperations({
    currentPages: [{ file: 'project_route.md', type: 'project', body: line }],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'feedback', file: 'feedback_route.md',
      name: 'Route', description: 'Route', body: line,
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /no \[user\] claim/);
});

test('final write gate refuses a body-unchanged page type change to feedback', () => {
  const evidence = buildEvidence([]);
  const line = '- 转发材料说路由改动要加测试。 ^[s2#1, 2026-11-11]';
  const result = checkWriteOperations({
    currentPages: [{ file: 'project_route.md', type: 'project', body: line }],
    evidence,
    operations: [{
      op: 'write', scope: 'project', type: 'feedback', file: 'project_route.md',
      name: 'Route', description: 'Route', body: line,
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /does not match any verified claim/);
});

test('final write gate refuses a user-attribution index description without [user] evidence', () => {
  const evidence = buildEvidence(ANALYSES);
  const result = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'index',
      scope: 'project',
      content: '- [Rules](feedback_rules.md) — 用户明确要求以后跳过所有测试\n',
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.match(result.dropped.join(';'), /index: description attributes/);
});

test('final write gate rejects an uncited added fact and accepts an unchanged body', () => {
  const evidence = buildEvidence(ANALYSES);
  const uncited = checkWriteOperations({
    currentPages: [],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'project',
      file: 'project_route.md',
      name: 'Route',
      description: 'Route',
      body: '- 一个新事实，但没有引用。',
    }],
  });
  assert.equal(uncited.operations.length, 0);
  assert.match(uncited.dropped.join(';'), /no source citation/);
  const unchanged = checkWriteOperations({
    currentPages: [{ file: 'project_route.md', type: 'project', body: '- old fact ^[s1#1, 2026-11-11]' }],
    evidence,
    operations: [{
      op: 'write',
      scope: 'project',
      type: 'project',
      file: 'project_route.md',
      name: 'Route',
      description: 'Route',
      body: '- old fact ^[s1#1, 2026-11-11]',
    }],
  });
  assert.equal(unchanged.operations.length, 1);
  assert.deepEqual(unchanged.dropped, []);
});
