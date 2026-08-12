import { parseJson } from '../parser/jsonParser';
import { JsonNode, JsonParseError, ParseIssue } from '../parser/types';

export type DocumentKind = 'json' | 'jsonl';

export interface ViewNode {
  id: string;
  type: JsonNode['type'] | 'error';
  key?: string;
  label?: string;
  value?: string | number | boolean | null;
  preview?: string;
  line: number;
  endLine: number;
  childCount: number;
  duplicate?: boolean;
  children?: ViewNode[];
  error?: string;
  truncated?: boolean;
  defaultExpanded?: boolean;
  trailingComma?: boolean;
}

export interface DocumentSummary {
  kind: DocumentKind;
  total: number;
  recordCount?: number;
  issue?: ParseIssue;
}

export interface SearchMatch {
  nodeId: string;
  pathIds: string[];
  pathIndexes: number[];
  rootIndex: number;
}

interface IndexedJsonlRecord {
  id: string;
  line: number;
  start: number;
  end: number;
}

export class DocumentModel {
  private static readonly jsonlRootId = '$jsonl';
  private static readonly jsonlRecordsId = '$jsonl/records';
  readonly kind: DocumentKind;
  readonly issue?: ParseIssue;
  private readonly roots: JsonNode[] = [];
  private readonly records: IndexedJsonlRecord[] = [];
  private readonly source: string;
  private readonly nodes = new Map<string, JsonNode>();
  private readonly paths = new Map<string, string[]>();
  private readonly pathIndexes = new Map<string, number[]>();
  private readonly rootIndexes = new Map<string, number>();

  constructor(text: string, fileName: string) {
    this.source = text;
    this.kind = /\.(jsonl|ndjson)$/i.test(fileName) ? 'jsonl' : 'json';
    if (this.kind === 'jsonl') {
      this.records = indexJsonLines(text);
    } else {
      try {
        const root = parseJson(text);
        this.roots = [root];
        this.index(root, [], [], 0, 0);
      } catch (error) {
        if (!(error instanceof JsonParseError)) throw error;
        this.issue = error.issue;
      }
    }
  }

  summary(): DocumentSummary {
    return this.kind === 'jsonl'
      ? { kind: this.kind, total: this.records.length ? 1 : 0, recordCount: this.records.length, issue: this.issue }
      : { kind: this.kind, total: this.roots.length, issue: this.issue };
  }

  chunk(start: number, size: number): { nodes: ViewNode[]; done: boolean } {
    if (this.issue) return { nodes: [], done: true };
    if (this.kind === 'jsonl') {
      if (start > 0 || this.records.length === 0) return { nodes: [], done: true };
      return { nodes: [this.jsonlRootView()], done: true };
    }
    const items = this.roots.slice(start, start + size).map((node) => this.toView(node));
    return { nodes: items, done: start + items.length >= this.roots.length };
  }

  children(nodeId: string, start = 0, size = 100): { nodes: ViewNode[]; done: boolean } {
    if (this.kind === 'jsonl' && nodeId === DocumentModel.jsonlRootId) {
      return start > 0 ? { nodes: [], done: true } : { nodes: [this.jsonlRecordsView()], done: true };
    }
    if (this.kind === 'jsonl' && nodeId === DocumentModel.jsonlRecordsId) {
      const items = this.records.slice(start, start + size).map((record, localIndex) => {
        const recordIndex = start + localIndex;
        try {
          const node = this.parseRecord(record, recordIndex);
          return this.toView(node, undefined, recordIndex < this.records.length - 1);
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error;
          return {
            id: record.id,
            type: 'error' as const,
            line: record.line,
            endLine: record.line,
            childCount: 0,
            trailingComma: recordIndex < this.records.length - 1,
            error: `${error.issue.message} (${error.issue.line}:${error.issue.column})`
          };
        }
      });
      return { nodes: items, done: start + items.length >= this.records.length };
    }
    const children = this.nodes.get(nodeId)?.children ?? [];
    const items = children.slice(start, start + size).map((node, localIndex) => this.toView(
      node,
      undefined,
      start + localIndex < children.length - 1
    ));
    return { nodes: items, done: start + items.length >= children.length };
  }

