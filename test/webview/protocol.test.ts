import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtensionToWebview, WebviewToExtension } from '../../src/webview/protocol';

test('supports request-scoped chunk and child responses', () => {
  const request: WebviewToExtension = { type: 'requestChunk', requestId: 'r1', start: 200 };
  const response: ExtensionToWebview = { type: 'chunkData', requestId: 'r1', start: 200, nodes: [], done: true };
  assert.equal(request.requestId, response.requestId);
  assert.equal(response.done, true);

  const childRequest: WebviewToExtension = { type: 'requestChildren', requestId: 'r2', nodeId: '$', start: 100 };
  const childResponse: ExtensionToWebview = { type: 'childrenData', requestId: 'r2', nodeId: '$', start: 100, nodes: [], done: true };
  assert.equal(childRequest.start, childResponse.start);
});

test('keeps clipboard operations explicit', () => {
  const keyCopy: WebviewToExtension = { type: 'copy', nodeId: '$/item#0', mode: 'keyObject' };
  const valueCopy: WebviewToExtension = { type: 'copy', nodeId: '$/item#0', mode: 'value' };
  assert.notEqual(keyCopy.mode, valueCopy.mode);
});
