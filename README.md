# JSONL Viewer

JSONL Viewer is a focused, read-only VS Code viewer for `.json`, `.jsonl`, and `.ndjson` files. It presents data as a collapsible tree while retaining source line numbers and duplicate object keys.

## Features

- Strict JSON parsing with isolated per-line errors for JSONL and NDJSON.
- Expandable objects and arrays with VS Code theme-aware syntax colors.
- Click a property key to copy `{ "key": value }` as formatted JSON.
- Click a value to copy its standard JSON representation.
- Case-insensitive search across all keys and scalar values. Use `Enter` and `Shift+Enter` to move between matches.
- Incremental top-level rendering: 200 JSONL records or 100 JSON entries per chunk.
- Automatic refresh when the underlying text document changes.
- Duplicate-key warnings and original source line ranges.
- State restoration for expansion, search, and scroll position.

The viewer does not edit or save files. Use VS Code's built-in **Reopen Editor With** action whenever you need the text editor.

## Usage

1. Open a JSON, JSONL, or NDJSON file.
2. Run **View: Reopen Editor With...** from the Command Palette or use the editor title context menu.
3. Select **JSONL Viewer**.
4. Optionally choose **Configure default editor for...** in VS Code to make it the default for that file extension.

Toolbar actions provide search, expand all, collapse all, and refresh. Expand all stops after 10,000 visible nodes to protect editor responsiveness. String values larger than 256 KiB initially show a short preview; click once to reveal the full value and again to copy it.

## Format behavior

- JSON is displayed from its root value. Root objects and arrays expose their direct children first.
- Each non-empty JSONL or NDJSON line is treated as an independent JSON value.
- Empty lines and a leading BOM are ignored.
- Invalid JSON fails the document view with an exact source location.
- An invalid JSONL line is shown as an error record without hiding valid records.
- Duplicate object keys are preserved in source order rather than overwritten.

## Development

Requirements: Node.js 20 or newer and VS Code 1.92 or newer.

```sh
npm install
npm test
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host. Production bundles are generated with:

```sh
npm run package
```

The extension host and Webview are bundled separately with esbuild. Parser and document-model tests use Node's built-in test runner.

## Performance note

The MVP parses the text document into an in-memory source-aware model, then transfers and renders top-level nodes in chunks. This prevents large DOM creation but is not yet a disk-streaming parser. Files around 100 MB should be tested against representative data before relying on a fixed latency or memory budget.

## License

[MIT](LICENSE)
