# VS Code editor fidelity and custom-editor registration

## Scope and evidence standard

This note records the public VS Code contracts that matter to `json viewer`: Webview theme fidelity and the `customEditors` contribution. It distinguishes public contracts from implementation details found in VS Code source; the extension must depend on the former.

The current manifest has one custom-editor entry (`jsonlViewer.viewer`) with one selector array for `*.json`, `*.jsonl`, and `*.ndjson`. That is the correct manifest shape: several filename patterns are alternatives for **one** editor, not separate editors.

## 1. Webview typography

The [official Webview guide](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content) explicitly guarantees these CSS variables in a Webview:

```css
font-family: var(--vscode-editor-font-family);
font-size: var(--vscode-editor-font-size);
font-weight: var(--vscode-editor-font-weight);
```

They map to `editor.fontFamily`, `editor.fontSize`, and `editor.fontWeight`, respectively. Use them for source-like JSON content. The general workbench variables `--vscode-font-family` and `--vscode-font-size` suit UI chrome such as toolbars and find widgets; they are not substitutes for the editor settings.

There is **no documented `--vscode-editor-line-height` Webview variable**. The official list contains only the three variables above. Therefore a Webview must own its line height, for example `line-height: 1.5` or a documented extension setting. It must not rely on an undocumented variable or attempt to infer `editor.lineHeight` through private workbench APIs. This is a deliberate fidelity boundary: the editor can apply language/token-specific font metrics that a Webview cannot receive through the public API.

Actionable CSS structure:

```css
/* JSON tree content */
.tree {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  font-weight: var(--vscode-editor-font-weight);
  line-height: 1.5;
}

/* Interactive workbench-like controls */
.toolbar, .find-widget {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
```

If the product intentionally exposes `jsonViewer.fontSize`, it is a product override. Document it as an override rather than claiming it follows the user's `editor.fontSize`; initializing it from `--vscode-editor-font-size` is the behavior that most closely matches the native editor when no override is active.

The Webview guide also requires testing the supplied body classes `vscode-light`, `vscode-dark`, and `vscode-high-contrast`, with high-contrast usability called out explicitly. Do not target a specific `data-vscode-theme-id` except for a narrowly justified compatibility exception.

## 2. JSON colors: public boundary and supported substitutes

VS Code's [Color Theme documentation](https://code.visualstudio.com/api/extension-guides/color-theme#syntax-colors) distinguishes workbench colors from syntax colors: editor syntax highlighting comes from TextMate grammars/themes and semantic token rules. The public Webview contract exposes **theme color IDs** as CSS variables (`editor.foreground` becomes `--vscode-editor-foreground`), as documented in the [Webview guide](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content) and [Theme Color Reference](https://code.visualstudio.com/api/references/theme-color).

It does **not** expose an API or CSS variable for "the active JSON string/key/number token color". A Webview cannot invoke the editor's TextMate tokenizer, inspect the active `tokenColors`, or resolve semantic token styles using public VS Code extension APIs. The implementation is visible in VS Code's internal [`ColorThemeData`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/colorThemeData.ts): it builds TextMate and semantic-token rules internally. That source explains why exact matching is non-portable; it is not an extension API contract.

Use public, semantic workbench colors instead:

| Viewer role | Supported Webview token | Notes |
| --- | --- | --- |
| Default punctuation/text | `var(--vscode-editor-foreground)` | Public editor foreground. |
| Tree property/key | `var(--vscode-symbolIcon-propertyForeground, var(--vscode-editor-foreground))` | A stable property-role color, but not a JSON TextMate token. |
| String-like value | `var(--vscode-debugTokenExpression-string, var(--vscode-editor-foreground))` | Public theme-color role; use only as an approximate semantic distinction. |
| Number-like value | `var(--vscode-debugTokenExpression-number, var(--vscode-editor-foreground))` | Same caveat. |
| Boolean-like value | `var(--vscode-debugTokenExpression-boolean, var(--vscode-editor-foreground))` | Same caveat. |
| `null` | `var(--vscode-descriptionForeground, var(--vscode-editor-foreground))` | Readable secondary text. |
| Matched search | `var(--vscode-editor-findMatchHighlightBackground)` and `var(--vscode-editor-findMatchBorder)` | Matches the native find-widget roles. |
| Hover/focus | `var(--vscode-toolbar-hoverBackground)`, `var(--vscode-focusBorder)` | Native workbench interaction roles. |

