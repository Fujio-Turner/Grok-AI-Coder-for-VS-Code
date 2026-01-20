import * as vscode from 'vscode';

export interface DiffChange {
    uri: vscode.Uri;
    originalContent: string;
    modifiedContent: string;
    startLine: number;
    endLine: number;
    changeId: string;
}

export class InlineDiffWidget {
    private decorationType: vscode.TextEditorDecorationType;
    private changeIndex = 0;
    private changes: DiffChange[] = [];
    private webviewPanel: vscode.WebviewPanel | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
            border: '1px solid',
            borderColor: new vscode.ThemeColor('diffEditor.border'),
            isWholeLine: true
        });
    }

    /**
     * Show inline diff for a set of changes
     */
    public async showDiff(changes: DiffChange[]): Promise<void> {
        this.changes = changes;
        this.changeIndex = 0;

        if (changes.length === 0) {
            vscode.window.showInformationMessage('No changes to preview');
            return;
        }

        await this.showChangeAtIndex(0);
    }

    /**
     * Navigate to next change
     */
    public async nextChange(): Promise<void> {
        if (this.changeIndex < this.changes.length - 1) {
            this.changeIndex++;
            await this.showChangeAtIndex(this.changeIndex);
        }
    }

    /**
     * Navigate to previous change
     */
    public async previousChange(): Promise<void> {
        if (this.changeIndex > 0) {
            this.changeIndex--;
            await this.showChangeAtIndex(this.changeIndex);
        }
    }

    /**
     * Keep current change and move to next
     */
    public async keepChange(): Promise<void> {
        const change = this.changes[this.changeIndex];
        await this.applyChange(change);
        
        // Move to next or close if last
        if (this.changeIndex < this.changes.length - 1) {
            await this.nextChange();
        } else {
            this.dispose();
            vscode.window.showInformationMessage('All changes applied');
        }
    }

    /**
     * Undo current change and move to next
     */
    public async undoChange(): Promise<void> {
        // Just skip this change
        if (this.changeIndex < this.changes.length - 1) {
            await this.nextChange();
        } else {
            this.dispose();
            vscode.window.showInformationMessage('Review complete');
        }
    }

    /**
     * Show specific change by index
     */
    private async showChangeAtIndex(index: number): Promise<void> {
        const change = this.changes[index];
        
        // Open the document
        const document = await vscode.workspace.openTextDocument(change.uri);
        const editor = await vscode.window.showTextDocument(document);

        // Show diff in inline widget
        await this.createInlineWidget(editor, change);
    }

    /**
     * Create inline diff widget at change location
     */
    private async createInlineWidget(
        editor: vscode.TextEditor,
        change: DiffChange
    ): Promise<void> {
        // Clear previous decorations
        editor.setDecorations(this.decorationType, []);

        // Calculate diff lines
        const diffLines = this.calculateDiff(
            change.originalContent,
            change.modifiedContent
        );

        // Create webview panel for controls
        this.createControlPanel(change);

        // Highlight changed lines
        const range = new vscode.Range(
            change.startLine,
            0,
            change.endLine,
            Number.MAX_VALUE
        );
        editor.setDecorations(this.decorationType, [range]);

        // Scroll to change
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }

    /**
     * Create floating control panel
     */
    private createControlPanel(change: DiffChange): void {
        const panel = vscode.window.createWebviewPanel(
            'diffControls',
            'Change Preview',
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const totalChanges = this.changes.length;
        const currentChange = this.changeIndex + 1;

        panel.webview.html = this.getControlPanelHtml(
            change,
            currentChange,
            totalChanges
        );

        // Handle messages from webview
        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'keep':
                    await this.keepChange();
                    break;
                case 'undo':
                    await this.undoChange();
                    break;
                case 'next':
                    await this.nextChange();
                    break;
                case 'previous':
                    await this.previousChange();
                    break;
            }
        });

        this.webviewPanel = panel;
    }

    /**
     * Generate HTML for control panel
     */
    private getControlPanelHtml(
        change: DiffChange,
        current: number,
        total: number
    ): string {
        const diff = this.generateDiffHtml(
            change.originalContent,
            change.modifiedContent
        );

        return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            padding: 0;
            margin: 0;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
        }
        .controls {
            position: sticky;
            top: 0;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 1000;
        }
        .button-group {
            display: flex;
            gap: 8px;
        }
        button {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-border);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 13px;
            border-radius: 2px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.keep {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .counter {
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .diff-container {
            padding: 16px;
            overflow: auto;
        }
        .diff-line {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            padding: 2px 4px;
            white-space: pre;
        }
        .diff-line.removed {
            background: var(--vscode-diffEditor-removedTextBackground);
            color: var(--vscode-diffEditor-removedTextForeground);
        }
        .diff-line.added {
            background: var(--vscode-diffEditor-insertedTextBackground);
            color: var(--vscode-diffEditor-insertedTextForeground);
        }
        .diff-line.context {
            color: var(--vscode-editor-foreground);
        }
        .diff-line-number {
            display: inline-block;
            width: 40px;
            color: var(--vscode-editorLineNumber-foreground);
            text-align: right;
            margin-right: 8px;
            user-select: none;
        }
    </style>
</head>
<body>
    <div class="controls">
        <div class="button-group">
            <button onclick="previous()" ${current === 1 ? 'disabled' : ''}>
                ↑ Previous
            </button>
            <button onclick="next()" ${current === total ? 'disabled' : ''}>
                ↓ Next
            </button>
            <button onclick="openFile()">
                📄 Open File
            </button>
        </div>
        <div class="counter">${current} of ${total}</div>
        <div class="button-group">
            <button onclick="undo()">Undo</button>
            <button class="keep" onclick="keep()">Keep</button>
        </div>
    </div>
    <div class="diff-container">
        ${diff}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        
        function keep() {
            vscode.postMessage({ command: 'keep' });
        }
        
        function undo() {
            vscode.postMessage({ command: 'undo' });
        }
        
        function next() {
            vscode.postMessage({ command: 'next' });
        }
        
        function previous() {
            vscode.postMessage({ command: 'previous' });
        }
        
        function openFile() {
            vscode.postMessage({ command: 'openFile' });
        }
    </script>
</body>
</html>`;
    }

    /**
     * Generate diff HTML
     */
    private generateDiffHtml(original: string, modified: string): string {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');
        const diff = this.calculateDiff(original, modified);
        
        let html = '';
        let lineNum = 1;

        for (const change of diff) {
            if (change.type === 'context') {
                html += `<div class="diff-line context">
                    <span class="diff-line-number">${lineNum}</span>${this.escapeHtml(change.content)}
                </div>`;
                lineNum++;
            } else if (change.type === 'removed') {
                html += `<div class="diff-line removed">
                    <span class="diff-line-number">-</span>${this.escapeHtml(change.content)}
                </div>`;
            } else if (change.type === 'added') {
                html += `<div class="diff-line added">
                    <span class="diff-line-number">+</span>${this.escapeHtml(change.content)}
                </div>`;
                lineNum++;
            }
        }

        return html;
    }

    /**
     * Simple diff algorithm
     */
    private calculateDiff(original: string, modified: string): Array<{
        type: 'context' | 'removed' | 'added';
        content: string;
    }> {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');
        const result: Array<{ type: 'context' | 'removed' | 'added'; content: string }> = [];

        // Simple line-by-line comparison
        const maxLen = Math.max(originalLines.length, modifiedLines.length);
        
        for (let i = 0; i < maxLen; i++) {
            const origLine = originalLines[i];
            const modLine = modifiedLines[i];

            if (origLine === modLine) {
                result.push({ type: 'context', content: origLine || '' });
            } else {
                if (origLine !== undefined) {
                    result.push({ type: 'removed', content: origLine });
                }
                if (modLine !== undefined) {
                    result.push({ type: 'added', content: modLine });
                }
            }
        }

        return result;
    }

    /**
     * Apply change to file
     */
    private async applyChange(change: DiffChange): Promise<void> {
        const document = await vscode.workspace.openTextDocument(change.uri);
        const edit = new vscode.WorkspaceEdit();
        
        const range = new vscode.Range(
            change.startLine,
            0,
            change.endLine,
            document.lineAt(change.endLine).text.length
        );

        edit.replace(change.uri, range, change.modifiedContent);
        await vscode.workspace.applyEdit(edit);
    }

    /**
     * Escape HTML special characters
     */
    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Clean up resources
     */
    public dispose(): void {
        if (this.webviewPanel) {
            this.webviewPanel.dispose();
            this.webviewPanel = undefined;
        }
        this.decorationType.dispose();
    }
}