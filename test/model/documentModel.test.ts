import assert from 'node:assert/strict';
import test from 'node:test';
import { DocumentModel } from '../../src/model/documentModel';

test('chunks JSONL records and searches unloaded records', () => {
  const model = new DocumentModel('{"name":"alpha"}\n{"name":"beta"}\n{"name":"gamma"}', 'sample.jsonl');
  assert.deepEqual(model.summary(), { kind: 'jsonl', total: 1, recordCount: 3, issue: undefined });
  assert.equal(model.chunk(0, 1).nodes.length, 1);
  const matches = model.search('GAM');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rootIndex, 0);
});

test('wraps JSONL records in one array root without line labels', () => {
  const model = new DocumentModel('{"id":1}\n{"id":2}', 'sample.jsonl');
  const root = model.chunk(0, 10).nodes[0];
  assert.equal(root.type, 'array');
  assert.equal(root.label, undefined);
  const values = model.children(root.id).nodes;
  assert.equal(values.length, 2);
  assert.deepEqual(values.map((node) => node.label), [undefined, undefined]);
  assert.deepEqual(values.map((node) => node.trailingComma), [true, false]);
});

test('keeps the JSON root container visible and expanded by default', () => {
  const model = new DocumentModel('{"item":{"id":1}}', 'sample.json');
  const nodes = model.chunk(0, 10).nodes;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'object');
  assert.equal(nodes[0].childCount, 1);
  assert.equal(nodes[0].defaultExpanded, true);
  assert.equal(model.children(nodes[0].id).nodes[0].key, 'item');
});

test('marks every non-final child with a trailing comma', () => {
  const model = new DocumentModel('{"first":1,"nested":{"value":2},"last":3}', 'sample.json');
  const root = model.chunk(0, 10).nodes[0];
  const nodes = model.children(root.id).nodes;
  assert.deepEqual(nodes.map((node) => node.trailingComma), [true, true, false]);
  assert.equal(model.children(nodes[1].id).nodes[0].trailingComma, false);
});

test('copies values and duplicate-key properties as JSON text', () => {
  const model = new DocumentModel('{"item":{"id":1},"item":2}', 'sample.json');
  const root = model.chunk(0, 10).nodes[0];
  const nodes = model.children(root.id).nodes;
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
  const root = model.chunk(0, 10).nodes[0];
  const node = model.children(root.id).nodes[0];
  assert.equal(node.truncated, true);
  assert.ok(String(node.value).length < 600);
  assert.equal(model.displayValue(node.id), JSON.stringify(value));
});

test('preserves large JSON number text for display and copy', () => {
  const model = new DocumentModel('{"large":9007199254740993}', 'sample.json');
  const root = model.chunk(0, 10).nodes[0];
  const node = model.children(root.id).nodes[0];
  assert.equal(node.value, '9007199254740993');
  assert.equal(model.copy(node.id, 'value'), '9007199254740993');
});

test('renders empty containers as JSON containers instead of undefined values', () => {
  const model = new DocumentModel('{"object":{},"array":[]}', 'sample.json');
  const root = model.chunk(0, 10).nodes[0];
  const nodes = model.children(root.id).nodes;
  assert.deepEqual(nodes.map((node) => node.preview), ['{0}', '[0]']);
  assert.deepEqual(nodes.map((node) => model.copy(node.id, 'value')), ['{}', '[]']);
});