  search(query: string): SearchMatch[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const matches: SearchMatch[] = [];
    if (this.kind === 'jsonl') {
      for (let index = 0; index < this.records.length; index += 1) {
        try {
          const record = this.records[index];
          const raw = this.source.slice(record.start, record.end);
          const node = this.nodes.get(record.id) ?? parseJson(raw, { lineOffset: record.line - 1, idPrefix: record.id });
          const recordMatches: SearchMatch[] = [];
          collectMatches(
            node,
            normalized,
            0,
            [DocumentModel.jsonlRootId, DocumentModel.jsonlRecordsId],
            [0, 0],
            index,
            recordMatches
          );
          if (recordMatches.length) {
            if (!this.nodes.has(record.id)) this.index(
              node,
              [DocumentModel.jsonlRootId, DocumentModel.jsonlRecordsId],
              [0, 0],
              0,
              index
            );
            matches.push(...recordMatches);
          }
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error;
        }
      }
    } else {
      for (const node of this.nodes.values()) {
        const value = node.children.length ? '' : printableValue(node).toLocaleLowerCase();
        if ((node.key?.toLocaleLowerCase().includes(normalized)) || value.includes(normalized)) {
          matches.push({
            nodeId: node.id,
            pathIds: this.paths.get(node.id) ?? [],
            pathIndexes: this.pathIndexes.get(node.id) ?? [],
            rootIndex: this.rootIndexes.get(node.id) ?? 0
          });
        }
      }
    }
    matches.sort((left, right) => left.rootIndex - right.rootIndex || compareIndexes(left.pathIndexes, right.pathIndexes));
    return matches;
  }

  copy(nodeId: string, mode: 'keyObject' | 'value'): string | undefined {
    if (this.kind === 'jsonl' && nodeId === DocumentModel.jsonlRecordsId) return this.serializeJsonlArray();
    if (this.kind === 'jsonl' && nodeId === DocumentModel.jsonlRootId) {
      return `{\n${indentMultiline(this.serializeJsonlArray(), 1)}\n}`;
    }
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    if (mode === 'keyObject' && node.key !== undefined) {
      return `{\n  ${JSON.stringify(node.key)}: ${serializeNode(node, 1)}\n}`;
    }
    return serializeNode(node, 0);
  }

  displayValue(nodeId: string): string | undefined {
    const node = this.nodes.get(nodeId);
    if (!node || node.children.length) return undefined;
    return node.type === 'string' ? JSON.stringify(node.value) : node.raw;
  }

  dispose(): void {
    // Kept for parity with streaming document models.
  }

  private parseRecord(record: IndexedJsonlRecord, rootIndex: number): JsonNode {
    const cached = this.nodes.get(record.id);
    if (cached) return cached;
    const raw = this.source.slice(record.start, record.end);
    const node = parseJson(raw, { lineOffset: record.line - 1, idPrefix: record.id });
    this.index(
      node,
      [DocumentModel.jsonlRootId, DocumentModel.jsonlRecordsId],
      [0, 0],
      0,
      rootIndex
    );
    return node;
  }

  private jsonlRootView(): ViewNode {
    const firstLine = this.records[0]?.line ?? 1;
    const lastLine = this.records[this.records.length - 1]?.line ?? firstLine;
    return {
      id: DocumentModel.jsonlRootId,
      type: 'object',
      preview: '{1}',
      line: firstLine,
      endLine: lastLine,
      childCount: 1,
      defaultExpanded: true
    };
  }

  private jsonlRecordsView(): ViewNode {
    const firstLine = this.records[0]?.line ?? 1;
    const lastLine = this.records[this.records.length - 1]?.line ?? firstLine;
    return {
      id: DocumentModel.jsonlRecordsId,
      type: 'array',
      preview: `[${this.records.length}]`,
      line: firstLine,
      endLine: lastLine,
      childCount: this.records.length,
      defaultExpanded: true
    };
  }

  private serializeJsonlArray(): string {
    if (!this.records.length) return '[]';
    const values = this.records.map((record) => this.source.slice(record.start, record.end).trim());
    return `[\n${values.map((value) => indentMultiline(value, 1)).join(',\n')}\n]`;
  }

