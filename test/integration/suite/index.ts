import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.all.find((item) => item.id.toLowerCase() === 'zyseven.jsonl-viewer');
  assert.ok(extension, 'JSONL Viewer extension should be installed in the Extension Host');
  await extension.activate();
  assert.equal(extension.isActive, true);

  const editors = extension.packageJSON.contributes?.customEditors as Array<{
    viewType: string;
    priority: string;
    selector: Array<{ filenamePattern: string }>;
  }>;
  assert.equal(editors[0].viewType, 'jsonlViewer.viewer');
  assert.equal(editors[0].priority, 'option');
  assert.deepEqual(editors[0].selector.map((item) => item.filenamePattern), ['*.{json,jsonl,ndjson}']);
}
