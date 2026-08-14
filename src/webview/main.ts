import { ExtensionToWebview, WebviewToExtension } from './protocol';
import { SearchMatch, ViewNode } from '../model/documentModel';

declare function acquireVsCodeApi<T>(): { postMessage(message: WebviewToExtension): void; getState(): T | undefined; setState(state: T): void };

interface ViewerState { expanded: string[]; query: string; scrollTop: number; }

const vscode = acquireVsCodeApi<ViewerState>();
const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
const text = zh ? {
  noValues: '未找到 JSON 值。', copyProperty: '复制包含键的 JSON 属性', copyValue: '复制值',
  revealValue: '点击展开完整值，再次点击复制', toggle: '展开或折叠节点', loadMore: '加载更多',
  expandLimit: '已在 10,000 个可见节点处停止展开。'
} : {
  noValues: 'No JSON values found.', copyProperty: 'Copy this property as JSON', copyValue: 'Copy value',
  revealValue: 'Click to reveal; click again to copy', toggle: 'Toggle node', loadMore: 'Load more',
  expandLimit: 'Expansion stopped at 10,000 visible nodes.'
};
const tree = element<HTMLDivElement>('tree');
const content = element<HTMLElement>('content');
const loadMore = element<HTMLButtonElement>('load-more');
const searchPanel = element<HTMLDivElement>('search-panel');
const search = element<HTMLInputElement>('search');
const searchCount = element<HTMLSpanElement>('search-count');
const status = element<HTMLDivElement>('status');
const persisted = vscode.getState();
const hasPersistedState = persisted !== undefined;
const expanded = new Set(persisted?.expanded ?? []);
let loaded = 0;
let totalRoots = 0;
let done = false;
let matches: SearchMatch[] = [];
let currentMatch = -1;
let requestSequence = 0;
let chunkSize = 200;
let pendingReveal = false;
let expandAllActive = false;
let restoreScrollTop = persisted?.scrollTop ?? 0;
let searchOpen = false;
let lineNumbersQueued = false;
const requestedChunks = new Set<number>();
const requestedChildren = new Set<string>();
const requestedExpansionDepth = new Map<string, number>();
const loadObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) (entry.target as HTMLButtonElement).click();
  }
}, { root: content, rootMargin: '160px' });

search.value = persisted?.query ?? '';

window.addEventListener('message', (event: MessageEvent<ExtensionToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'document':
      if (tree.childElementCount > 0) restoreScrollTop = content.scrollTop;
      reset();
      chunkSize = message.payload.kind === 'jsonl' ? 200 : 100;
      totalRoots = message.payload.total;
      if (message.payload.issue) {
        tree.append(emptyState(`${message.payload.issue.message} at ${message.payload.issue.line}:${message.payload.issue.column}`));
        return;
      }
      if (message.payload.total === 0) {
        tree.append(emptyState(text.noValues));
        return;
      }
      requestChunk(0);
      if (search.value.trim()) post({ type: 'findMatches', requestId: id(), query: search.value });
      break;
    case 'settings':
      if (message.fontSize > 0) document.documentElement.style.setProperty('--viewer-font-size', `${message.fontSize}px`);
      else document.documentElement.style.removeProperty('--viewer-font-size');
      break;
    case 'chunkData':
      requestedChunks.delete(message.start);
      const rootPage = document.createElement('div');
      rootPage.className = 'root-page';
      rootPage.dataset.start = String(message.start);
      rootPage.dataset.count = String(message.nodes.length);
      rootPage.dataset.done = String(message.done);
      message.nodes.forEach((node) => rootPage.append(renderNode(node, 0)));
      const nextRootPage = Array.from(tree.querySelectorAll<HTMLElement>(':scope > .root-page'))
        .find((item) => Number(item.dataset.start) > message.start);
      tree.insertBefore(rootPage, nextRootPage ?? null);
      updateRootProgress();
      loadMore.hidden = done;
      restoreExpanded(tree);
      scheduleVisibleLineNumbers();
      applyMatches();
      if (restoreScrollTop && message.start === 0) content.scrollTop = restoreScrollTop;
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
      const requestKey = `${message.nodeId}:${message.start}`;
      const inheritedExpansionDepth = requestedExpansionDepth.get(requestKey);
      requestedChildren.delete(requestKey);
      requestedExpansionDepth.delete(requestKey);
      const page = document.createElement('div');
      page.className = 'children-page';
      page.dataset.start = String(message.start);
      page.dataset.count = String(message.nodes.length);
      page.dataset.done = String(message.done);
      message.nodes.forEach((node) => page.append(renderNode(node, depth, inheritedExpansionDepth)));
      const nextPage = Array.from(container.querySelectorAll<HTMLElement>(':scope > .children-page'))
        .find((item) => Number(item.dataset.start) > message.start);
      container.insertBefore(page, nextPage ?? null);
      updateChildProgress(container);
      updateChildrenLoadButton(host!, container, message.nodeId);
      restoreExpanded(container);
      scheduleVisibleLineNumbers();
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
  document.querySelectorAll<HTMLButtonElement>('.toggle.expanded').forEach((item) => item.click());
  expanded.clear();
  saveState();
});
element<HTMLButtonElement>('expand-all').addEventListener('click', () => {
  expandAllActive = true;
  expandAllVisible();
});