  private index(node: JsonNode, ancestors: string[], ancestorIndexes: number[], rootIndex: number, siblingIndex: number): void {
    this.nodes.set(node.id, node);
    this.paths.set(node.id, [...ancestors, node.id]);
    this.pathIndexes.set(node.id, [...ancestorIndexes, siblingIndex]);
    this.rootIndexes.set(node.id, rootIndex);
    node.children.forEach((child, index) => this.index(
      child,
      [...ancestors, node.id],
      [...ancestorIndexes, siblingIndex],
      rootIndex,
      index
    ));
  }

  private toView(node: JsonNode, label?: string, trailingComma = false): ViewNode {
    const displayValue = node.children.length ? undefined : node.type === 'number' ? node.raw : node.value;
    const truncated = typeof displayValue === 'string' && displayValue.length > 262_144;
    return {
      id: node.id,
      type: node.type,
      key: node.key,
      label,
      value: truncated ? `${displayValue.slice(0, 512)}…` : displayValue,
      preview: node.type === 'object' ? `{${node.children.length}}` : node.type === 'array' ? `[${node.children.length}]` : undefined,
      line: node.start.line,
      endLine: node.end.line,
      childCount: node.children.length,
      duplicate: node.keyOccurrence !== undefined && node.keyOccurrence > 0,
      truncated,
      defaultExpanded: node.children.length > 0 && (label !== undefined || node.key === undefined),
      trailingComma
    };
  }
}

function printableValue(node: JsonNode): string {
  return node.type === 'string' ? String(node.value) : node.raw;
}

function serializeNode(node: JsonNode, depth: number): string {
  if (!node.children.length && node.type !== 'object' && node.type !== 'array') {
    return node.type === 'string' ? JSON.stringify(node.value) : node.raw;
  }
  const open = node.type === 'object' ? '{' : '[';
  const close = node.type === 'object' ? '}' : ']';
  if (!node.children.length) return open + close;
  const pad = '  '.repeat(depth + 1);
  const items = node.children.map((child) => {
    const value = serializeNode(child, depth + 1);
    const prefixed = node.type === 'object' ? `${JSON.stringify(child.key)}: ${value}` : value;
    return pad + prefixed;
  });
  return `${open}\n${items.join(',\n')}\n${'  '.repeat(depth)}${close}`;
}

function indexJsonLines(source: string): IndexedJsonlRecord[] {
  const records: IndexedJsonlRecord[] = [];
  let line = 1;
  let lineStart = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (lineStart <= source.length) {
    const lf = source.indexOf('\n', lineStart);
    const cr = source.indexOf('\r', lineStart);
    const candidates = [lf, cr].filter((offset) => offset >= 0);
    const offset = candidates.length ? Math.min(...candidates) : source.length;
    const raw = source.slice(lineStart, offset);
    if (raw.trim().length > 0) records.push({ id: `record:${line}`, line, start: lineStart, end: offset });
    if (offset === source.length) break;
    lineStart = offset + (source[offset] === '\r' && source[offset + 1] === '\n' ? 2 : 1);
    line += 1;
  }
  return records;
}

function indentMultiline(value: string, depth: number): string {
  const indent = '  '.repeat(depth);
  return value.split(/\r\n|\r|\n/).map((line) => indent + line).join('\n').trimStart();
}

function compareIndexes(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function collectMatches(
  node: JsonNode,
  query: string,
  rootIndex: number,
  ancestors: string[],
  ancestorIndexes: number[],
  siblingIndex: number,
  matches: SearchMatch[]
): void {
  const pathIds = [...ancestors, node.id];
  const pathIndexes = [...ancestorIndexes, siblingIndex];
  const value = node.children.length ? '' : printableValue(node).toLocaleLowerCase();
  if (node.key?.toLocaleLowerCase().includes(query) || value.includes(query)) {
    matches.push({ nodeId: node.id, pathIds, pathIndexes, rootIndex });
  }
  node.children.forEach((child, index) => collectMatches(child, query, rootIndex, pathIds, pathIndexes, index, matches));
}
