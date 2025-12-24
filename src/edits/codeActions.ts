import * as vscode from 'vscode';
import * as path from 'path';
import { changeTracker, FileChange, ChangeSet, DiffStats } from './changeTracker';

/**
 * Resolves a file path (absolute, relative, or file:// URI) to a vscode.Uri.
 * Handles:
 * - file:// URIs: parsed directly
 * - Absolute paths: converted via vscode.Uri.file
 * - Relative paths: joined with workspace root
 * 
 * @param rawPath The path from AI response (could be absolute, relative, or URI)
 * @returns vscode.Uri or undefined if resolution fails
 */
export function resolveFilePathToUri(rawPath: string): vscode.Uri | undefined {
    if (!rawPath || !rawPath.trim()) {
        return undefined;
    }

    const p = rawPath.trim();

    // 1) If it's already a URI (e.g., file:///...), parse it directly
    if (p.startsWith('file:')) {
        try {
            return vscode.Uri.parse(p);
        } catch {
            // fall through to try other strategies
        }
    }

    // 2) Absolute filesystem path? Use vscode.Uri.file
    if (path.isAbsolute(p)) {
        return vscode.Uri.file(p);
    }

    // 3) Relative path: resolve against the first workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        return vscode.Uri.joinPath(workspaceFolders[0].uri, p);
    }

    // 4) No workspace, non-absolute: can't resolve safely
    return undefined;
}

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

/**
 * Safety validation result for file changes
 */
export interface FileChangeValidation {
    isValid: boolean;
    warning?: string;
    isSuspicious: boolean;
    details: {
        existingFileSize: number;
        newContentSize: number;
        sizeDifferencePercent: number;
        looksLikeTruncation: boolean;
    };
}

/**
 * Validates a file change before applying to prevent accidental file corruption.
 * Detects when AI provides truncated content that would wipe out an existing file.
 * 
 * @param fileUri The file being modified
 * @param newContent The new content to apply
 * @param isDiff Whether this is a diff (partial change) or full replacement
 * @returns Validation result with warnings if suspicious
 */