element<HTMLButtonElement>('search-close').addEventListener('click', () => closeSearch());
element<HTMLButtonElement>('search-previous').addEventListener('click', () => cycleMatch(-1));
element<HTMLButtonElement>('search-next').addEventListener('click', () => cycleMatch(1));

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearch();
    return;
  }
  if (event.key === 'Escape' && searchOpen) {
    event.preventDefault();
    closeSearch();
  }
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
  cycleMatch(event.shiftKey ? -1 : 1);
});
content.addEventListener('scroll', () => {
  saveState();
  if (!done && content.scrollTop + content.clientHeight >= content.scrollHeight - 160) requestChunk(loaded);
});

function renderNode(node: ViewNode, depth: number, inheritedExpansionDepth?: number): HTMLElement {
  const host = document.createElement('div');
  host.className = 'node';
  host.dataset.id = node.id;
  host.dataset.depth = String(depth);
  const shouldExpand = inheritedExpansionDepth === undefined ? node.defaultExpanded : inheritedExpansionDepth > 0;
  if (shouldExpand) expanded.add(node.id);
  if (inheritedExpansionDepth !== undefined) host.dataset.inheritedExpansionDepth = String(inheritedExpansionDepth);
  const row = document.createElement('div');
  row.className = `row ${node.type === 'error' ? 'error' : ''}`;
  row.style.setProperty('--depth', String(depth));
  row.setAttribute('role', 'treeitem');
  row.dataset.nodeId = node.id;

  const line = document.createElement('span');
  line.className = 'line';
  line.ariaHidden = 'true';
  row.append(line);

  const toggle = document.createElement('button');
  toggle.className = `toggle ${node.childCount ? '' : 'empty'}`;
  toggle.ariaLabel = text.toggle;
  toggle.ariaExpanded = 'false';
  row.append(toggle);

  if (node.label) {
    const label = document.createElement('span');
    label.className = 'key';
    label.textContent = node.label;
    label.tabIndex = 0;
    label.role = 'button';
    label.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    label.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') post({ type: 'copy', nodeId: node.id, mode: 'value' }); });
    row.append(label, punctuation(': '));
  } else if (node.key !== undefined) {
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = JSON.stringify(node.key);
    key.title = text.copyProperty;
    key.tabIndex = 0;
    key.role = 'button';
    key.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'keyObject' }));
    key.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') post({ type: 'copy', nodeId: node.id, mode: 'keyObject' }); });
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
    preview.className = `preview bracket depth-${depth % 3}`;
    preview.textContent = `${node.preview ?? ''}${node.trailingComma ? ',' : ''}`;
    preview.dataset.collapsed = `${node.preview ?? ''}${node.trailingComma ? ',' : ''}`;
    preview.dataset.expanded = node.type === 'object' ? '{' : '[';
    preview.title = text.copyValue;
    preview.tabIndex = 0;
    preview.role = 'button';
    preview.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    preview.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') post({ type: 'copy', nodeId: node.id, mode: 'value' }); });
    row.append(preview);
  } else {
    const value = document.createElement('span');
    value.className = `value ${node.type}`;
    value.textContent = node.type === 'string'
      ? JSON.stringify(node.value)
      : node.type === 'object' || node.type === 'array'
        ? node.preview ?? (node.type === 'object' ? '{}' : '[]')
        : String(node.value);
    value.title = text.copyValue;
    value.tabIndex = 0;
    value.role = 'button';
    value.addEventListener('click', () => post({ type: 'copy', nodeId: node.id, mode: 'value' }));
    value.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') post({ type: 'copy', nodeId: node.id, mode: 'value' }); });
    if (node.truncated) {
      value.classList.add('truncated');
      value.title = text.revealValue;
      value.addEventListener('click', (event) => {
        if (!value.classList.contains('truncated')) return;
        event.stopImmediatePropagation();
        post({ type: 'requestDisplayValue', requestId: id(), nodeId: node.id });
      }, { capture: true });
    }
    row.append(value);
    if (node.trailingComma) row.append(punctuation(','));
  }

  const children = document.createElement('div');
  children.className = 'children';
  // Expanded ids describe desired state. Keep new DOM closed so restoreExpanded
  // goes through toggleNode and requests children before revealing the group.
  children.hidden = true;
  children.setAttribute('role', 'group');
  const closing = document.createElement('div');
  closing.className = 'closing';
  closing.style.setProperty('--depth', String(depth));
  const closingBody = document.createElement('span');
  closingBody.className = `closing-body bracket depth-${depth % 3}`;
  const closingLine = document.createElement('span');
  closingLine.className = 'line';
  closingLine.ariaHidden = 'true';
  closing.append(closingLine);
  closingBody.textContent = `${node.type === 'object' ? '}' : node.type === 'array' ? ']' : ''}${node.trailingComma ? ',' : ''}`;
  closing.append(closingBody);
  closing.hidden = true;
  toggle.addEventListener('click', () => toggleNode(host, node));
  host.append(row, children);
  if (node.type === 'object' || node.type === 'array') host.append(closing);
  return host;
}

