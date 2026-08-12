export type JsonNodeType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

export interface JsonNode {
  id: string;
  type: JsonNodeType;
  key?: string;
  keyOccurrence?: number;
  value?: string | number | boolean | null;
  raw: string;
  start: SourceLocation;
  end: SourceLocation;
  children: JsonNode[];
}

export interface ParseIssue {
  message: string;
  line: number;
  column: number;
  offset: number;
}

export interface JsonlRecord {
  id: string;
  line: number;
  node?: JsonNode;
  issue?: ParseIssue;
  raw: string;
}

export class JsonParseError extends Error {
  constructor(public readonly issue: ParseIssue) {
    super(`${issue.message} at ${issue.line}:${issue.column}`);
    this.name = 'JsonParseError';
  }
}
