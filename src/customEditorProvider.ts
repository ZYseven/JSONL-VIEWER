import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { DocumentModel } from './model/documentModel';
import { ExtensionToWebview, WebviewToExtension } from './webview/protocol';

const CHUNK_SIZE_JSONL = 200;
const CHUNK_SIZE_JSON = 100;

interface ReadonlyJsonDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export class JsonlViewerProvider implements vscode.CustomReadonlyEditorProvider<ReadonlyJsonDocument> {
  static readonly viewType = 'jsonlViewer.viewer';

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): ReadonlyJsonDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: ReadonlyJsonDocument, panel: vscode.WebviewPanel): Promise<void> {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
    };
    panel.webview.html = this.html(panel.webview, zh);

    let model: DocumentModel;
    try {
      model = await this.loadModel(document.uri);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`json viewer: ${details}`);
      panel.webview.html = this.errorHtml(zh, details);
      return;
    }

    const send = (message: ExtensionToWebview): Thenable<boolean> => panel.webview.postMessage(message);
    const sendDocument = (): void => {
      void send({ type: 'settings', fontSize: fontSize() });
      void send({ type: 'document', payload: model.summary() });
    };
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
            const value = model.copy(message.nodeId, message.mode);
            if (value !== undefined) await vscode.env.clipboard.writeText(value);
            break;
          }
          case 'refresh':
            model = await this.loadModel(document.uri);
            sendDocument();
            break;
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        await send({ type: 'error', message: zh ? 'json viewer 无法完成操作。' : 'json viewer could not complete the operation.', details });
      }
    });

    const settings = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jsonViewer.fontSize')) {
        void send({ type: 'settings', fontSize: fontSize() });
      }
    });
    panel.onDidDispose(() => {
      messages.dispose();
      settings.dispose();
    });
  }

  private async loadModel(uri: vscode.Uri): Promise<DocumentModel> {
    const bytes = uri.scheme === 'file'
      ? await readFile(uri.fsPath)
      : await vscode.workspace.fs.readFile(uri);
    return new DocumentModel(new TextDecoder('utf-8').decode(bytes), uri.path);
  }

  private html(webview: vscode.Webview, zh: boolean): string {
    const copy = zh ? {
      lang: 'zh-CN', search: '搜索键和值', previous: '上一个匹配项', next: '下一个匹配项', close: '关闭搜索',
      expand: '全部展开', collapse: '全部折叠', refresh: '刷新', loadMore: '加载更多'
    } : {
      lang: 'en', search: 'Search keys and values', previous: 'Previous match', next: 'Next match', close: 'Close search',
      expand: 'Expand all', collapse: 'Collapse all', refresh: 'Refresh', loadMore: 'Load more'
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
  <title>json viewer</title>
</head>
<body>
  <div id="search-panel" class="search-panel" hidden>
    <input id="search" type="search" placeholder="${copy.search}" aria-label="${copy.search}">
    <span id="search-count" aria-live="polite"></span>
    <button id="search-previous" class="icon-button search-previous" title="${copy.previous}" aria-label="${copy.previous}"></button>
    <button id="search-next" class="icon-button search-next" title="${copy.next}" aria-label="${copy.next}"></button>
    <button id="search-close" class="icon-button search-close" title="${copy.close}" aria-label="${copy.close}"></button>
  </div>
  <div class="toolbar" role="toolbar">
    <button id="expand-all" class="icon-button expand-all" title="${copy.expand}" aria-label="${copy.expand}"></button>
    <button id="collapse-all" class="icon-button collapse-all" title="${copy.collapse}" aria-label="${copy.collapse}"></button>
    <button id="refresh" class="icon-button refresh" title="${copy.refresh}" aria-label="${copy.refresh}"></button>
  </div>
  <main id="content" tabindex="0">
    <div id="tree" role="tree"></div>
    <button id="load-more" hidden>${copy.loadMore}</button>
  </main>
  <div id="status" role="status" aria-live="polite"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private errorHtml(zh: boolean, details: string): string {
    const escaped = details.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
    return `<!doctype html><html><body style="padding:24px;font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);background:var(--vscode-editor-background)">${zh ? '无法打开文件：' : 'Could not open file: '}${escaped}</body></html>`;
  }
}

function fontSize(): number {
  const configured = vscode.workspace.getConfiguration('jsonViewer').get<number>('fontSize', 13);
  return Math.min(24, Math.max(10, configured));
}

function nonceValue(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function styles(): string {
  return `
:root { color-scheme: light dark; --viewer-font-size: 13px; --viewer-line-height: 1.6em; --viewer-indent: 22px; --viewer-padding: 76px; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; overflow: hidden; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--viewer-font-size); font-weight: var(--vscode-editor-font-weight, normal); }
button, input { font: inherit; }
button { color: var(--vscode-icon-foreground); border: 0; cursor: pointer; }
#content { height: 100%; padding: 18px 0 48px; overflow: auto; scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
#tree { min-width: max-content; width: 100%; }
.node { min-width: max-content; }
.root-page, .children-page { display: contents; }
.row, .closing { position: relative; display: flex; min-width: max-content; min-height: var(--viewer-line-height); align-items: flex-start; padding: 0 28px 0 calc(var(--viewer-padding) + var(--depth) * var(--viewer-indent)); line-height: var(--viewer-line-height); }
.row.match { background: color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground) 60%, transparent); }
.row.current { outline: 1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
.toggle { position: relative; flex: 0 0 24px; width: 24px; height: var(--viewer-line-height); min-height: var(--viewer-line-height); margin-left: -28px; padding: 0; background: transparent; border-radius: 3px; }
.toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
.toggle::before { content: ''; position: absolute; left: 8px; top: calc(50% - 5px); width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 7px solid currentColor; transform-origin: 3px 5px; transition: transform 120ms ease; }
.toggle.expanded::before { transform: rotate(90deg); }
.toggle.empty { visibility: hidden; }
.line { display: none; }
.key, .value, .preview { display: inline-block; margin: 0 -3px; padding: 0 3px; border-radius: 4px; cursor: pointer; white-space: pre; transition: background-color 100ms ease; }
.key:hover, .value:hover, .preview:hover { background: var(--vscode-toolbar-hoverBackground); }
.key:focus-visible, .value:focus-visible, .preview:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.key { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground)); font-weight: 600; }
.string { color: var(--vscode-debugTokenExpression-string, #608b4e); font-weight: 600; }
.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.boolean, .null { color: var(--vscode-debugTokenExpression-boolean, #569cd6); font-weight: 600; }
.punctuation { color: var(--vscode-editor-foreground); }
.preview { color: var(--vscode-descriptionForeground); }
.duplicate { margin-left: 6px; color: var(--vscode-editorWarning-foreground); font-size: .85em; }
.error { color: var(--vscode-errorForeground); }
.children[hidden], .closing[hidden], #load-more[hidden], .search-panel[hidden] { display: none; }
.children-page { display: contents; }
.children-more, #load-more { min-height: 26px; padding: 2px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-radius: 3px; }
.children-more:hover, #load-more:hover { background: var(--vscode-button-secondaryHoverBackground); }
.children-more { margin: 4px 0 4px calc(var(--viewer-padding) + 18px); }
#load-more { margin: 10px 0 0 var(--viewer-padding); }
.toolbar { position: fixed; z-index: 20; top: 8px; right: 10px; display: flex; gap: 2px; padding: 3px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.22)); }
.icon-button { position: relative; width: 26px; height: 26px; min-height: 26px; padding: 0; background: transparent; border-radius: 3px; }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-button:focus-visible, .toggle:focus-visible, .children-more:focus-visible, #load-more:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.expand-all::before, .collapse-all::before { content: ''; position: absolute; left: 6px; top: 6px; width: 12px; height: 12px; border: 1px solid currentColor; }
.expand-all::after, .collapse-all::after { content: ''; position: absolute; left: 9px; top: 12px; width: 8px; height: 1px; background: currentColor; }
.expand-all::after { box-shadow: 0 0 0 0 currentColor; }
.expand-all span { display: none; }
.expand-all::before { background: linear-gradient(currentColor,currentColor) center/1px 8px no-repeat; }
.refresh::before { content: ''; position: absolute; left: 6px; top: 6px; width: 11px; height: 11px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; }
.refresh::after { content: ''; position: absolute; right: 5px; top: 5px; border-top: 3px solid transparent; border-bottom: 3px solid transparent; border-left: 4px solid currentColor; transform: rotate(-35deg); }
.search-panel { position: fixed; z-index: 30; top: 8px; right: 10px; display: grid; grid-template-columns: minmax(180px, 320px) 44px 26px 26px 26px; align-items: center; gap: 2px; padding: 4px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.22)); }
#search { width: 100%; height: 26px; padding: 2px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
#search:focus { border-color: var(--vscode-focusBorder); }
#search-count { text-align: center; color: var(--vscode-descriptionForeground); font-size: .9em; }
.search-previous::before, .search-next::before { content: ''; position: absolute; left: 9px; width: 7px; height: 7px; border-left: 1.5px solid currentColor; border-top: 1.5px solid currentColor; }
.search-previous::before { top: 10px; transform: rotate(45deg); }
.search-next::before { top: 7px; transform: rotate(225deg); }
.search-close::before, .search-close::after { content: ''; position: absolute; left: 7px; top: 12px; width: 12px; height: 1.5px; background: currentColor; }
.search-close::before { transform: rotate(45deg); }
.search-close::after { transform: rotate(-45deg); }
#status { position: fixed; right: 10px; bottom: 8px; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
.empty-state { padding: 24px var(--viewer-padding); color: var(--vscode-descriptionForeground); }
@media (prefers-reduced-motion: reduce) { .toggle::before, .key, .value, .preview { transition: none; } }
@media (max-width: 520px) { :root { --viewer-padding: 48px; --viewer-indent: 20px; } .search-panel { left: 8px; right: 8px; grid-template-columns: minmax(100px, 1fr) 38px 26px 26px 26px; } }
`;
}