function toggleNode(host: HTMLElement, node: ViewNode): void {
  if (!node.childCount) return;
  const children = host.querySelector<HTMLElement>(':scope > .children')!;
  const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle')!;
  const preview = host.querySelector<HTMLElement>(':scope > .row > .preview');
  const closing = host.querySelector<HTMLElement>(':scope > .closing');
  const willExpand = children.hidden;
  children.hidden = !willExpand;
  toggle.classList.toggle('expanded', willExpand);
  toggle.ariaExpanded = String(willExpand);
  if (preview) preview.textContent = willExpand ? preview.dataset.expanded ?? '' : preview.dataset.collapsed ?? '';
  if (closing) closing.hidden = !willExpand;
  if (willExpand) {
    expanded.add(node.id);
    if (!Number(children.dataset.loaded ?? 0)) {
      const inheritedDepth = host.dataset.inheritedExpansionDepth;
      requestChildren(node.id, children, 0, inheritedDepth === undefined ? undefined : Math.max(0, Number(inheritedDepth) - 1));
    }
  } else {
    expanded.delete(node.id);
  }
  scheduleVisibleLineNumbers();
  saveState();
}

function scheduleVisibleLineNumbers(): void {
  if (lineNumbersQueued) return;
  lineNumbersQueued = true;
  window.queueMicrotask(() => {
    lineNumbersQueued = false;
    renumberVisibleLines();
  });
}

