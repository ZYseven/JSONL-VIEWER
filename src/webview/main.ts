import { ExtensionToWebview, WebviewToExtension } from './protocol';
import { SearchMatch, ViewNode } from '../model/documentModel';

declare function acquireVsCodeApi<T>(): { postMessage(message: WebviewToExtension): void; getState(): T | undefined; setState(state: T): void };

interface ViewerState { expanded: string[]; query: string; scrollTop: number; }

const vscode = acquireVsCodeApi<ViewerState>();
const tree = element<HTMLDivElement>('tree');
const content = element<HTMLElement>('content');
const loadMore = element<HTMLButtonElement>('load-more');
const search = element<HTMLInputElement>('search');
const searchCount = element<HTMLSpanElement>('search-count');
const status = element<HTMLDivElement>('status');
const persisted = vscode.getState();
const hasPersistedState = persisted !== undefined;
const expanded = new Set(persisted?.expanded ?? []);
let loaded = 0;
let done = false;
let matches: SearchMatch[] = [];
let currentMatch = -1;
let requestSequence = 0;
let chunkSize = 200;
let pendingReveal = false;
let expandAllActive = false;
const requestedChunks = new Set<number>();

search.value = persisted?.query ?? '';

window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'document':
      reset();
      chunkSize = message.payload.kind === 'jsonl' ? 200 : 100;
      if (message.payload.issue) {
        tree.append(emptyState(`${message.payload.issue.message} at ${message.payload.issue.line}:${message.payload.issue.column}`));
        return;
      }
      if (message.payload.total === 0) {
        tree.append(emptyState('No JSON values found.'));
        return;
      }
      requestChunk(0);
      break;
    case 'chunkData':
      requestedChunks.delete(message.start);
      message.nodes.forEach((node) => tree.append(renderNode(node, 0)));
      loaded = message.start + message.nodes.length;
      done = message.done;
      loadMore.hidden = done;
      restoreExpanded(tree);
      applyMatches();
      if (persisted?.scrollTop && message.start === 0) content.scrollTop = persisted.scrollTop;
      if (pendingReveal) {
        pendingReveal = false;
        revealCurrent();
      }
      break;
    case 'childrenData': {
      const host = tree.querySelector<HTMLElement>(`.node[data-id="${cssEscape(message.nodeId)}"]`);
      const container = host?.querySelector<HTMLElement>(':scope > .children');
      if (!container) return;
      const depth = Number(host?.dataset.depth ?? 0) + 1;
      message.nodes.forEach((node) => container.append(renderNode(node, depth)));
      container.dataset.loaded = 'true';
      restoreExpanded(container);
      applyMatches();
      if (expandAllActive) window.setTimeout(expandAllVisible, 0);
      if (currentMatch >= 0) window.setTimeout(revealCurrent, 0);
      break;
    }
    case 'displayValue': {
      const value = tree.querySelector<HTMLElement>(`.row[data-node-id="${cssEscape(message.nodeId)}"] .value`);
      if (value) {
        value.textContent = message.value;
        value.classList.remove('truncated');
      }
      break;
    }
    case 'searchResults':
      matches = message.matches;
      currentMatch = matches.length ? 0 : -1;
      revealCurrent();
      break;
    case 'error':
      status.textContent = message.details ? `${message.message} ${message.details}` : message.message;
      break;
  }
});

loadMore.addEventListener('click', () => requestChunk(loaded));
element<HTMLButtonElement>('refresh').addEventListener('click', () => post({ type: 'refresh' }));
element<HTMLButtonElement>('collapse-all').addEventListener('click', () => {
  expandAllActive = false;
  expanded.clear();
  document.querySelectorAll<HTMLElement>('.children').forEach((item) => { item.hidden = true; });
  document.querySelectorAll<HTMLButtonElement>('.toggle').forEach((item) => { if (!item.classList.contains('empty')) item.textContent = '▶'; });
  saveState();
});
element<HTMLButtonElement>('expand-all').addEventListener('click', () => {
  expandAllActive = true;
  expandAllVisible();
});

let searchTimer: number | undefined;
search.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => post({ type: 'findMatches', requestId: id(), query: search.value }), 150);
  saveState();
});
search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || matches.length === 0) return;
  event.preventDefault();
  currentMatch = (currentMatch + (event.shiftKey ? -1 : 1) + matches.length) % matches.length;
  revealCurrent();
});
content.addEventListener('scroll', () => {
  saveState();
  if (!done && content.scrollTop + content.clientHeight >= content.scrollHeight - 160) requestChunk(loaded);
});

