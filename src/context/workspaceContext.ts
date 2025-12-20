import * as vscode from 'vscode';

export async function readAgentContext(): Promise<string | null> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }

        // Try AGENT.md first, then AGENTS.md
        const filesToTry = ['AGENT.md', 'AGENTS.md'];
        
        for (const fileName of filesToTry) {
            try {
                const agentUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);
                const data = await vscode.workspace.fs.readFile(agentUri);
                return Buffer.from(data).toString('utf8');
            } catch {
                // File doesn't exist, try next
            }
        }

        return null;
    } catch (error) {
        console.error('Failed to read agent context:', error);
        return null;
    }
}

export async function findFiles(glob: string): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(glob, '**/node_modules/**', 100);
}

export async function readFile(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
}

export async function getActiveEditorContent(): Promise<{ content: string; fileName: string; selection?: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const document = editor.document;
    const selection = editor.selection;
    
    return {
        content: document.getText(),
        fileName: document.fileName,
        selection: selection.isEmpty ? undefined : document.getText(selection)
    };
}

export async function gatherContextFromSelection(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        return null;
    }

    const selectedText = editor.document.getText(selection);
    const fileName = editor.document.fileName;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    return `File: ${fileName} (lines ${startLine}-${endLine})\n\`\`\`\n${selectedText}\n\`\`\``;
}