function renumberVisibleLines(): void {
  let nextLine = 0;
  const items = Array.from(tree.querySelectorAll<HTMLElement>('.row, .closing'));
  for (const item of items) {
    const line = item.querySelector<HTMLElement>(':scope > .line');
    if (!line) continue;
    if (item.closest('[hidden]')) {
      line.textContent = '';
      continue;
    }
    line.textContent = String(++nextLine);
  }
  const digits = Math.max(1, String(nextLine).length);
  document.documentElement.style.setProperty('--viewer-line-number-width', `max(44px, ${digits + 2}ch)`);
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
    status.textContent = text.expandLimit;
  }
}

function revealCurrent(): void {
  applyMatches();
  if (currentMatch < 0) return;
  const match = matches[currentMatch];
  if (!tree.querySelector(`.node[data-id="${cssEscape(match.pathIds[0] ?? match.nodeId)}"]`)) {
    pendingReveal = true;
    requestChunk(Math.floor(match.rootIndex / chunkSize) * chunkSize);
    return;
  }
  for (const idValue of match.pathIds) expanded.add(idValue);
  ensureMatchPathLoaded(match);
  restoreExpanded(tree);
  const row = tree.querySelector<HTMLElement>(`.row[data-node-id="${cssEscape(match.nodeId)}"]`);
  row?.classList.add('current');
  row?.scrollIntoView({ block: 'center' });
  searchCount.textContent = `${currentMatch + 1}/${matches.length}`;
  saveState();
}

function ensureMatchPathLoaded(match: SearchMatch): void {
  for (let index = 1; index < match.pathIds.length; index += 1) {
    const parentId = match.pathIds[index - 1];
    const parent = tree.querySelector<HTMLElement>(`.node[data-id="${cssEscape(parentId)}"]`);
    const container = parent?.querySelector<HTMLElement>(':scope > .children');
    if (!container) return;
    const targetIndex = match.pathIndexes[index] ?? 0;
    const loadedCount = Number(container.dataset.loaded ?? 0);
    if (loadedCount <= targetIndex) {
      const pageStart = Math.floor(targetIndex / 100) * 100;
      requestChildren(parentId, container, pageStart);
      return;
    }
  }
}

function requestChildren(nodeId: string, container: HTMLElement, start: number, expansionDepth?: number): void {
  if (container.querySelector(`:scope > .children-page[data-start="${start}"]`)) return;
  const key = `${nodeId}:${start}`;
  if (requestedChildren.has(key)) return;
  requestedChildren.add(key);
  if (expansionDepth !== undefined) requestedExpansionDepth.set(key, expansionDepth);
  post({ type: 'requestChildren', requestId: id(), nodeId, start });
}

function updateChildrenLoadButton(host: HTMLElement, container: HTMLElement, nodeId: string): void {
  const previous = container.querySelector<HTMLButtonElement>(':scope > .children-more');
  if (previous) {
    loadObserver.unobserve(previous);
    previous.remove();
  }
  if (container.dataset.done === 'true') return;
  const button = document.createElement('button');
  button.className = 'children-more';
  button.textContent = text.loadMore;
  button.addEventListener('click', () => {
    const expansionDepth = nodeId === '$jsonl' ? undefined : lastItemExpansionDepth(container);
    requestChildren(nodeId, container, Number(container.dataset.loaded ?? 0), expansionDepth);
  });
  container.append(button);
  loadObserver.observe(button);
}

function lastItemExpansionDepth(container: HTMLElement): number {
  const pages = Array.from(container.querySelectorAll<HTMLElement>(':scope > .children-page'))
    .sort((left, right) => Number(left.dataset.start) - Number(right.dataset.start));
  const lastPage = pages.at(-1);
  const items = lastPage ? Array.from(lastPage.querySelectorAll<HTMLElement>(':scope > .node')) : [];
  const lastItem = items.at(-1);
  return lastItem ? expandedDepth(lastItem) : 0;
}

function expandedDepth(host: HTMLElement): number {
  const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle');
  if (!toggle?.classList.contains('expanded')) return 0;
  const children = host.querySelector<HTMLElement>(':scope > .children');
  if (!children || children.hidden) return 1;
  const descendants = Array.from(children.querySelectorAll<HTMLElement>(':scope > .children-page > .node'));
  return 1 + Math.max(0, ...descendants.map(expandedDepth));
}

