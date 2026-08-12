import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

interface Manifest {
  displayName: string;
  contributes: {
    configuration: { properties: Record<string, { default: number }> };
    customEditors: Array<{
      displayName: string;
      priority: string;
      selector: Array<{ filenamePattern: string }>;
    }>;
  };
}

test('registers an optional custom editor for supported extensions', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Manifest;
  assert.equal(manifest.displayName, 'json viewer');
  assert.equal(manifest.contributes.configuration.properties['jsonViewer.fontSize'].default, 13);
  const editor = manifest.contributes.customEditors[0];
  assert.equal(editor.displayName, 'json viewer');
  assert.equal(editor.priority, 'option');
  assert.deepEqual(editor.selector.map((item) => item.filenamePattern), ['*.json', '*.jsonl', '*.ndjson']);
});
