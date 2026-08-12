import { parseJson } from '../parser/jsonParser';
import { parseJsonLines } from '../parser/jsonlParser';
import { JsonNode, JsonParseError, JsonlRecord, ParseIssue } from '../parser/types';

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
}

export interface DocumentSummary {
  kind: DocumentKind;
  total: number;
  issue?: ParseIssue;
}

export interface SearchMatch {
  nodeId: string;
  pathIds: string[];
  rootIndex: number;
}

export class DocumentModel {
  readonly kind: DocumentKind;
  readonly issue?: ParseIssue;
  private readonly roots: JsonNode[] = [];
  private readonly records: JsonlRecord[] = [];
  private readonly nodes = new Map<string, JsonNode>();
  private readonly paths = new Map<string, string[]>();
  private readonly rootIndexes = new Map<string, number>();

  constructor(text: string, fileName: string) {
    this.kind = /\.(jsonl|ndjson)$/i.test(fileName) ? 'jsonl' : 'json';
    if (this.kind === 'jsonl') {
      this.records = parseJsonLines(text);
      for (let index = 0; index < this.records.length; index += 1) {
        const record = this.records[index];
        if (record.node) this.index(record.node, [], index);
      }
    } else {
      try {
        const root = parseJson(text);
        this.roots = root.type === 'array' || root.type === 'object' ? root.children : [root];
        if (root.type === 'array' || root.type === 'object') {
          root.children.forEach((child, index) => this.index(child, [], index));
          this.nodes.set(root.id, root);
        } else {
          this.index(root, [], 0);
        }
      } catch (error) {
        if (!(error instanceof JsonParseError)) throw error;
        this.issue = error.issue;
      }
    }
  }

  summary(): DocumentSummary {
    return { kind: this.kind, total: this.kind === 'jsonl' ? this.records.length : this.roots.length, issue: this.issue };
  }

  chunk(start: number, size: number): { nodes: ViewNode[]; done: boolean } {
    if (this.issue) return { nodes: [], done: true };
    if (this.kind === 'jsonl') {
      const items = this.records.slice(start, start + size).map((record) => record.node
        ? this.toView(record.node, `Line ${record.line}`)
        : {
            id: record.id, type: 'error' as const, label: `Line ${record.line}`, line: record.line,
            endLine: record.line, childCount: 0, error: `${record.issue?.message} (${record.issue?.line}:${record.issue?.column})`
          });
      return { nodes: items, done: start + items.length >= this.records.length };
    }
    const items = this.roots.slice(start, start + size).map((node) => this.toView(node));
    return { nodes: items, done: start + items.length >= this.roots.length };
  }

  children(nodeId: string): ViewNode[] {
    return (this.nodes.get(nodeId)?.children ?? []).map((node) => this.toView(node));
  }

  search(query: string): SearchMatch[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const matches: SearchMatch[] = [];
    for (const node of this.nodes.values()) {
      const value = node.children.length ? '' : printableValue(node).toLocaleLowerCase();
      if ((node.key?.toLocaleLowerCase().includes(normalized)) || value.includes(normalized)) {
        matches.push({ nodeId: node.id, pathIds: this.paths.get(node.id) ?? [], rootIndex: this.rootIndexes.get(node.id) ?? 0 });
      }
    }
    return matches;
  }

  copy(nodeId: string, mode: 'keyObject' | 'value'): string | undefined {
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

  private index(node: JsonNode, ancestors: string[], rootIndex: number): void {
    this.nodes.set(node.id, node);
    this.paths.set(node.id, [...ancestors, node.id]);
    this.rootIndexes.set(node.id, rootIndex);
    for (const child of node.children) this.index(child, [...ancestors, node.id], rootIndex);
  }

  private toView(node: JsonNode, label?: string): ViewNode {
    const displayValue = node.children.length ? undefined : node.value;
    const truncated = typeof displayValue === 'string' && displayValue.length > 262_144;
    return {
      id: node.id,
      type: node.type,
      key: node.key,
      label: label ?? (node.key === undefined && node.keyOccurrence !== undefined ? `[${node.keyOccurrence}]` : undefined),
      value: truncated ? `${displayValue.slice(0, 512)}…` : displayValue,
      preview: node.type === 'object' ? `{${node.children.length}}` : node.type === 'array' ? `[${node.children.length}]` : undefined,
      line: node.start.line,
      endLine: node.end.line,
      childCount: node.children.length,
      duplicate: node.keyOccurrence !== undefined && node.keyOccurrence > 0,
      truncated,
      defaultExpanded: label !== undefined && node.children.length > 0
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
