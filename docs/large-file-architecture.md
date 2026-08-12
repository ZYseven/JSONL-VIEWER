# JSON/JSONL large-file architecture

## Scope

This note records the evidence and implementation direction for `json viewer` when a JSONL or JSON file is large enough that opening it must not delay other editor tabs. The target is a read-only custom editor, including `file:` resources and remote VS Code file-system providers.

## What VS Code does

VS Code deliberately avoids putting very large text documents into the extension host. The maintainer explanation in [microsoft/vscode#3147](https://github.com/microsoft/vscode/issues/3147) describes the policy that motivated this: the full document is no longer synchronized to extensions once it is large, because duplicating text across processes is too costly. Extension code must therefore not make `TextDocument.getText()` its large-file transport.

The current workbench source follows the same principle at the file-service layer. [`TextFileService.doRead`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textfile/browser/textFileService.ts#L209-L243) creates a `CancellationTokenSource`, calls `fileService.readFileStream(...)` for a stream-capable read, and cancels the source if decode/identification fails so a large binary file stops being read promptly. Its public [`readStream`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/textfile/browser/textFileService.ts#L199-L207) preserves the decoded stream instead of immediately joining all chunks; `read()` joins strings only for a caller that explicitly asks for the complete value.

**Implication:** the extension should obtain bytes through `workspace.fs` for provider compatibility, but it must not eagerly turn all bytes into one `string` and then synchronously build an index. The current `readFile -> TextDecoder.decode -> DocumentModel(fullText)` chain has the exact allocation and event-loop-blocking pattern this policy avoids.

## Platform APIs available to the extension host

For local `file:` URIs, Node supplies the pieces needed for a bounded JSONL reader:

- [`fs.createReadStream`](https://nodejs.org/api/fs.html#fscreatereadstreampath-options) accepts `start`, `end`, `highWaterMark`, and `AbortSignal`. `start` and `end` are byte offsets, so later JSONL pages can be read without re-reading the prefix of a multi-gigabyte file.
- [`fs.promises.readFile`](https://nodejs.org/api/fs.html#fspromisesreadfilepath-options) supports `AbortSignal`, but it resolves with the whole file and is therefore only suitable below the small-file threshold. Node documents cancellation as best effort; callers must still ignore stale results after an abort.
- [`readline.createInterface`](https://nodejs.org/api/readline.html#example-read-file-stream-line-by-line) can split a `ReadStream` by line with `crlfDelay: Infinity`, which correctly treats CRLF as one record boundary. Node cautions that `for await...of` has lower throughput than the `'line'` event API ([`rl[Symbol.asyncIterator]`](https://nodejs.org/api/readline.html#rlsymbolasynciterator)); use an event-driven bounded batch when throughput matters.

For non-local schemes such as WSL/Remote/virtual file systems, Node paths are not authoritative. `workspace.fs.readFile` is portable but whole-file only in the public API. The implementation should retain a guarded small-file fallback for those resources, show a clear size-limit message for a large non-local JSONL resource, and add a remote-range reader only if VS Code later exposes one publicly. It must never assume `uri.fsPath` is usable outside `file:`.

## Mature open-source patterns

[bigJson](https://github.com/hi-malay/bigJson) is a native large-JSON viewer. Its source separates an indexed document backend from the rendered rows:

- [`src-tauri/src/commands.rs`](https://github.com/hi-malay/bigJson/blob/main/src-tauri/src/commands.rs#L91-L113) exposes `get_children(id, offset, limit)`, returning only a page of direct children.
- [`src/hooks/use-tree.ts`](https://github.com/hi-malay/bigJson/blob/main/src/hooks/use-tree.ts#L12-L31) caches fetched pages and expands a node lazily; the page size is 500.
- [`src/components/tree-view.tsx`](https://github.com/hi-malay/bigJson/blob/main/src/components/tree-view.tsx#L15-L24) uses `@tanstack/react-virtual`, rendering only virtual items with a small overscan window.

That design is applicable even though this extension keeps its UI in a VS Code webview: tree data retrieval is paginated, while DOM rendering is bounded by the viewport. A full JSON parser/index is still expensive for a giant monolithic `.json`, but it need not also create millions of DOM nodes.

[JSLON](https://github.com/skirdey-inflection/jslon) is an open-source native viewer focused on JSONL/CSV/TSV. Its project documentation describes memory-mapped access plus virtualized rendering. The transferable lesson is not memory mapping itself (which is not exposed by Node's portable extension-host API), but its bounded-working-set goal: file bytes should stay on disk until the active page needs them, and the UI should materialize only visible/expanded rows.

## Recommended architecture for this extension

### 1. Split the document backend by format and size

Keep the existing in-memory `DocumentModel` only for ordinary files. Introduce a `StreamingJsonlDocumentModel` for local JSONL files at or above a conservative threshold (for example 8 MiB). Define the backend surface around operations the webview actually needs:

```ts
interface ViewerDocument {
  readonly kind: 'json' | 'jsonl';
  summary(): DocumentSummary;
  chunk(offset: number, limit: number, signal?: AbortSignal): Promise<ChunkResult>;
  children(id: string): Promise<ChunkResult>;
  copy(id: string): Promise<string | undefined>;
  dispose(): void;
}
```

The provider should `await` these methods and attach a monotonically increasing load generation to every request. A completion whose generation no longer matches the active panel must be discarded. This protects the small-file tab even when an underlying platform operation cannot be interrupted immediately.

### 2. Make JSONL truly incremental

For the first paint, open a `createReadStream` with an `AbortSignal`, decode only enough lines for the first UI page (for example 100 to 200 JSON records), parse those records independently, and return. Preserve only:

- the parsed/raw records currently loaded;
- the byte offset after the last complete newline;
- the record count loaded so far;
- a short trailing buffer for a line crossing a byte chunk.

On **Load more**, reopen a range stream at the saved offset and read until the next batch is complete. Byte offsets must advance using bytes, not JavaScript string length, so multi-byte UTF-8 keys and values remain correct. The cleanest initial implementation is an event-driven `ReadStream` plus a `StringDecoder('utf8')`, which preserves incomplete UTF-8 sequences between chunks. `readline` is appropriate for a simple first version, but Node documents its async iterator as slower for performance-sensitive readers.

JSONL lines are independent JSON values. Parse each requested record only after it is selected for display. Malformed lines should become an error node carrying its physical line number, rather than failing the whole viewer.

### 3. Cancellation and isolation are required, not optional

Each editor panel owns a controller/model. On panel dispose, refresh, or replacement of the current model:

1. call `controller.abort()`;
2. call `readStream.destroy()` and `readline.close()` if they exist;
3. dispose the model and remove its webview message listener;
4. ignore all messages/results belonging to the retired generation.

No global pending-load promise, queue, or mutable current model may be shared across panels. In particular, a large panel's stream must not be awaited from the request handler for a small panel. This directly addresses the observed case where a small file stays loading after a large file was opened first.

### 4. Bound both data and DOM work

Use two independent limits:

- **record paging:** JSONL root children are fetched in batches. The existing inline `Load more` control is the correct interaction point, but it must request the next disk range rather than append from a pre-built all-file index.
- **row virtualization:** once the expanded row count is large, render a scroll-window plus overscan, not one DOM element for every loaded row. The `bigJson` implementation is a direct model: flatten only the expanded/cached tree, then calculate visible row indices from `scrollTop`, fixed row height, and viewport height. A dependency is optional; this is straightforward with native DOM if preserving the extension's minimal bundle matters.

Nested children of an already parsed JSONL record can continue to use the existing lazy child endpoint. Put a per-record size cap on eager parsing, so one unusually large line does not defeat the page budget.

### 5. Handle large monolithic JSON separately

A JSON array/object is not generally safely pageable at newline boundaries. Do not promise the same instant-open behavior without a streaming JSON parser or an indexer.

Initial policy:

- small `.json`: current full read/parse path;
- large `.json`: move parse/index work to a Node `Worker` so it cannot block the extension-host event loop, retain only a compact node index, and expose children by page;
- if the file exceeds a configurable safety cap before that worker/indexer exists, show a deliberate read-only limit message rather than freezing the editor.

The worker still needs cancellation and generation checks; terminating the worker on panel disposal is the hard stop. Full support for virtual/remote resources remains a separate adapter concern.

## Delivery order

1. Ship the local streaming JSONL backend with first-page load, `Load more`, controller cancellation, and generation checks.
2. Add row virtualization when users can accumulate enough loaded records to make DOM creation visible in profiling.
3. Move large `.json` parsing/indexing to a worker and make child retrieval paginated.
4. Profile with a representative 344 MB JSONL file and a concurrently opened small JSONL. Success means the small file first-paints promptly after the tab switch, memory scales with loaded pages rather than total JSONL size, and closing the large panel halts disk/CPU work.

## Non-goals for the first implementation

- No whole-file search over an unloaded multi-gigabyte JSONL file. It requires a cancellable background scan or persistent index and must not run on the extension-host request path.
- No use of private VS Code file-service APIs. The public extension API cannot currently provide a portable streaming/range read for all URI schemes.
- No assumption that a `vscode.workspace.fs.readFile` abort makes synchronous parsing cancellable. The model must avoid starting whole-file parsing for large JSONL in the first place.