function renderNode(node: ViewNode, depth: number): HTMLElement {
  const host = document.createElement('div');
  host.className = 'node';
  host.dataset.id = node.id;
  host.dataset.depth = String(depth);
  if (!hasPersistedState && node.defaultExpanded) expanded.add(node.id);
  const row = document.createElement('div');
  row.className = `row ${node.type === 'error' ? 'error' : ''}`;
  row.style.setProperty('--depth', String(depth));
  row.setAttribute('role', 'treeitem');
  row.dataset.nodeId = node.id;

  const toggle = document.createElement('button');
  toggle.className = `toggle ${node.childCount ? '' : 'empty'}`;
  toggle.textContent = expanded.has(node.id) ? '▼' : '▶';
  toggle.ariaLabel = 'Toggle node';
  row.append(toggle);

  const line = document.createElement('span');
  line.className = 'line';
  line.textContent = node.endLine > node.line ? `${node.line}-${node.endLine}` : String(node.line);
  row.append(line);

  if (node.label) {
    const label = document.createElement('span');
    label.className = 'key';
    label.textContent = node.label;
    label.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    row.append(label, punctuation(': '));
  } else if (node.key !== undefined) {
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = JSON.stringify(node.key);
    key.title = 'Copy this property as JSON';
    key.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'keyObject' }));
    row.append(key);
    if (node.duplicate) {
      const warning = document.createElement('span');
      warning.className = 'duplicate';
      warning.textContent = 'duplicate';
      row.append(warning);
    }
    row.append(punctuation(': '));
  }

  if (node.type === 'error') {
    const error = document.createElement('span');
    error.textContent = node.error ?? 'Invalid JSON';
    row.append(error);
  } else if (node.childCount) {
    const preview = document.createElement('span');
    preview.className = 'preview';
    preview.textContent = node.preview ?? '';
    preview.title = 'Copy value';
    preview.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    row.append(preview);
  } else {
    const value = document.createElement('span');
    value.className = `value ${node.type}`;
    value.textContent = node.type === 'string' ? JSON.stringify(node.value) : String(node.value);
    value.title = 'Copy value';
    value.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    if (node.truncated) {
      value.classList.add('truncated');
      value.title = 'Click to reveal; click again to copy';
      value.addEventListener('click', (event) => {
        if (!value.classList.contains('truncated')) return;
        event.stopImmediatePropagation();
        post({ type: 'requestDisplayValue', requestId: id(), nodeId: node.id });
      }, { capture: true });
    }
    row.append(value);
  }

  const children = document.createElement('div');
  children.className = 'children';
  children.hidden = !expanded.has(node.id);
  children.setAttribute('role', 'group');
  toggle.addEventListener('click', () => toggleNode(host, node));
  host.append(row, children);
  return host;
}

function toggleNode(host: HTMLElement, node: ViewNode): void {
  if (!node.childCount) return;
  const children = host.querySelector<HTMLElement>(':scope > .children')!;
  const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle')!;
  const willExpand = children.hidden;
  children.hidden = !willExpand;
  toggle.textContent = willExpand ? '▼' : '▶';
  if (willExpand) {
    expanded.add(node.id);
    if (!children.dataset.loaded) post({ type: 'requestChildren', requestId: id(), nodeId: node.id });
  } else {
    expanded.delete(node.id);
  }
  saveState();
}

function expandAllVisible(): void {
  const hosts = Array.from(tree.querySelectorAll<HTMLElement>('.node')).slice(0, 10_000);
  for (const host of hosts) {
    const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle');
    const children = host.querySelector<HTMLElement>(':scope > .children');
    if (toggle && children?.hidden && !toggle.classList.contains('empty')) toggle.click();
  }
  if (tree.querySelectorAll('.node').length >= 10_000) {
    expandAllActive = false;
    status.textContent = 'Expansion stopped at 10,000 visible nodes.';
  }
}

function revealCurrent(): void {
  applyMatches();
  if (currentMatch < 0) return;
  const match = matches[currentMatch];
  if (!tree.querySelector(`.node[data-id="${cssEscape(match.pathIds[0] ?? match.nodeId)}"]`)) {
    pendingReveal = true;
    requestChunk(loaded);
    return;
  }
  for (const idValue of match.pathIds) expanded.add(idValue);
  restoreExpanded(tree);
  const row = tree.querySelector<HTMLElement>(`.row[data-node-id="${cssEscape(match.nodeId)}"]`);
  row?.classList.add('current');
  row?.scrollIntoView({ block: 'center' });
  searchCount.textContent = `${currentMatch + 1}/${matches.length}`;
  saveState();
}

function applyMatches(): void {
  document.querySelectorAll('.row.match, .row.current').forEach((item) => item.classList.remove('match', 'current'));
  for (const match of matches) tree.querySelector(`.row[data-node-id="${cssEscape(match.nodeId)}"]`)?.classList.add('match');
  searchCount.textContent = matches.length ? `${Math.max(currentMatch + 1, 1)}/${matches.length}` : search.value ? '0/0' : '';
}

function restoreExpanded(root: ParentNode): void {
  for (const nodeId of expanded) {
    const host = root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(nodeId)}"]`);
    if (!host) continue;
    const children = host.querySelector<HTMLElement>(':scope > .children');
    const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle');
    if (toggle && !toggle.classList.contains('empty')) {
      if (children?.hidden) toggle.click();
      else toggle.textContent = '▼';
    }
  }
}

function requestChunk(start: number): void {
  if ((done && start > 0) || requestedChunks.has(start)) return;
  requestedChunks.add(start);
  post({ type: 'requestChunk', requestId: id(), start });
}

function reset(): void {
  tree.replaceChildren();
  loaded = 0;
  done = false;
  matches = [];
  currentMatch = -1;
  loadMore.hidden = true;
  status.textContent = '';
  requestedChunks.clear();
}

function saveState(): void { vscode.setState({ expanded: [...expanded], query: search.value, scrollTop: content.scrollTop }); }
function post(message: WebviewToExtension): void { vscode.postMessage(message); }
function id(): string { return `r${++requestSequence}`; }
function punctuation(value: string): HTMLElement { const span = document.createElement('span'); span.className = 'punctuation'; span.textContent = value; return span; }
function emptyState(text: string): HTMLElement { const div = document.createElement('div'); div.className = 'empty-state'; div.textContent = text; return div; }
function element<T extends HTMLElement>(idValue: string): T { return document.getElementById(idValue) as T; }
function cssEscape(value: string): string { return CSS.escape(value); }

post({ type: 'ready' });
