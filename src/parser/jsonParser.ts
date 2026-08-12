import { JsonNode, JsonParseError, JsonNodeType, SourceLocation } from './types';

export interface ParseOptions {
  lineOffset?: number;
  idPrefix?: string;
}

export function parseJson(source: string, options: ParseOptions = {}): JsonNode {
  const parser = new Parser(source, options.lineOffset ?? 0, options.idPrefix ?? '$');
  return parser.parse();
}

class Parser {
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(
    private readonly source: string,
    private readonly lineOffset: number,
    private readonly idPrefix: string
  ) {}

  parse(): JsonNode {
    if (this.source.charCodeAt(0) === 0xfeff) this.advance();
    this.skipWhitespace();
    const node = this.parseValue(this.idPrefix);
    this.skipWhitespace();
    if (!this.eof()) this.fail('Unexpected token');
    return node;
  }

  private parseValue(id: string, key?: string, occurrence?: number): JsonNode {
    const start = this.location();
    const rawStart = this.offset;
    const char = this.peek();
    let type: JsonNodeType;
    let value: JsonNode['value'];
    let children: JsonNode[] = [];

    if (char === '{') {
      type = 'object';
      children = this.parseObject(id);
    } else if (char === '[') {
      type = 'array';
      children = this.parseArray(id);
    } else if (char === '"') {
      type = 'string';
      value = this.parseString();
    } else if (char === '-' || this.isDigit(char)) {
      type = 'number';
      value = this.parseNumber();
    } else if (this.consumeLiteral('true')) {
      type = 'boolean';
      value = true;
    } else if (this.consumeLiteral('false')) {
      type = 'boolean';
      value = false;
    } else if (this.consumeLiteral('null')) {
      type = 'null';
      value = null;
    } else {
      this.fail('Expected a JSON value');
    }

    return {
      id,
      type,
      key,
      keyOccurrence: occurrence,
      value,
      raw: this.source.slice(rawStart, this.offset),
      start,
      end: this.location(),
      children
    };
  }

  private parseObject(parentId: string): JsonNode[] {
    this.expect('{');
    this.skipWhitespace();
    const children: JsonNode[] = [];
    const occurrences = new Map<string, number>();
    if (this.peek() === '}') {
      this.advance();
      return children;
    }
    while (true) {
      if (this.peek() !== '"') this.fail('Expected an object key');
      const key = this.parseString();
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      children.push(this.parseValue(`${parentId}/${escapeId(key)}#${occurrence}`, key, occurrence));
      this.skipWhitespace();
      if (this.peek() === '}') {
        this.advance();
        return children;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseArray(parentId: string): JsonNode[] {
    this.expect('[');
    this.skipWhitespace();
    const children: JsonNode[] = [];
    if (this.peek() === ']') {
      this.advance();
      return children;
    }
    let index = 0;
    while (true) {
      children.push(this.parseValue(`${parentId}/${index}`, undefined, index));
      index += 1;
      this.skipWhitespace();
      if (this.peek() === ']') {
        this.advance();
        return children;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.expect('"');
    while (!this.eof()) {
      const char = this.peek();
      if (char === '"') {
        this.advance();
        try {
          return JSON.parse(this.source.slice(start, this.offset)) as string;
        } catch {
          this.fail('Invalid string escape');
        }
      }
      if (char === '\\') {
        this.advance();
        if (this.eof()) this.fail('Unterminated string');
        if (this.peek() === 'u') {
          this.advance();
          for (let i = 0; i < 4; i += 1) {
            if (!/[0-9a-fA-F]/.test(this.peek())) this.fail('Invalid unicode escape');
            this.advance();
          }
          continue;
        }
        if (!'"\\/bfnrt'.includes(this.peek())) this.fail('Invalid string escape');
        this.advance();
        continue;
      }
      if (char.charCodeAt(0) < 0x20) this.fail('Unescaped control character in string');
      this.advance();
    }
    this.fail('Unterminated string');
  }

  private parseNumber(): number {
    const start = this.offset;
    if (this.peek() === '-') this.advance();
    if (this.peek() === '0') {
      this.advance();
      if (this.isDigit(this.peek())) this.fail('Leading zero is not allowed');
    } else {
      if (!this.isDigitOneToNine(this.peek())) this.fail('Invalid number');
      while (this.isDigit(this.peek())) this.advance();
    }
    if (this.peek() === '.') {
      this.advance();
      if (!this.isDigit(this.peek())) this.fail('Expected digit after decimal point');
      while (this.isDigit(this.peek())) this.advance();
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance();
      if (this.peek() === '+' || this.peek() === '-') this.advance();
      if (!this.isDigit(this.peek())) this.fail('Expected exponent digits');
      while (this.isDigit(this.peek())) this.advance();
    }
    return Number(this.source.slice(start, this.offset));
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.source.startsWith(literal, this.offset)) return false;
    for (let i = 0; i < literal.length; i += 1) this.advance();
    return true;
  }

  private skipWhitespace(): void {
    while (!this.eof() && ' \t\r\n'.includes(this.peek())) this.advance();
  }

  private expect(char: string): void {
    if (this.peek() !== char) this.fail(`Expected '${char}'`);
    this.advance();
  }

  private advance(): void {
    const char = this.source[this.offset++];
    if (char === '\r') {
      this.line += 1;
      this.column = 1;
    } else if (char === '\n') {
      if (this.source[this.offset - 2] !== '\r') this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private peek(): string { return this.source[this.offset] ?? ''; }
  private eof(): boolean { return this.offset >= this.source.length; }
  private isDigit(char: string): boolean { return char >= '0' && char <= '9'; }
  private isDigitOneToNine(char: string): boolean { return char >= '1' && char <= '9'; }
  private location(): SourceLocation {
    return { line: this.line + this.lineOffset, column: this.column, offset: this.offset };
  }
  private fail(message: string): never {
    const location = this.location();
    throw new JsonParseError({ message, ...location });
  }
}

function escapeId(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1').replace(/#/g, '~2');
}
