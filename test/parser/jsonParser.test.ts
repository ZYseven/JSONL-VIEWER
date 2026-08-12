import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJson } from '../../src/parser/jsonParser';
import { JsonParseError } from '../../src/parser/types';

test('parses nested strict JSON and preserves duplicate keys', () => {
  const root = parseJson('{\n  "id": 1,\n  "id": {"ok": true},\n  "items": [null, "x"]\n}');
  assert.equal(root.type, 'object');
  assert.equal(root.children.length, 3);
  assert.equal(root.children[0].key, 'id');
  assert.equal(root.children[0].keyOccurrence, 0);
  assert.equal(root.children[1].keyOccurrence, 1);
  assert.equal(root.children[1].start.line, 3);
  assert.equal(root.children[2].children[1].value, 'x');
});

test('supports scalar roots and a BOM character', () => {
  assert.equal(parseJson('\ufefftrue').value, true);
  assert.equal(parseJson('"hello"').value, 'hello');
});

test('reports strict JSON errors with a source position', () => {
  assert.throws(
    () => parseJson('{"a": 1,}'),
    (error: unknown) => error instanceof JsonParseError && error.issue.line === 1 && error.issue.column === 9
  );
});

test('counts CRLF as one line ending', () => {
  const root = parseJson('{\r\n"a": 1\r\n}');
  assert.equal(root.children[0].start.line, 2);
  assert.equal(root.end.line, 3);
});
