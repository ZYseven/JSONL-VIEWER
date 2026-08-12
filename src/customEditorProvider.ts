import * as vscode from 'vscode';
import { DocumentModel } from './model/documentModel';
import { ExtensionToWebview, WebviewToExtension } from './webview/protocol';

const CHUNK_SIZE_JSONL = 200;
const CHUNK_SIZE_JSON = 100;

export class JsonlViewerProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'jsonlViewer.viewer';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
    };
    panel.webview.html = this.html(panel.webview, zh);
    let model = new DocumentModel(document.getText(), document.fileName, zh ? '第' : 'Line');

    const send = (message: ExtensionToWebview): Thenable<boolean> => panel.webview.postMessage(message);
    const sendDocument = (): void => { void send({ type: 'document', payload: model.summary() }); };
    let changeTimer: NodeJS.Timeout | undefined;

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
          case 'requestChildren': {
            const children = model.children(message.nodeId, message.start, CHUNK_SIZE_JSON);
            await send({ type: 'childrenData', requestId: message.requestId, nodeId: message.nodeId, start: message.start, ...children });
            break;
          }
          case 'requestDisplayValue': {
            const value = model.displayValue(message.nodeId);
            if (value !== undefined) await send({ type: 'displayValue', requestId: message.requestId, nodeId: message.nodeId, value });
            break;
          }
          case 'findMatches':
            await send({ type: 'searchResults', requestId: message.requestId, matches: model.search(message.query) });
            break;
          case 'copy': {
            const text = model.copy(message.nodeId, message.mode);
            if (text !== undefined) await vscode.env.clipboard.writeText(text);
            break;
          }
          case 'refresh':
            model = new DocumentModel(document.getText(), document.fileName, zh ? '第' : 'Line');
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
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => {
        model = new DocumentModel(document.getText(), document.fileName, zh ? '第' : 'Line');
        sendDocument();
      }, 150);
    });

    panel.onDidDispose(() => {
      messages.dispose();
      changes.dispose();
      if (changeTimer) clearTimeout(changeTimer);
    });
  }

  private html(webview: vscode.Webview, zh: boolean): string {
    const copy = zh ? {
      lang: 'zh-CN', search: '搜索键和值', expand: '全部展开', collapse: '全部折叠', refresh: '刷新', loadMore: '加载更多'
    } : {
      lang: 'en', search: 'Search keys and values', expand: 'Expand all', collapse: 'Collapse all', refresh: 'Refresh', loadMore: 'Load more'
    };
    const nonce = nonceValue();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    return `<!doctype html>
<html lang="${copy.lang}">
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
      <input id="search" type="search" placeholder="${copy.search}" aria-label="${copy.search}">
      <span id="search-count" aria-live="polite"></span>
    </div>
    <button id="expand-all" class="icon-button" title="${copy.expand}" aria-label="${copy.expand}">⊞</button>
    <button id="collapse-all" class="icon-button" title="${copy.collapse}" aria-label="${copy.collapse}">⊟</button>
    <button id="refresh" class="icon-button" title="${copy.refresh}" aria-label="${copy.refresh}">↻</button>
  </header>
  <main id="content" tabindex="0"><div id="tree" role="tree"></div></main>
  <button id="load-more" hidden>${copy.loadMore}</button>
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
:root {
  color-scheme: light dark;
  --viewer-line-height: 24px;
  --viewer-gutter-width: 52px;
  --viewer-indent: 22px;
  --viewer-code-padding: 64px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); font-weight: var(--vscode-editor-font-weight, normal); }
.toolbar { position: relative; z-index: 10; min-height: 36px; display: flex; align-items: center; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.search-wrap { position: relative; display: flex; align-items: center; flex: 0 1 360px; min-width: 160px; margin-right: auto; }
input { width: 100%; height: 26px; padding: 2px 60px 2px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; }
input:focus { border-color: var(--vscode-focusBorder); }
#search-count { position: absolute; right: 7px; width: 48px; text-align: right; color: var(--vscode-descriptionForeground); pointer-events: none; font-size: 12px; }
button { color: var(--vscode-icon-foreground); border: 0; cursor: pointer; }
.icon-button { width: 28px; height: 28px; min-height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; border-radius: 4px; font-size: 0; }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-button:focus-visible, .toggle:focus-visible, .children-more:focus-visible, #load-more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.icon-button::before, .icon-button::after { content: ''; display: block; }
#expand-all, #collapse-all { position: relative; }
#expand-all::before, #expand-all::after, #collapse-all::before, #collapse-all::after { position: absolute; left: 9px; width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; }
#expand-all::before { top: 5px; transform: rotate(45deg); }
#expand-all::after { top: 10px; transform: rotate(45deg); }
#collapse-all::before { top: 8px; transform: rotate(225deg); }
#collapse-all::after { top: 13px; transform: rotate(225deg); }
#refresh { position: relative; }
#refresh::before { width: 12px; height: 12px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; }
#refresh::after { position: absolute; top: 7px; right: 6px; width: 0; height: 0; border-top: 3px solid transparent; border-bottom: 3px solid transparent; border-left: 4px solid currentColor; transform: rotate(-35deg); }
#content { flex: 1 1 auto; min-height: 0; padding: 10px 0 36px; overflow: auto; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
#tree { counter-reset: viewer-line; min-width: max-content; width: 100%; }
.node { min-width: max-content; }
.root-page, .children-page { display: contents; }
.row, .closing { counter-increment: viewer-line; position: relative; display: flex; width: 100%; min-width: max-content; min-height: var(--viewer-line-height); align-items: flex-start; padding: 0 var(--viewer-code-padding) 0 calc(var(--viewer-gutter-width) + var(--viewer-code-padding) + var(--depth) * var(--viewer-indent)); line-height: var(--viewer-line-height); }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.match { background: var(--vscode-editor-findMatchHighlightBackground); }
.row.current { outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
.line { position: absolute; z-index: 1; left: 0; top: 0; width: var(--viewer-gutter-width); height: 100%; padding-right: 14px; border-right: 1px solid var(--vscode-editorIndentGuide-background1, var(--vscode-panel-border)); background: var(--vscode-editorGutter-background, var(--vscode-editor-background)); color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; font-variant-numeric: tabular-nums; }
.line::before { content: counter(viewer-line); }
.row:hover .line, .closing:hover .line { color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-editorLineNumber-foreground)); }
.toggle { position: relative; flex: 0 0 34px; width: 34px; height: var(--viewer-line-height); min-height: var(--viewer-line-height); margin-left: -34px; padding: 0; color: var(--vscode-icon-foreground); background: transparent; }
.toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
.toggle::before { content: ''; position: absolute; left: 8px; top: 7px; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 7px solid currentColor; transform-origin: 3px 5px; transition: transform 120ms ease; }
.toggle.expanded::before { transform: rotate(90deg); }
.toggle.empty { visibility: hidden; }
.key, .value, .preview { cursor: copy; white-space: pre; }
.key { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground)); font-weight: 600; }
.string { color: var(--vscode-debugTokenExpression-string, #608b4e); font-weight: 600; }
.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.boolean, .null { color: var(--vscode-debugTokenExpression-boolean, #569cd6); font-weight: 600; }
.punctuation { color: var(--vscode-editor-foreground); }
.preview { color: var(--vscode-descriptionForeground); }
.duplicate { margin-left: 6px; color: var(--vscode-editorWarning-foreground); font-size: 11px; }
.error { color: var(--vscode-errorForeground); }
.children[hidden] { display: none; }
.children-page { display: contents; }
.closing[hidden] { display: none; }
.closing-body { padding-left: 0; }
.children-more, #load-more { min-height: 26px; padding: 2px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 2px; }
.children-more:hover, #load-more:hover { background: var(--vscode-button-secondaryHoverBackground); }
.children-more { margin: 3px 0 3px calc(var(--viewer-gutter-width) + var(--viewer-code-padding)); }
#load-more { display: block; margin: 8px auto 24px; }
#load-more[hidden] { display: none; }
#status { position: fixed; right: 10px; bottom: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
.empty-state { padding: 24px calc(var(--viewer-gutter-width) + var(--viewer-code-padding)); color: var(--vscode-descriptionForeground); }
@media (prefers-reduced-motion: reduce) { .toggle::before { transition: none; } }
@media (max-width: 520px) {
  :root { --viewer-gutter-width: 44px; --viewer-code-padding: 44px; --viewer-indent: 20px; }
  .toolbar { flex-wrap: nowrap; }
  .search-wrap { flex: 1 1 auto; min-width: 120px; }
}
`;
}
