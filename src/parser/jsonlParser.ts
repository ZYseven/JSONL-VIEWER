import { parseJson } from './jsonParser';
import { JsonlRecord, JsonParseError } from './types';

export function parseJsonLines(source: string): JsonlRecord[] {
  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const records: JsonlRecord[] = [];
  const lines = normalized.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim().length === 0) continue;
    const line = index + 1;
    try {
      records.push({ id: `record:${line}`, line, raw, node: parseJson(raw, { lineOffset: index, idPrefix: `record:${line}` }) });
    } catch (error) {
      if (!(error instanceof JsonParseError)) throw error;
      records.push({ id: `record:${line}`, line, raw, issue: error.issue });
    }
  }
  return records;
}
