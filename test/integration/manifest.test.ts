import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

interface Manifest {
  contributes: {
    customEditors: Array<{
      priority: string;
      selector: Array<{ filenamePattern: string }>;
    }>;
  };
}

test('registers an optional custom editor for supported extensions', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Manifest;
  const editor = manifest.contributes.customEditors[0];
  assert.equal(editor.priority, 'option');
  assert.deepEqual(editor.selector.map((item) => item.filenamePattern), ['*.json', '*.jsonl', '*.ndjson']);
});
