import * as vscode from 'vscode';

export interface ProposedEdit {
    id: string;
    fileUri: vscode.Uri;
    range?: vscode.Range;
    newText: string;
    oldText?: string;
}

export interface FileSnapshot {
    uri: vscode.Uri;
    content: string;
}

// Store snapshots for revert functionality
const editSnapshots: Map<string, FileSnapshot[]> = new Map();

export async function applyEdits(edits: ProposedEdit[], editGroupId: string): Promise<void> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const snapshots: FileSnapshot[] = [];

    for (const edit of edits) {
        // Snapshot before edit
        try {
            const doc = await vscode.workspace.openTextDocument(edit.fileUri);
            snapshots.push({
                uri: edit.fileUri,
                content: doc.getText()
            });
        } catch {
            // File doesn't exist yet, no snapshot needed
        }

        if (edit.range) {
            workspaceEdit.replace(edit.fileUri, edit.range, edit.newText);
        } else {
            // Full file replacement
            workspaceEdit.createFile(edit.fileUri, { overwrite: true, ignoreIfExists: false });
            workspaceEdit.insert(edit.fileUri, new vscode.Position(0, 0), edit.newText);
        }
    }

    // Store snapshots for potential revert
    editSnapshots.set(editGroupId, snapshots);

    // Apply the edits
    const success = await vscode.workspace.applyEdit(workspaceEdit);
    
    if (!success) {
        throw new Error('Failed to apply edits');
    }
}

export async function revertEdits(editGroupId: string): Promise<void> {
    const snapshots = editSnapshots.get(editGroupId);
    if (!snapshots || snapshots.length === 0) {
        throw new Error('No snapshots found for this edit group');
    }

    const workspaceEdit = new vscode.WorkspaceEdit();

    for (const snapshot of snapshots) {
        try {
            const doc = await vscode.workspace.openTextDocument(snapshot.uri);
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            workspaceEdit.replace(snapshot.uri, fullRange, snapshot.content);
        } catch (error) {
            console.error('Failed to revert file:', snapshot.uri, error);
        }
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    
    if (success) {
        editSnapshots.delete(editGroupId);
    } else {
        throw new Error('Failed to revert edits');
    }
}

export function parseCodeBlocksFromResponse(responseText: string): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    
    // Get workspace folder first
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('parseCodeBlocksFromResponse: No workspace folder');
        return edits;
    }
    
    // Pattern to match: 📄 filename.ts (lines X-Y) followed by code block
    // Also matches 🗎, file emoji variations, or just the filename pattern
    const filePattern = /[📄🗎]\s*([^\s\n(]+)\s*(?:\(lines?\s*(\d+)(?:-(\d+))?\))?[\s\n]*```(\w+)?\n([\s\S]*?)```/g;
    
    let match;
    let editIndex = 0;
    
    while ((match = filePattern.exec(responseText)) !== null) {
        const [, filePath, startLine, endLine, language, code] = match;
        
        console.log('parseCodeBlocksFromResponse: Found file:', filePath);

        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
        
        let range: vscode.Range | undefined;
        if (startLine) {
            const start = parseInt(startLine, 10) - 1;
            const end = endLine ? parseInt(endLine, 10) : start + 1;
            range = new vscode.Range(start, 0, end, 0);
        }

        edits.push({
            id: `edit-${editIndex++}`,
            fileUri,
            range,
            newText: code.trim()
        });
    }

    console.log('parseCodeBlocksFromResponse: Found', edits.length, 'edits');
    return edits;
}

export function clearSnapshots(): void {
    editSnapshots.clear();
}
