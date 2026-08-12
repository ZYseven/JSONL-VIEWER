import * as vscode from 'vscode';
import { DocumentModel } from './model/documentModel';
import { ExtensionToWebview, WebviewToExtension } from './webview/protocol';

const CHUNK_SIZE_JSONL = 200;
const CHUNK_SIZE_JSON = 100;

export class JsonlViewerProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'jsonlViewer.viewer';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
    };
    panel.webview.html = this.html(panel.webview);
    let model = new DocumentModel(document.getText(), document.fileName);

    const send = (message: ExtensionToWebview): Thenable<boolean> => panel.webview.postMessage(message);
    const sendDocument = (): void => { void send({ type: 'document', payload: model.summary() }); };

    const messages = panel.webview.onDidReceiveMessage(async (message: WebviewToExtension) => {
      try {
        switch (message.type) {
          case 'ready':
            sendDocument();
            break;
          case 'requestChunk': {
            const size = model.kind === 'jsonl' ? CHUNK_SIZE_JSONL : CHUNK_SIZE_JSON;
            const chunk = model.chunk(message.start, size);
            await send({ type: 'chunkData', requestId: message.requestId, start: message.start, ...chunk });
            break;
          }
          case 'requestChildren':
            await send({ type: 'childrenData', requestId: message.requestId, nodeId: message.nodeId, nodes: model.children(message.nodeId) });
            break;
          case 'findMatches':
            await send({ type: 'searchResults', requestId: message.requestId, matches: model.search(message.query) });
            break;
          case 'copy': {
            const text = model.copy(message.nodeId, message.mode);
            if (text !== undefined) await vscode.env.clipboard.writeText(text);
            break;
          }
          case 'refresh':
            model = new DocumentModel(document.getText(), document.fileName);
            sendDocument();
            break;
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        await send({ type: 'error', message: 'JSONL Viewer could not complete the operation.', details });
      }
    });

    const changes = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      model = new DocumentModel(document.getText(), document.fileName);
      sendDocument();
    });

    panel.onDidDispose(() => {
      messages.dispose();
      changes.dispose();
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceValue();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">${styles()}</style>
  <title>JSONL Viewer</title>
</head>
<body>
  <header class="toolbar">
    <div class="search-wrap">
      <input id="search" type="search" placeholder="Search keys and values" aria-label="Search keys and values">
      <span id="search-count" aria-live="polite"></span>
    </div>
    <button id="expand-all" title="Expand all">Expand all</button>
    <button id="collapse-all" title="Collapse all">Collapse all</button>
    <button id="refresh" title="Refresh">Refresh</button>
  </header>
  <main id="content" tabindex="0"><div id="tree" role="tree"></div></main>
  <button id="load-more" hidden>Load more</button>
  <div id="status" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function nonceValue(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function styles(): string {
  return `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
.toolbar { position: sticky; top: 0; z-index: 10; min-height: 42px; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.search-wrap { display: flex; align-items: center; flex: 1; max-width: 520px; }
input { width: 100%; height: 28px; padding: 3px 68px 3px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
input:focus { border-color: var(--vscode-focusBorder); }
#search-count { margin-left: -62px; width: 56px; text-align: right; color: var(--vscode-descriptionForeground); pointer-events: none; }
button { min-height: 28px; padding: 3px 9px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
#content { padding: 8px 0 36px; overflow: auto; }
.node { min-width: max-content; }
.row { display: flex; min-height: 24px; align-items: flex-start; padding: 2px 12px 2px calc(12px + var(--depth) * 18px); line-height: 20px; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.match { background: var(--vscode-editor-findMatchHighlightBackground); }
.row.current { outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
.toggle { flex: 0 0 18px; height: 20px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; font-size: 12px; }
.toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
.toggle.empty { visibility: hidden; }
.line { flex: 0 0 70px; padding-right: 10px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
.key, .value { cursor: copy; white-space: pre-wrap; overflow-wrap: anywhere; }
.key { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground)); }
.string { color: var(--vscode-debugTokenExpression-string, #608b4e); }
.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.boolean, .null { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
.punctuation, .preview { color: var(--vscode-descriptionForeground); }
.duplicate { margin-left: 6px; color: var(--vscode-editorWarning-foreground); font-size: 11px; }
.error { color: var(--vscode-errorForeground); }
.children[hidden] { display: none; }
#load-more { display: block; margin: 4px auto 24px; }
#load-more[hidden] { display: none; }
#status { position: fixed; right: 10px; bottom: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
.empty-state { padding: 24px; color: var(--vscode-descriptionForeground); }
@media (max-width: 520px) { .toolbar { flex-wrap: wrap; } .search-wrap { flex-basis: 100%; max-width: none; } .line { flex-basis: 48px; } }
`;
}
