import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentModel } from '../../src/model/documentModel';

test('chunks JSONL records and searches unloaded records', () => {
  const model = new DocumentModel('{"name":"alpha"}\n{"name":"beta"}\n{"name":"gamma"}', 'sample.jsonl');
  assert.deepEqual(model.summary(), { kind: 'jsonl', total: 3, issue: undefined });
  assert.equal(model.chunk(0, 1).nodes.length, 1);
  const matches = model.search('GAM');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rootIndex, 2);
});

test('copies values and duplicate-key properties as JSON text', () => {
  const model = new DocumentModel('{"item":{"id":1},"item":2}', 'sample.json');
  const nodes = model.chunk(0, 10).nodes;
  assert.equal(model.copy(nodes[0].id, 'keyObject'), '{\n  "item": {\n    "id": 1\n  }\n}');
  assert.equal(model.copy(nodes[1].id, 'value'), '2');
  assert.equal(nodes[1].duplicate, true);
});

test('surfaces a whole-document JSON parse issue', () => {
  const model = new DocumentModel('{broken}', 'sample.json');
  assert.equal(model.summary().total, 0);
  assert.ok(model.summary().issue);
});

test('truncates huge display strings while retaining the complete value', () => {
  const value = 'x'.repeat(262_145);
  const model = new DocumentModel(JSON.stringify({ value }), 'sample.json');
  const node = model.chunk(0, 10).nodes[0];
  assert.equal(node.truncated, true);
  assert.ok(String(node.value).length < 600);
  assert.equal(model.displayValue(node.id), JSON.stringify(value));
});
