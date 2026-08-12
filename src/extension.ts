import * as vscode from 'vscode';
import { JsonlViewerProvider } from './customEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    JsonlViewerProvider.viewType,
    new JsonlViewerProvider(context),
    { supportsMultipleEditorsPerDocument: true }
  ));
}

export function deactivate(): void {}
