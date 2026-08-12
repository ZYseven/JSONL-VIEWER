import { DocumentSummary, SearchMatch, ViewNode } from '../model/documentModel';

export type WebviewToExtension =
  | { type: 'ready' }
  | { type: 'requestChunk'; requestId: string; start: number }
  | { type: 'requestChildren'; requestId: string; nodeId: string }
  | { type: 'requestDisplayValue'; requestId: string; nodeId: string }
  | { type: 'findMatches'; requestId: string; query: string }
  | { type: 'copy'; nodeId: string; mode: 'keyObject' | 'value' }
  | { type: 'refresh' };

export type ExtensionToWebview =
  | { type: 'document'; payload: DocumentSummary }
  | { type: 'chunkData'; requestId: string; start: number; nodes: ViewNode[]; done: boolean }
  | { type: 'childrenData'; requestId: string; nodeId: string; nodes: ViewNode[] }
  | { type: 'displayValue'; requestId: string; nodeId: string; value: string }
  | { type: 'searchResults'; requestId: string; matches: SearchMatch[] }
  | { type: 'error'; message: string; details?: string };
