import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyzerPrompt, parseAnalyzerReply } from '../src/dream-analyzer.js';
import { verifyAnalysis, verifyCheck } from '../src/dream-verifier.js';
import { contradictsClaim, supportConflict, supportsStatement } from '../src/support.js';

const TRANSCRIPT = [
  '--- 2026-11-08 ---',
  '[user] 以后测试一律先跑 FOO=1 make test',
  '[assistant] 好的',
  '[tool-call] bash: FOO=1 make test',
  '[tool-result] 3 tests passed',
].join('\n');

test('the map prompt shows the memory index, never page bodies', () => {
  const prompt = buildAnalyzerPrompt({
    sessionId: 's1',
    transcript: TRANSCRIPT,
    memoryIndex: [{ file: 'project_testing.md', type: 'project', name: 'Testing', description: 'how tests run', body: 'OLD_BODY_TEXT' }],
    focus: 'testing',
  });
  assert.match(prompt, /Session: s1/);
  assert.match(prompt, /FOO=1/);
  assert.match(prompt, /- project_testing\.md \(project\): Testing — how tests run/);
  assert.doesNotMatch(prompt, /OLD_BODY_TEXT/);
  const parsed = parseAnalyzerReply(JSON.stringify({
    summary: 'testing changed',
    claims: [{ text: 'Tests need FOO=1', quote: 'FOO=1 make test', kind: 'command', confidence: 'high', target: 'project_testing.md' }],
    retire: [{ file: 'project_old.md', target: 'project_testing.md' }],
  }));
  assert.equal(parsed.claims.length, 1);
  assert.deepEqual(parsed.retire, [{ file: 'project_old.md', target: 'project_testing.md' }]);
});

test('verifier drops claims without a transcript quote and keeps real ones', () => {
  const result = verifyAnalysis({
    transcript: TRANSCRIPT,
    sessionId: 's1',
    memoryFiles: [{ file: 'project_testing.md' }],
    analysis: {
      summary: 's',
      claims: [
        { text: 'Tests need FOO=1', quote: 'FOO=1 make test', kind: 'command', confidence: 'high' },
        { text: 'invented', quote: 'not in transcript', kind: 'fact' },
      ],
    },
  });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].source, 'user');
  assert.equal(result.claims[0].date, '2026-11-08');
  assert.equal(result.dropped.length, 1);
});

const PAGE = { file: 'project_ops.md', body: '- Timeout is 15 seconds. ^[s0#1]\n- Tests need FOO=1.' };
const claimsOf = (...items) => new Map(items.map((item, index) => [`c${index + 1}`, { source: 'user', date: '2026-11-08', sessionId: 's1', ...item }]));

test('a check verdict counts only for a verified claim and a line that is on the page', () => {
  const claims = claimsOf({ text: 'Tests need FOO=1', quote: 'Tests need FOO=1' });
  const { verify, warnings } = verifyCheck({
    pages: [PAGE],
    claims,
    verdicts: [
      { file: 'project_ops.md', line: '- Tests need FOO=1.', result: 'holds', claim: 'c1' },
      { file: 'project_ops.md', line: 'a line that is not there', result: 'holds', claim: 'c1' },
      { file: 'project_ops.md', line: '- Tests need FOO=1.', result: 'holds', claim: 'c9' },
    ],
  });
  assert.equal(verify.length, 1);
  assert.equal(verify[0].claim, 'Tests need FOO=1.');
  assert.equal(verify[0].quote, 'Tests need FOO=1', 'the claim quote is the evidence');
  assert.equal(verify[0].source, 'user');
  assert.equal(warnings.length, 2);
});

test('holds needs the quote to state the line; a different quantity cannot confirm it', () => {
  const claims = claimsOf({ text: 'The timeout is 90 seconds', quote: 'The timeout is 90 seconds.' });
  const holds = verifyCheck({
    pages: [PAGE],
    claims,
    verdicts: [{ file: 'project_ops.md', line: 'Timeout is 15 seconds.', result: 'holds', claim: 'c1' }],
  });
  assert.equal(holds.verify.length, 0, 'a different value cannot confirm the line');
  const contradicts = verifyCheck({
    pages: [PAGE],
    claims,
    verdicts: [{ file: 'project_ops.md', line: 'Timeout is 15 seconds.', result: 'contradicts', claim: 'c1' }],
  });
  assert.equal(contradicts.verify.length, 1, 'a replacement is a proposal the human reviews');
  assert.equal(contradicts.verify[0].result, 'contradicts');
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
