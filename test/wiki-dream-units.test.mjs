import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyzerPrompt, parseAnalyzerReply } from '../src/dream-analyzer.js';
import { verifyAnalysis } from '../src/dream-verifier.js';
import { contradictsClaim, supportConflict, supportsStatement } from '../src/support.js';

const TRANSCRIPT = [
  '--- 2026-11-08 ---',
  '[user] 以后测试一律先跑 FOO=1 make test',
  '[assistant] 好的',
  '[tool-call] bash: FOO=1 make test',
  '[tool-result] 3 tests passed',
].join('\n');

test('analyzer prompt and reply are normalized', () => {
  const prompt = buildAnalyzerPrompt({
    sessionId: 's1',
    transcript: TRANSCRIPT,
    memoryPages: [{ file: 'project_testing.md', body: 'old fact' }],
    focus: 'testing',
  });
  assert.match(prompt, /Session: s1/);
  assert.match(prompt, /FOO=1/);
  const parsed = parseAnalyzerReply(JSON.stringify({
    summary: 'testing changed',
    claims: [{ text: 'Tests need FOO=1', quote: 'FOO=1 make test', kind: 'command', confidence: 'high', target: 'project_testing.md' }],
    patches: [{ file: 'project_testing.md', op: 'append', content: '- Tests need FOO=1', evidence: ['FOO=1 make test'] }],
    verify: [{ file: 'project_testing.md', claim: 'old fact', result: 'contradicts', quote: 'FOO=1 make test' }],
  }));
  assert.equal(parsed.claims.length, 1);
  assert.equal(parsed.patches.length, 1);
});

test('verifier drops claims without a transcript quote and keeps real ones', () => {
  const result = verifyAnalysis({
    transcript: TRANSCRIPT,
    sessionId: 's1',
    memoryFiles: [{ file: 'project_testing.md', body: 'old fact' }],
    analysis: {
      summary: 's',
      claims: [
        { text: 'Tests need FOO=1', quote: 'FOO=1 make test', kind: 'command', confidence: 'high' },
        { text: 'invented', quote: 'not in transcript', kind: 'fact' },
      ],
      patches: [
        { file: 'project_testing.md', op: 'append', content: '- Tests need FOO=1', evidence: ['FOO=1 make test'] },
        { file: '../bad.md', op: 'append', content: 'x' },
      ],
      verify: [
        { file: 'project_testing.md', claim: 'old fact', result: 'contradicts', quote: 'FOO=1 make test' },
        { file: 'project_testing.md', claim: 'Tests need FOO=1', result: 'holds', quote: 'FOO=1 make test' },
      ],
    },
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].source, 'user');
  assert.equal(result.claims[0].date, '2026-11-08');
  assert.equal(result.patches.length, 1);
  assert.equal(result.verify[0].result, 'unknown', 'a quote about something else cannot refute the claim');
  assert.equal(result.verify[1].result, 'holds');
  assert.equal(result.dropped.length, 2);
});

test('a verdict without a located quote cannot confirm anything', () => {
  const result = verifyAnalysis({
    transcript: '',
    sessionId: 's1',
    memoryFiles: [{ file: 'project_testing.md', body: 'old fact' }],
    analysis: {
      summary: 's',
      claims: [],
      patches: [],
      verify: [{ file: 'project_testing.md', claim: 'old fact', result: 'holds' }],
    },
  });
  assert.equal(result.verify.length, 1);
  assert.equal(result.verify[0].result, 'unknown', 'an empty transcript cannot produce holds');
  assert.equal(result.verify[0].source, undefined);
  assert.match(result.warnings.join(' '), /downgraded to unknown/);
});

test('a quote that states a different quantity cannot confirm the claim', () => {
  const result = verifyAnalysis({
    transcript: ['--- 2026-11-08 ---', '[user] The timeout is 90 seconds.', '[assistant] noted'].join('\n'),
    sessionId: 's1',
    memoryFiles: [{ file: 'project_ops.md', body: 'old fact' }],
    analysis: {
      summary: 's',
      claims: [],
      patches: [],
      verify: [{ file: 'project_ops.md', claim: 'Timeout is 15 seconds', result: 'holds', quote: 'The timeout is 90 seconds.' }],
    },
  });
  assert.equal(result.verify[0].result, 'unknown', 'a different value cannot confirm the claim');
});

test('a condition or a quantity keeps the object it modifies', () => {
  assert.equal(supportConflict('Deploy only if tests fail.', 'Deploy only if tests pass.'), 'condition');
  assert.equal(supportsStatement('Deploy only if tests fail.', 'Deploy only if tests pass.'), false);
  assert.equal(supportsStatement('Deploy only if tests fail.', 'Deploy only if tests fail and the owner approves.'), false,
    'a narrower condition needs its own approval');
  assert.equal(supportsStatement('Use YAML only if client and owner agree.', 'Use YAML only if client and owner agree.'), true);
  assert.equal(supportsStatement('Use YAML only if client agrees.', 'Use YAML only if client and owner agree.'), false);
  assert.equal(supportConflict('Deploy only if tests fail.', 'Deploy unless tests fail.'), 'condition');

  assert.equal(supportConflict('The read timeout is 15 seconds.', 'The write timeout is 90 seconds.'), 'quantity');
  assert.equal(supportsStatement('The read timeout is 15 seconds.', 'The write timeout is 90 seconds.'), false);
  assert.equal(supportsStatement('The read timeout is 15 seconds.', 'The read timeout is 15 s.'), true);
  assert.equal(supportsStatement('The index budget is 8KB.', 'The index budget is 8 KB.'), true);

  assert.equal(contradictsClaim('Deployment timeout is 15 seconds', 'Deployment timeout is 90 seconds.'), true);
  assert.equal(contradictsClaim('Index budget is 8KB', 'I found no related information.'), false);
});

test('a CJK quantity keeps its unit and its object', () => {
  assert.equal(supportsStatement('读超时是 15 秒。', '读超时是 15 s。'), true, 'the unit is the same word');
  assert.equal(supportConflict('读超时是 15 秒。', '写超时是 15 秒。'), 'quantity');
  assert.equal(supportsStatement('读超时是 15 秒。', '写超时是 15 秒。'), false, 'the same 15 seconds belongs to another object');
});
