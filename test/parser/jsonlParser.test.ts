import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonLines } from '../../src/parser/jsonlParser';

test('ignores empty lines and isolates invalid records', () => {
  const records = parseJsonLines('\ufeff{"a":1}\r\n\r\ninvalid\r\n[1,2]');
  assert.equal(records.length, 3);
  assert.equal(records[0].line, 1);
  assert.equal(records[1].line, 3);
  assert.ok(records[1].issue);
  assert.equal(records[2].line, 4);
  assert.equal(records[2].node?.type, 'array');
});
