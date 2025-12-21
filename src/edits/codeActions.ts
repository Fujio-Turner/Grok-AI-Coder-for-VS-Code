import * as vscode from 'vscode';
import { changeTracker, FileChange, ChangeSet, DiffStats } from './changeTracker';

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

export interface ApplyResult {
    success: boolean;
    changeSet?: ChangeSet;
    error?: string;
}

const editSnapshots: Map<string, FileSnapshot[]> = new Map();
const changeSetToEditGroup: Map<string, string> = new Map();

export async function applyEdits(
    edits: ProposedEdit[], 
    editGroupId: string,
    sessionId?: string,
    cost: number = 0,
    tokensUsed: number = 0
): Promise<ApplyResult> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const snapshots: FileSnapshot[] = [];
    const fileChanges: FileChange[] = [];

    changeTracker.startTracking();

    for (const edit of edits) {
        let oldContent = '';
        let isNewFile = true;

        try {
            const doc = await vscode.workspace.openTextDocument(edit.fileUri);
            oldContent = doc.getText();
            isNewFile = false;
            snapshots.push({
                uri: edit.fileUri,
                content: oldContent
            });
        } catch {
            // File doesn't exist yet
        }

        const fileChange = changeTracker.createFileChange(
            edit.fileUri.fsPath,
            oldContent,
            edit.newText,
            isNewFile
        );
        fileChanges.push(fileChange);

        if (edit.range) {
            workspaceEdit.replace(edit.fileUri, edit.range, edit.newText);
        } else {
            workspaceEdit.createFile(edit.fileUri, { overwrite: true, ignoreIfExists: false });
            workspaceEdit.insert(edit.fileUri, new vscode.Position(0, 0), edit.newText);
        }
    }

    editSnapshots.set(editGroupId, snapshots);

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    
    if (!success) {
        return { success: false, error: 'Failed to apply edits' };
    }

    // Save all modified files to disk
    for (const edit of edits) {
        try {
            const doc = await vscode.workspace.openTextDocument(edit.fileUri);
            await doc.save();
        } catch (saveError) {
            console.error('Failed to save file:', edit.fileUri.fsPath, saveError);
        }
    }

    const changeSet = changeTracker.addChangeSet(
        sessionId || 'unknown',
        fileChanges,
        cost,
        tokensUsed,
        `Applied ${edits.length} file(s)`
    );
    
    changeTracker.markApplied(changeSet.id);
    changeSetToEditGroup.set(changeSet.id, editGroupId);

    return { success: true, changeSet };
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
        
        for (const [csId, egId] of changeSetToEditGroup.entries()) {
            if (egId === editGroupId) {
                changeTracker.markReverted(csId);
                changeSetToEditGroup.delete(csId);
                break;
            }
        }
    } else {
        throw new Error('Failed to revert edits');
    }
}

export async function revertToChangeSet(targetChangeSetId: string): Promise<boolean> {
    const history = changeTracker.getHistory();
    const targetIndex = history.findIndex(cs => cs.id === targetChangeSetId);
    
    if (targetIndex === -1) {
        return false;
    }

    for (let i = history.length - 1; i > targetIndex; i--) {
        const cs = history[i];
        if (cs.applied) {
            const editGroupId = changeSetToEditGroup.get(cs.id);
            if (editGroupId) {
                try {
                    await revertEdits(editGroupId);
                } catch (error) {
                    console.error('Failed to revert change set:', cs.id, error);
                }
            }
        }
    }

    changeTracker.setPosition(targetIndex);
    return true;
}

export async function reapplyFromChangeSet(targetChangeSetId: string): Promise<boolean> {
    const history = changeTracker.getHistory();
    const currentPosition = changeTracker.getCurrentPosition();
    const targetIndex = history.findIndex(cs => cs.id === targetChangeSetId);
    
    if (targetIndex === -1 || targetIndex <= currentPosition) {
        return false;
    }

    for (let i = currentPosition + 1; i <= targetIndex; i++) {
        const cs = history[i];
        if (!cs.applied) {
            for (const fileChange of cs.files) {
                try {
                    const uri = vscode.Uri.file(fileChange.filePath);
                    const edit = new vscode.WorkspaceEdit();
                    
                    if (fileChange.isNewFile) {
                        edit.createFile(uri, { overwrite: true });
                        edit.insert(uri, new vscode.Position(0, 0), fileChange.newContent);
                    } else {
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const fullRange = new vscode.Range(
                            doc.positionAt(0),
                            doc.positionAt(doc.getText().length)
                        );
                        edit.replace(uri, fullRange, fileChange.newContent);
                    }
                    
                    await vscode.workspace.applyEdit(edit);
                    // Save the file to disk
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await doc.save();
                } catch (error) {
                    console.error('Failed to reapply change:', fileChange.filePath, error);
                }
            }
            changeTracker.markApplied(cs.id);
        }
    }

    changeTracker.setPosition(targetIndex);
    return true;
}

export function parseCodeBlocksFromResponse(responseText: string): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('parseCodeBlocksFromResponse: No workspace folder');
        return edits;
    }
    
    const filePattern = /[\u{1F4C4}\u{1F5CE}]\s*([^\s\n(]+)\s*(?:\(lines?\s*(\d+)(?:-(\d+))?\))?[\s\n]*```(\w+)?\n([\s\S]*?)```/gu;
    
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

export async function previewDiffStats(edits: ProposedEdit[]): Promise<{ file: string; stats: DiffStats }[]> {
    const results: { file: string; stats: DiffStats }[] = [];
    
    for (const edit of edits) {
        let oldContent = '';
        try {
            const doc = await vscode.workspace.openTextDocument(edit.fileUri);
            oldContent = doc.getText();
        } catch {
            // New file
        }
        
        const stats = changeTracker.calculateDiffStats(oldContent, edit.newText);
        results.push({
            file: edit.fileUri.fsPath.split('/').pop() || edit.fileUri.fsPath,
            stats
        });
    }
    
    return results;
}

export function clearSnapshots(): void {
    editSnapshots.clear();
}

export function getChangeTracker() {
    return changeTracker;
}