For colored structural brackets, the official [Theme Color Reference](https://code.visualstudio.com/api/references/theme-color#editor-colors) exposes six explicit bracket-pair colors. The sanctioned mapping is:

```css
.depth-0 { color: var(--vscode-editorBracketHighlight-foreground1); }
.depth-1 { color: var(--vscode-editorBracketHighlight-foreground2); }
.depth-2 { color: var(--vscode-editorBracketHighlight-foreground3); }
.depth-3 { color: var(--vscode-editorBracketHighlight-foreground4); }
.depth-4 { color: var(--vscode-editorBracketHighlight-foreground5); }
.depth-5 { color: var(--vscode-editorBracketHighlight-foreground6); }
```

The reference describes these tokens as requiring bracket-pair colorization. They are suitable for the viewer's matching-bracket visual language; include an `editor.foreground` fallback because a theme may omit a custom value. Do not hard-code a dark-theme palette as the primary behavior.

## 3. Custom-editor contribution rules

The [official Custom Editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors#contribution-point) defines the registration contract:

- `viewType` is the identifier connecting `package.json` to `window.registerCustomEditorProvider`; it **must be unique across all extensions**.
- `displayName` is exactly the string shown in **View: Reopen With** / **Open With**.
- `selector` is one or more filename glob patterns. One matching selector is sufficient. Multiple extensions are allowed in this one selector array; they do not create one entry per suffix.
- `priority: "option"` keeps the editor available through Open With or user configuration but does not select it automatically. `"default"` asks VS Code to use it for matching resources; when several editors match, VS Code needs the user to choose.
- On activation, the extension must register a provider with the same `viewType`. Since VS Code 1.74, the contributed custom editor supplies the activation event automatically; adding a matching manual `onCustomEditor:` event is unnecessary but does not create an additional contribution.

The public custom-editor documentation also says a custom editor may have multiple Webview instances for one resource (for example after splitting). Those are separate **editor panes**, not separate Open With menu entries.

### Source behavior relevant to duplicates

VS Code's internal [`CustomEditorInfoCollection`](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/customEditor/common/customEditor.ts) calls `distinct(editors, editor => editor.id)`. A selector array containing `*.json`, `*.jsonl`, and `*.ndjson` therefore cannot itself make three identical menu entries for the same `viewType`; only the matching pattern matters. This is supporting source evidence, not an API guarantee.

## 4. Why three identical `json viewer` entries can appear

Given the current one-entry manifest, three identical **Open With** items are evidence of three registered custom-editor contributions, not evidence that the three filename patterns were expanded. Check these causes in order:

1. **Several installed extension identities.** VS Code identity is `publisher.name`, not `displayName`. A prior build with another `publisher` or `name` can coexist with `ZYseven.jsonl-viewer`, and all can expose the same display name. Inspect Extensions view for `@installed json viewer` and compare the identifier shown in each extension's details.
2. **Installed copy plus Extension Development Host.** The development host loads the workspace extension while the normal VS Code window can retain an installed VSIX/Marketplace copy. This normally affects different windows, but testing Open With in a window where more than one identity has been loaded can show all registered contributions. Disable/uninstall the packaged copy before debugging, or test the VSIX in a normal window after closing the development host.
3. **A historical duplicate contribution remains in a manifest.** Search the active extension's `package.json` for all `contributes.customEditors` entries and all provider registrations. There must be one contribution object and one `registerCustomEditorProvider` call for `jsonlViewer.viewer`.
4. **Different `viewType` values with the same `displayName`.** VS Code correctly lists each because it treats them as distinct editors. Keep `displayName: "json viewer"` only on the intended contribution and permanently use a namespaced view type such as `zyseven.jsonlViewer`.
5. **Remote extension host copy.** In WSL/SSH/Dev Container, an extension can be installed locally and remotely. Whether it contributes in the active window depends on extension-host placement, so inspect the Extensions view in the remote window and the "Running Extensions" command before attributing it to the manifest.

There is no supported reason to deliberately register duplicate providers. Registering the same `viewType` more than once in a single extension process is an error-prone lifecycle bug; retain the returned disposable in `context.subscriptions` and activate once.

## 5. Executable audit for this repository

Keep this invariant:

```json
"customEditors": [{
  "viewType": "jsonlViewer.viewer",
  "displayName": "json viewer",
  "selector": [
    { "filenamePattern": "*.json" },
    { "filenamePattern": "*.jsonl" },
    { "filenamePattern": "*.ndjson" }
  ],
  "priority": "option"
}]
```

and one matching registration:

```ts
vscode.window.registerCustomEditorProvider('jsonlViewer.viewer', provider, options);
```

Before packaging/retesting, run:

```powershell
code --list-extensions --show-versions | Select-String 'jsonl|viewer|ZYseven'
```

Then uninstall old identities through the Extensions UI (or `code --uninstall-extension <publisher.name>`), reload the window, and test with one installed identity. Do **not** delete extension directories by glob; removing a specific extension through VS Code preserves its installation metadata correctly.

## Decisions for the next implementation pass

1. Use `--vscode-editor-font-family`, `--vscode-editor-font-size`, and `--vscode-editor-font-weight` for the JSON tree; preserve an explicit viewer-size preference only when the product requires it.
2. Keep a fixed, tested tree line-height rather than pretend to mirror undocumented `editor.lineHeight` behavior.
3. Replace palette guesses with public theme colors. Use the six `editorBracketHighlight` variables for depth; use editor/workbench role colors for other JSON value classes.
4. Preserve exactly one `customEditors` manifest entry and one provider registration. Treat multiple same-name Open With options as an installation/identity audit, not a selector-array bug.
