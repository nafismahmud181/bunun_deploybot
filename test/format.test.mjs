import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duration, escapeHtml, fitMessage, parseApps, parseIds, tidyLogs } from '../format.mjs';

test('parses the app list and allowed IDs', () => {
  assert.deepEqual(parseApps('backend:abc, admin:def'), [
    { name: 'backend', uuid: 'abc' },
    { name: 'admin', uuid: 'def' },
  ]);
  assert.throws(() => parseApps('backend'));
  assert.deepEqual([...parseIds('123, 456,abc,')], [123, 456]);
  assert.equal(parseIds('').size, 0);
});

test('drops health checks and tidies pino lines', () => {
  const raw = [
    '{"level":30,"time":0,"reqId":"r1","req":{"method":"GET","url":"/health"},"msg":"incoming request"}',
    '{"level":30,"time":0,"reqId":"r1","res":{"statusCode":200},"msg":"request completed"}',
    '{"level":50,"time":0,"reqId":"r2","msg":"checkout failed","err":{"message":"boom"}}',
    'plain text line',
  ].join('\n');
  assert.equal(tidyLogs(raw), '00:00:00 ERROR checkout failed — boom\nplain text line');
});

test('escapes, shortens and times', () => {
  assert.equal(escapeHtml('<a & b>'), '&lt;a &amp; b&gt;');
  assert.equal(fitMessage('abcdef', 3), '…def');
  assert.equal(duration('2026-10-09T20:35:50Z', '2026-10-09T20:41:38Z'), '5m 48s');
});
