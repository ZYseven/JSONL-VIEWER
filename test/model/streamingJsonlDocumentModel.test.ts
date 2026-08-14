import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StreamingJsonlDocumentModel } from '../../src/model/streamingJsonlDocumentModel';

test('reads JSONL records incrementally without indexing the whole file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-viewer-'));
  const file = join(directory, 'records.jsonl');
  await writeFile(file, '{"id":1}\n{"id":2}\n{"id":3}\n');
  const controller = new AbortController();
  const model = new StreamingJsonlDocumentModel(file, controller.signal);

  await model.initialize();
  assert.deepEqual(model.summary(), { kind: 'jsonl', total: 1, recordCount: undefined });
  const root = model.chunk(0).nodes[0];
  assert.equal(root.type, 'array');
  const firstPage = await model.children(root.id, 0, 2);
  assert.deepEqual(firstPage.nodes.map((node) => node.key), [undefined, undefined]);
  assert.equal(firstPage.done, false);

  const secondPage = await model.children(root.id, 2, 2);
  assert.equal(secondPage.nodes.length, 1);
  assert.equal(secondPage.done, true);
  assert.equal(model.summary().recordCount, 3);
  model.dispose();
});

test('keeps streamed top-level records collapsed until the user opens one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-viewer-'));
  const file = join(directory, 'deep-records.jsonl');
  await writeFile(file, '{"id":1,"payload":{"nested":{"value":true}}}\n{"id":2}\n');
  const controller = new AbortController();
  const model = new StreamingJsonlDocumentModel(file, controller.signal);

  await model.initialize();
  const root = model.chunk(0).nodes[0];
  const page = await model.children(root.id, 0, 10);
  assert.deepEqual(page.nodes.map((node) => node.defaultExpanded), [false, false]);
  model.dispose();
});

test('cancels a pending streaming model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jsonl-viewer-'));
  const file = join(directory, 'records.jsonl');
  await writeFile(file, '{"id":1}\n');
  const controller = new AbortController();
  const model = new StreamingJsonlDocumentModel(file, controller.signal);
  controller.abort();
  await assert.rejects(model.initialize(), { name: 'AbortError' });
});
