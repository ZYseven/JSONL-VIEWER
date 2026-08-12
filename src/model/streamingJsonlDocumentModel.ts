import { createReadStream, ReadStream } from 'node:fs';
import { parseJson } from '../parser/jsonParser';
import { JsonNode, JsonParseError } from '../parser/types';
import { DocumentSummary, SearchMatch, ViewNode } from './documentModel';

interface StreamRecord {
  id: string;
  line: number;
  raw: string;
}

/** Incremental JSONL model used when retaining and indexing the whole file is too expensive. */
export class StreamingJsonlDocumentModel {
  private static readonly rootId = '$jsonl';
  readonly kind = 'jsonl' as const;
  private readonly records: StreamRecord[] = [];
  private readonly nodes = new Map<string, JsonNode>();
  private readonly paths = new Map<string, string[]>();
  private readonly pathIndexes = new Map<string, number[]>();
  private stream?: ReadStream;
  private iterator?: AsyncIterator<Buffer>;
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private line = 0;
  private eof = false;
  private disposed = false;
  private loading: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.dispose(), { once: true });
  }

  async initialize(): Promise<void> {
    await this.ensureRecords(1);
  }

  summary(): DocumentSummary {
    return {
      kind: 'jsonl',
      total: this.records.length || !this.eof ? 1 : 0,
      recordCount: this.eof ? this.records.length : undefined
    };
  }

  chunk(start: number): { nodes: ViewNode[]; done: boolean } {
    if (start > 0 || (!this.records.length && this.eof)) return { nodes: [], done: true };
    return { nodes: [this.rootView()], done: true };
  }

  async children(nodeId: string, start = 0, size = 100): Promise<{ nodes: ViewNode[]; done: boolean }> {
    if (nodeId === StreamingJsonlDocumentModel.rootId) {
      await this.ensureRecords(start + size);
      const items = this.records.slice(start, start + size).map((record, localIndex) => {
        const recordIndex = start + localIndex;
        try {
          return this.toView(this.parseRecord(record, recordIndex), recordIndex < this.records.length - 1 || !this.eof);
        } catch (error) {
          if (!(error instanceof JsonParseError)) throw error;
          return {
            id: record.id,
            type: 'error' as const,
            line: record.line,
            endLine: record.line,
            childCount: 0,
            trailingComma: recordIndex < this.records.length - 1 || !this.eof,
            error: `${error.issue.message} (${error.issue.line}:${error.issue.column})`
          };
        }
      });
      return { nodes: items, done: this.eof && start + items.length >= this.records.length };
    }
    const children = this.nodes.get(nodeId)?.children ?? [];
    const items = children.slice(start, start + size).map((node, index) => this.toView(
      node,
      start + index < children.length - 1
    ));
    return { nodes: items, done: start + items.length >= children.length };
  }

  search(query: string): SearchMatch[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    const matches: SearchMatch[] = [];
    for (const [nodeId, node] of this.nodes) {
      const value = node.children.length ? '' : printableValue(node).toLocaleLowerCase();
      if (node.key?.toLocaleLowerCase().includes(normalized) || value.includes(normalized)) {
        matches.push({
          nodeId,
          pathIds: this.paths.get(nodeId) ?? [],
          pathIndexes: this.pathIndexes.get(nodeId) ?? [],
          rootIndex: 0
        });
      }
    }
    return matches.sort((left, right) => compareIndexes(left.pathIndexes, right.pathIndexes));
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.destroy();
  }

  private ensureRecords(count: number): Promise<void> {
    const operation = this.loading.then(async () => {
      this.throwIfCancelled();
      while (!this.eof && this.records.length < count) {
        this.throwIfCancelled();
        if (!this.consumeBufferedLine()) {
          this.openStream();
          const next = await this.iterator!.next();
          if (next.done) {
            this.finishBufferedLine();
            this.eof = true;
            this.stream?.destroy();
            break;
          }
          this.pending = this.pending.length ? Buffer.concat([this.pending, next.value]) : next.value;
        }
      }
    });
    this.loading = operation.catch(() => undefined);
    return operation;
  }

  private openStream(): void {
    if (this.iterator || this.eof) return;
    this.stream = createReadStream(this.filePath, { highWaterMark: 64 * 1024 });
    this.iterator = this.stream[Symbol.asyncIterator]();
  }

  private consumeBufferedLine(): boolean {
    const newline = this.pending.indexOf(0x0a);
    if (newline < 0) return false;
    let raw = this.pending.subarray(0, newline);
    this.pending = this.pending.subarray(newline + 1);
    if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
    this.addRecord(raw.toString('utf8'));
    return true;
  }

  private finishBufferedLine(): void {
    if (!this.pending.length) return;
    let raw = this.pending;
    this.pending = Buffer.alloc(0);
    if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
    this.addRecord(raw.toString('utf8'));
  }

  private addRecord(raw: string): void {
    this.line += 1;
    const normalized = this.line === 1 ? raw.replace(/^\ufeff/, '') : raw;
    if (normalized.trim()) this.records.push({ id: `record:${this.line}`, line: this.line, raw: normalized });
  }

  private throwIfCancelled(): void {
    if (this.disposed || this.signal.aborted) {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }
  }

  private parseRecord(record: StreamRecord, recordIndex: number): JsonNode {
    const cached = this.nodes.get(record.id);
    if (cached) return cached;
    const node = parseJson(record.raw, { lineOffset: record.line - 1, idPrefix: record.id });
    this.index(node, [StreamingJsonlDocumentModel.rootId], [0], recordIndex);
    return node;
  }

  private index(node: JsonNode, ancestors: string[], ancestorIndexes: number[], siblingIndex: number): void {
    this.nodes.set(node.id, node);
    this.paths.set(node.id, [...ancestors, node.id]);
    this.pathIndexes.set(node.id, [...ancestorIndexes, siblingIndex]);
    node.children.forEach((child, index) => this.index(child, [...ancestors, node.id], [...ancestorIndexes, siblingIndex], index));
  }

  private rootView(): ViewNode {
    return {
      id: StreamingJsonlDocumentModel.rootId,
      type: 'array',
      preview: this.eof ? `[${this.records.length}]` : `[${this.records.length}+]`,
      line: this.records[0]?.line ?? 1,
      endLine: this.records.at(-1)?.line ?? 1,
      childCount: this.records.length + (this.eof ? 0 : 1),
      defaultExpanded: true
    };
  }

  private toView(node: JsonNode, trailingComma = false): ViewNode {
    const displayValue = node.children.length ? undefined : node.type === 'number' ? node.raw : node.value;
    const truncated = typeof displayValue === 'string' && displayValue.length > 262_144;
    return {
      id: node.id,
      type: node.type,
      key: node.key,
      value: truncated ? `${displayValue.slice(0, 512)}...` : displayValue,
      preview: node.type === 'object' ? `{${node.children.length}}` : node.type === 'array' ? `[${node.children.length}]` : undefined,
      line: node.start.line,
      endLine: node.end.line,
      childCount: node.children.length,
      duplicate: node.keyOccurrence !== undefined && node.keyOccurrence > 0,
      truncated,
      defaultExpanded: node.children.length > 0,
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
    return pad + (node.type === 'object' ? `${JSON.stringify(child.key)}: ${value}` : value);
  });
  return `${open}\n${items.join(',\n')}\n${'  '.repeat(depth)}${close}`;
}

function compareIndexes(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