export async function validateFileChange(
    fileUri: vscode.Uri, 
    newContent: string, 
    isDiff: boolean = false
): Promise<FileChangeValidation> {
    let existingContent = '';
    let existingFileSize = 0;
    
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        existingContent = doc.getText();
        existingFileSize = existingContent.length;
    } catch {
        // File doesn't exist - no validation needed for new files
        return {
            isValid: true,
            isSuspicious: false,
            details: {
                existingFileSize: 0,
                newContentSize: newContent.length,
                sizeDifferencePercent: 0,
                looksLikeTruncation: false
            }
        };
    }

    const newContentSize = newContent.length;
    const sizeDifference = existingFileSize - newContentSize;
    const sizeDifferencePercent = existingFileSize > 0 
        ? (sizeDifference / existingFileSize) * 100 
        : 0;
    
    // Detect suspicious patterns that indicate truncation/corruption
    // Be careful not to flag valid code files - only flag clear truncation signs
    const trimmedContent = newContent.trimEnd();
    const endsAbruptly = 
        trimmedContent.endsWith('...') ||  // Explicit truncation marker
        !!trimmedContent.match(/["'`]:\s*["'`]?$/) || // Ends mid-JSON value
        !!trimmedContent.match(/\{\s*$/) ||  // Ends with unclosed brace (no content after)
        !!trimmedContent.match(/\[\s*$/) ||  // Ends with unclosed bracket (no content after)
        !!trimmedContent.match(/,\s*$/);     // Ends with trailing comma (incomplete)
    
    const looksLikeTruncation: boolean = !isDiff && (
        // Only flag as truncation if BOTH size is drastically reduced AND ends abruptly
        (sizeDifferencePercent > 70 && existingFileSize > 500 && endsAbruptly) ||
        // Very short replacement for large file with suspicious ending
        (newContentSize < 200 && existingFileSize > 1000 && endsAbruptly)
    );
    
    // Check if the new content is just the start of the existing file (truncation)
    const isStartOfExisting: boolean = existingFileSize > 500 && 
        newContentSize < existingFileSize * 0.3 &&
        existingContent.startsWith(newContent.trim());
    
    const isSuspicious: boolean = looksLikeTruncation || isStartOfExisting;
    
    let warning: string | undefined;
    if (isSuspicious) {
        if (isStartOfExisting) {
            warning = `BLOCKED: New content appears to be truncated (only first ${newContentSize} of ${existingFileSize} chars). ` +
                      `This would corrupt the file. Use isDiff:true for partial edits.`;
        } else if (sizeDifferencePercent > 70) {
            warning = `WARNING: Replacing ${existingFileSize} chars with ${newContentSize} chars (${sizeDifferencePercent.toFixed(0)}% reduction). ` +
                      `This may indicate truncation. Verify this is intentional.`;
        } else {
            warning = `WARNING: Content appears truncated or incomplete. Review before applying.`;
        }
    }
    
    return {
        isValid: !isStartOfExisting, // Block obvious truncations, warn on others
        warning,
        isSuspicious,
        details: {
            existingFileSize,
            newContentSize,
            sizeDifferencePercent,
            looksLikeTruncation
        }
    };
}

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

        // SAFETY CHECK: Detect if newText looks like unprocessed diff content
        const lines = edit.newText.split('\n');
        const diffMarkerCount = lines.filter(l => l.startsWith('+') || l.startsWith('-')).length;
        const totalLines = lines.filter(l => l.trim()).length;
        const looksLikeDiff = totalLines > 3 && diffMarkerCount > totalLines * 0.5;
        
        if (looksLikeDiff && !isNewFile) {
            console.warn(`[Grok] BLOCKED: Content looks like unprocessed diff (${diffMarkerCount}/${totalLines} lines have +/- prefix). Stripping markers.`);
            // Strip diff markers to prevent corruption
            edit.newText = lines
                .filter(line => !line.startsWith('-'))
                .map(line => line.startsWith('+') ? line.substring(1) : line)
                .join('\n');
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

    // Log what we're about to apply for debugging
    console.log(`[Grok] Applying ${edits.length} edits:`, edits.map(e => ({
        path: e.fileUri.fsPath,
        hasRange: !!e.range,
        textLength: e.newText.length,
        textPreview: e.newText.substring(0, 100)
    })));

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    
    if (!success) {
        // Try to provide more detailed error info
        const failedFiles = edits.map(e => e.fileUri.fsPath).join(', ');
        console.error('[Grok] Failed to apply edits to:', failedFiles);
        return { success: false, error: `Failed to apply edits to: ${failedFiles}. The file may be read-only, locked, or have conflicting changes.` };
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
    
    const filePattern = /[\u{1F4C4}\u{1F5CE}]\s*([^\s\n(]+)\s*(?:\(lines?\s*(\d+)(?:-(\d+))?\))?[\s\n]*```(\w+)?\n([\s\S]*?)```/gu;
    
    let match;
    let editIndex = 0;
    
    while ((match = filePattern.exec(responseText)) !== null) {
        const [, filePath, startLine, endLine, language, code] = match;
        
        console.log('parseCodeBlocksFromResponse: Found file:', filePath);

        const fileUri = resolveFilePathToUri(filePath);
        if (!fileUri) {
            console.log('parseCodeBlocksFromResponse: Unable to resolve file path:', filePath);
            vscode.window.showErrorMessage(`Cannot apply change: Unable to resolve path "${filePath}". It may be outside the workspace or invalid.`);
            continue;
        }
        
        // Log if file is outside workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const isOutsideWorkspace = workspaceFolders 
            ? !fileUri.fsPath.startsWith(workspaceFolders[0].uri.fsPath) 
            : true;
        if (isOutsideWorkspace) {
            console.log('parseCodeBlocksFromResponse: File is outside workspace:', filePath);
        }
        
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

/**
 * Apply a unified diff to existing content.
 * Diff format: lines starting with '+' are added, '-' are removed, ' ' or no prefix are context.
 * Returns the modified content.
 */
export function applyUnifiedDiff(originalContent: string, diffContent: string): string {
    const originalLines = originalContent.split('\n');
    const diffLines = diffContent.split('\n');
    const resultLines: string[] = [];
    
    let originalIndex = 0;
    let inHunk = false;
    let hunkStartLine = 0;
    
    for (const line of diffLines) {
        // Skip hunk headers like @@ -10,5 +10,7 @@
        if (line.startsWith('@@')) {
            // Extract the starting line number from the hunk header
            const match = line.match(/@@ -(\d+)/);
            if (match) {
                hunkStartLine = parseInt(match[1], 10) - 1; // 0-indexed
                // Copy all lines up to the hunk start
                while (originalIndex < hunkStartLine && originalIndex < originalLines.length) {
                    resultLines.push(originalLines[originalIndex]);
                    originalIndex++;
                }
            }
            inHunk = true;
            continue;
        }
        
        if (!inHunk) {
            // Before first hunk, skip any non-diff lines
            continue;
        }
        
        if (line.startsWith('-')) {
            // Line removed - skip it in original (consume but don't add)
            originalIndex++;
        } else if (line.startsWith('+')) {
            // Line added - add to result (without the + prefix)
            resultLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            // Context line - copy from original
            resultLines.push(originalLines[originalIndex] || line.substring(1));
            originalIndex++;
        } else {
            // No prefix - treat as context
            resultLines.push(originalLines[originalIndex] || line);
            originalIndex++;
        }
    }
    
    // Copy remaining original lines after the last hunk
    while (originalIndex < originalLines.length) {
        resultLines.push(originalLines[originalIndex]);
        originalIndex++;
    }
    
    return resultLines.join('\n');
}

/**
 * Simple diff application: remove lines starting with -, add lines starting with +
 * Used when no hunk headers are present.
 */
export function applySimpleDiff(originalContent: string, diffContent: string): string {
    const diffLines = diffContent.split('\n');
    const resultLines: string[] = [];
    
    // Check if diff content is empty or malformed
    if (!diffContent || diffContent.trim() === '') {
        console.warn('[Grok] Empty diff content, returning original');
        return originalContent;
    }
    
    // Check if this is a simple +/- diff without context
    const hasOnlyAddRemove = diffLines.every(line => 
        line.startsWith('+') || line.startsWith('-') || line.trim() === ''
    );
    
    if (hasOnlyAddRemove) {
        // Simple diff: just take the + lines as the new content
        for (const line of diffLines) {
            if (line.startsWith('+')) {
                resultLines.push(line.substring(1));
            }
            // Skip - lines (removed content)
        }
        
        // Validate result isn't empty when there was content
        if (resultLines.length === 0 && diffLines.some(l => l.startsWith('+'))) {
            console.warn('[Grok] Diff produced empty result, checking for issues');
        }
        
        return resultLines.join('\n');
    }
    
    // Has context lines - need smarter application
    return applyUnifiedDiff(originalContent, diffContent);
}
