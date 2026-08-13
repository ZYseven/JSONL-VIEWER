# Changelog

## 0.1.3

- Separated the line-number and folding gutters to prevent overlap.
- Renumbered lines from the currently visible tree after every expand, collapse, and incremental load.

## 0.1.2

- Matched VS Code's three-color bracket cycle so deeper brackets remain visible.
- Enlarged the expand/collapse target to a square based on the editor line height.

## 0.1.0

- Added a read-only custom editor for JSON, JSONL, and NDJSON.
- Added a strict source-aware parser that preserves duplicate keys and line ranges.
- Added incremental rendering, tree navigation, search, clipboard actions, and theme-aware styling.
- Added parser, model, manifest, and Webview protocol test foundations.
- Added English and Simplified Chinese extension UI localization.
- Added Playwright Webview coverage and VS Code Extension Host integration testing.
- Preserved visible JSON root containers and paged large nested objects and arrays.