function updateRootProgress(): void {
  let contiguous = 0;
  let reachedEnd = false;
  const pages = Array.from(tree.querySelectorAll<HTMLElement>(':scope > .root-page'))
    .sort((left, right) => Number(left.dataset.start) - Number(right.dataset.start));
  for (const page of pages) {
    if (Number(page.dataset.start) !== contiguous) break;
    contiguous += Number(page.dataset.count ?? 0);
    reachedEnd = page.dataset.done === 'true';
  }
  loaded = contiguous;
  done = reachedEnd || loaded >= totalRoots;
}

function updateChildProgress(container: HTMLElement): void {
  let contiguous = 0;
  let reachedEnd = false;
  const pages = Array.from(container.querySelectorAll<HTMLElement>(':scope > .children-page'))
    .sort((left, right) => Number(left.dataset.start) - Number(right.dataset.start));
  for (const page of pages) {
    if (Number(page.dataset.start) !== contiguous) break;
    contiguous += Number(page.dataset.count ?? 0);
    reachedEnd = page.dataset.done === 'true';
  }
  container.dataset.loaded = String(contiguous);
  container.dataset.done = String(reachedEnd);
}

function applyMatches(): void {
  document.querySelectorAll('.row.match, .row.current').forEach((item) => item.classList.remove('match', 'current'));
  for (const match of matches) tree.querySelector(`.row[data-node-id="${cssEscape(match.nodeId)}"]`)?.classList.add('match');
  searchCount.textContent = matches.length ? `${Math.max(currentMatch + 1, 1)}/${matches.length}` : search.value ? '0/0' : '';
}

function openSearch(): void {
  searchOpen = true;
  searchPanel.hidden = false;
  search.focus();
  search.select();
}

function closeSearch(): void {
  searchOpen = false;
  searchPanel.hidden = true;
  content.focus();
}

function cycleMatch(direction: number): void {
  if (!matches.length) return;
  currentMatch = (currentMatch + direction + matches.length) % matches.length;
  revealCurrent();
}

function restoreExpanded(root: ParentNode): void {
  for (const nodeId of expanded) {
    const host = root.querySelector<HTMLElement>(`.node[data-id="${cssEscape(nodeId)}"]`);
    if (!host) continue;
    const children = host.querySelector<HTMLElement>(':scope > .children');
    const toggle = host.querySelector<HTMLButtonElement>(':scope > .row > .toggle');
    if (toggle && !toggle.classList.contains('empty')) {
      if (children?.hidden) toggle.click();
      else {
        toggle.classList.add('expanded');
        toggle.ariaExpanded = 'true';
      }
    }
  }
}

function requestChunk(start: number): void {
  if ((done && start > 0) || requestedChunks.has(start)) return;
  if (tree.querySelector(`:scope > .root-page[data-start="${start}"]`)) return;
  requestedChunks.add(start);
  post({ type: 'requestChunk', requestId: id(), start });
}

function reset(): void {
  tree.replaceChildren();
  loaded = 0;
  totalRoots = 0;
  done = false;
  matches = [];
  currentMatch = -1;
  loadMore.hidden = true;
  status.textContent = '';
  requestedChunks.clear();
  requestedChildren.clear();
  requestedExpansionDepth.clear();
}

function saveState(): void { vscode.setState({ expanded: [...expanded], query: search.value, scrollTop: content.scrollTop }); }
function post(message: WebviewToExtension): void { vscode.postMessage(message); }
function id(): string { return `r${++requestSequence}`; }
function punctuation(value: string): HTMLElement { const span = document.createElement('span'); span.className = 'punctuation'; span.textContent = value; return span; }
function emptyState(text: string): HTMLElement { const div = document.createElement('div'); div.className = 'empty-state'; div.textContent = text; return div; }
function element<T extends HTMLElement>(idValue: string): T { return document.getElementById(idValue) as T; }
function cssEscape(value: string): string { return CSS.escape(value); }

post({ type: 'ready' });
