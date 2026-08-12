import { readFileSync } from 'node:fs';
import { DocumentModel } from '../../src/model/documentModel';

const fileName = process.argv[2];
if (!fileName) throw new Error('Expected a JSONL benchmark file path.');

const startHeap = process.memoryUsage().heapUsed;
const readStart = performance.now();
const text = readFileSync(fileName, 'utf8');
const readMs = performance.now() - readStart;
const modelStart = performance.now();
const model = new DocumentModel(text, fileName);
const modelMs = performance.now() - modelStart;
const chunkStart = performance.now();
const chunk = model.chunk(0, 200);
const chunkMs = performance.now() - chunkStart;

console.log(JSON.stringify({
  bytes: Buffer.byteLength(text),
  records: model.summary().total,
  firstChunk: chunk.nodes.length,
  readMs: Math.round(readMs),
  indexMs: Math.round(modelMs),
  firstChunkMs: Math.round(chunkMs),
  heapDeltaMb: Math.round((process.memoryUsage().heapUsed - startHeap) / 1024 / 1024)
}));
