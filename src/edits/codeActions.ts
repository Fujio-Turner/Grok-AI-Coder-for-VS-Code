import * as vscode from 'vscode';
import * as path from 'path';
import { changeTracker, FileChange, ChangeSet, DiffStats } from './changeTracker';
import { createFileBackup, getOriginalBackup, restoreFromBackup, FileBackupReference } from '../storage/chatSessionRepository';

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

/**
 * Async version of resolveFilePathToUri with file search fallback.
 * If the direct path doesn't exist, searches the workspace for the filename.
 */
export async function resolveFilePathToUriWithSearch(rawPath: string): Promise<vscode.Uri | undefined> {
    // First try direct resolution
    const directUri = resolveFilePathToUri(rawPath);
    
    if (directUri) {
        // Check if file exists at direct path
        try {
            await vscode.workspace.fs.stat(directUri);
            return directUri; // File exists
        } catch {
            // File doesn't exist at direct path - try searching
        }
    }
    
    // Extract just the filename for searching
    const filename = path.basename(rawPath);
    if (!filename) {
        return directUri; // Return the direct URI even if file doesn't exist (for new files)
    }
    
    // Search workspace for the file
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return directUri;
    }
    
    try {
        const pattern = new vscode.RelativePattern(workspaceFolders[0], `**/${filename}`);
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 5);
        
        if (files.length === 1) {
            console.log(`[Grok] File path "${rawPath}" not found directly, using search result: ${files[0].fsPath}`);
            return files[0];
        } else if (files.length > 1) {
            // Multiple matches - prefer one with matching directory structure
            const normalizedPath = rawPath.replace(/\\/g, '/');
            for (const file of files) {
                if (file.fsPath.replace(/\\/g, '/').endsWith(normalizedPath)) {
                    console.log(`[Grok] File path "${rawPath}" matched: ${file.fsPath}`);
                    return file;
                }
            }
            // Still ambiguous - log warning and use first match
            console.warn(`[Grok] Multiple files match "${rawPath}", using first: ${files[0].fsPath}`);
            return files[0];
        }
    } catch (err) {
        console.warn(`[Grok] File search failed for "${rawPath}":`, err);
    }
    
    // Return direct URI for new file creation
    return directUri;
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
    /** Files where diff application failed (oldContent === newContent) */
    failedDiffs?: string[];
    /** True if NO actual changes were made - rollback impossible */
    noActualChanges?: boolean;
    /** Backup references created for original files (before first modification) */
    backups?: Map<string, FileBackupReference>;
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
    tokensUsed: number = 0,
    pairIndex: number = 0
): Promise<ApplyResult> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    const snapshots: FileSnapshot[] = [];
    const fileChanges: FileChange[] = [];
    const backupRefs: Map<string, FileBackupReference> = new Map();

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
            
            // Create backup of original file before first modification
            // Only backs up if no backup exists for this file yet
            if (sessionId && oldContent) {
                try {
                    const existingBackup = await getOriginalBackup(edit.fileUri.fsPath);
                    if (!existingBackup) {
                        const backupRef = await createFileBackup(
                            edit.fileUri.fsPath,
                            oldContent,
                            sessionId,
                            pairIndex
                        );
                        if (backupRef) {
                            backupRefs.set(edit.fileUri.fsPath, backupRef);
                            console.log(`[Grok] Created original backup for ${edit.fileUri.fsPath}`);
                        }
                    } else {
                        console.log(`[Grok] Original backup already exists for ${edit.fileUri.fsPath}`);
                    }
                } catch (backupErr) {
                    console.error(`[Grok] Failed to create backup for ${edit.fileUri.fsPath}:`, backupErr);
                }
            }
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

    // SAFETY CHECK: Detect if any changes produced identical old/new content
    // This indicates a diff application failure - rollback won't work!
    const identicalChanges = fileChanges.filter(fc => fc.oldContent === fc.newContent && !fc.isNewFile);
    if (identicalChanges.length > 0) {
        console.warn(`[Grok] WARNING: ${identicalChanges.length} file(s) have identical old/new content - diff may have failed to apply!`);
        for (const fc of identicalChanges) {
            console.warn(`  - ${fc.filePath}: oldContent === newContent (${fc.oldContent.length} chars)`);
        }
    }
    
    // Check if NO actual changes were made (all files identical)
    const actualChanges = fileChanges.filter(fc => fc.oldContent !== fc.newContent || fc.isNewFile);
    if (actualChanges.length === 0 && fileChanges.length > 0) {
        console.error('[Grok] CRITICAL: No actual file changes detected! Diff application completely failed.');
        console.error('[Grok] This means rollback will NOT be possible for these "changes".');
    }

    // Create the changeSet with applied: true directly to avoid race condition
    // where the persist happens before markApplied can set it to true
    const changeSet = changeTracker.addChangeSet(
        sessionId || 'unknown',
        fileChanges,
        cost,
        tokensUsed,
        `Applied ${edits.length} file(s)${identicalChanges.length > 0 ? ` (${identicalChanges.length} failed)` : ''}`,
        true // applied = true
    );
    
    changeSetToEditGroup.set(changeSet.id, editGroupId);
    
    const noActualChanges = actualChanges.length === 0 && fileChanges.length > 0;

    return { 
        success: true, 
        changeSet,
        failedDiffs: identicalChanges.map(fc => fc.filePath),
        noActualChanges,
        backups: backupRefs.size > 0 ? backupRefs : undefined
    };
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

/**
 * Revert a file to its original state using the Couchbase backup.
 * This is the ultimate fallback - restores the file to its state before ANY AI modifications.
 * @param filePath Absolute path to the file to revert
 * @param save Whether to save the file to disk after reverting (default: true)
 * @returns true if successful, false otherwise
 */
export async function revertToOriginalBackup(filePath: string, save: boolean = true): Promise<boolean> {
    try {
        const backup = await getOriginalBackup(filePath);
        if (!backup) {
            console.error(`[Grok] No original backup found for ${filePath}`);
            return false;
        }
        
        const originalContent = await restoreFromBackup(backup.id);
        if (!originalContent) {
            console.error(`[Grok] Failed to restore content from backup ${backup.id}`);
            return false;
        }
        
        const uri = vscode.Uri.file(filePath);
        const workspaceEdit = new vscode.WorkspaceEdit();
        
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(doc.getText().length)
            );
            workspaceEdit.replace(uri, fullRange, originalContent);
        } catch {
            // File doesn't exist - create it
            workspaceEdit.createFile(uri, { overwrite: true });
            workspaceEdit.insert(uri, new vscode.Position(0, 0), originalContent);
        }
        
        const success = await vscode.workspace.applyEdit(workspaceEdit);
        if (!success) {
            console.error(`[Grok] Failed to apply workspace edit for ${filePath}`);
            return false;
        }
        
        // Save to disk if requested
        if (save) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                await doc.save();
                console.log(`[Grok] Reverted and saved ${filePath} to original backup (MD5: ${backup.originalMd5})`);
            } catch (saveErr) {
                console.error(`[Grok] Failed to save reverted file ${filePath}:`, saveErr);
                return false;
            }
        } else {
            console.log(`[Grok] Reverted ${filePath} to original backup (MD5: ${backup.originalMd5}) - NOT SAVED`);
        }
        
        return true;
    } catch (err) {
        console.error(`[Grok] Error reverting ${filePath} to original:`, err);
        return false;
    }
}

/**
 * Fallback revert using stored oldContent from changeSet.
 * Use this when editSnapshots are not available (e.g., after extension reload).
 */
export async function revertChangeSetDirect(changeSet: { files: Array<{ filePath: string; oldContent: string; newContent?: string; isNewFile: boolean }> }): Promise<boolean> {
    const workspaceEdit = new vscode.WorkspaceEdit();
    let filesReverted = 0;
    let filesSkipped = 0;

    console.log(`[Grok] Direct revert starting for ${changeSet.files.length} file(s)`);

    for (const fileChange of changeSet.files) {
        try {
            const uri = vscode.Uri.file(fileChange.filePath);
            
            if (fileChange.isNewFile) {
                // File was created - delete it
                console.log(`[Grok] Deleting new file: ${fileChange.filePath}`);
                workspaceEdit.deleteFile(uri, { ignoreIfNotExists: true });
                filesReverted++;
            } else {
                // Verify the file exists and check if revert is needed
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const currentContent = doc.getText();
                    
                    // Skip if already at old content (already reverted or never changed)
                    if (currentContent === fileChange.oldContent) {
                        console.log(`[Grok] Skipping ${fileChange.filePath} - already at original content`);
                        filesSkipped++;
                        continue;
                    }
                    
                    // Verify we're reverting expected content (optional but helpful for debugging)
                    if (fileChange.newContent && currentContent !== fileChange.newContent) {
                        console.warn(`[Grok] Warning: ${fileChange.filePath} content differs from expected newContent - reverting anyway`);
                    }
                    
                    console.log(`[Grok] Restoring ${fileChange.filePath} to original content (${fileChange.oldContent.length} chars)`);
                    const fullRange = new vscode.Range(
                        doc.positionAt(0),
                        doc.positionAt(currentContent.length)
                    );
                    workspaceEdit.replace(uri, fullRange, fileChange.oldContent);
                    filesReverted++;
                } catch (docErr) {
                    console.error(`[Grok] Failed to open file for revert: ${fileChange.filePath}`, docErr);
                }
            }
        } catch (error) {
            console.error('[Grok] Failed to revert file directly:', fileChange.filePath, error);
        }
    }

    if (filesReverted === 0) {
        console.log(`[Grok] No files to revert (${filesSkipped} already at original)`);
        return true; // Consider success if nothing to do
    }

    const success = await vscode.workspace.applyEdit(workspaceEdit);
    
    if (success) {
        // Save all modified files
        for (const fileChange of changeSet.files) {
            if (!fileChange.isNewFile) {
                try {
                    const uri = vscode.Uri.file(fileChange.filePath);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await doc.save();
                } catch (saveErr) {
                    console.error('[Grok] Failed to save reverted file:', fileChange.filePath, saveErr);
                }
            }
        }
        console.log(`[Grok] Direct revert complete: ${filesReverted} file(s) restored, ${filesSkipped} skipped`);
    } else {
        console.error(`[Grok] Direct revert failed: workspace edit not applied`);
    }
    
    return success;
}

export async function revertToChangeSet(targetChangeSetId: string): Promise<boolean> {
    const history = changeTracker.getHistory();
    const targetIndex = history.findIndex(cs => cs.id === targetChangeSetId);
    
    console.log(`[Grok] revertToChangeSet called: targetId=${targetChangeSetId}, targetIndex=${targetIndex}, historyLength=${history.length}`);
    
    if (targetIndex === -1) {
        console.error(`[Grok] Target changeset not found in history: ${targetChangeSetId}`);
        return false;
    }

    // Collect all changesets that need reverting
    const toRevert: Array<{ cs: typeof history[0], reason?: string }> = [];
    
    for (let i = history.length - 1; i > targetIndex; i--) {
        const cs = history[i];
        
        // Check if this changeset has actual changes to revert
        const hasActualChanges = cs.files.some(f => f.oldContent !== f.newContent || f.isNewFile);
        
        if (!hasActualChanges) {
            console.warn(`[Grok] Skipping changeset ${cs.id} - no actual changes were made (line operations may have failed)`);
            toRevert.push({ cs, reason: 'no_actual_changes' });
            continue;
        }
        
        // Always include changesets with actual changes - the `applied` flag may be out of sync
        // with reality. We'll verify the actual file content when reverting.
        console.log(`[Grok] Adding changeset ${cs.id} to revert list (applied=${cs.applied}, files=${cs.files.length})`);
        toRevert.push({ cs });
    }
    
    console.log(`[Grok] Collected ${toRevert.length} changeset(s) to revert`);
    
    // Count how many have issues
    const problematic = toRevert.filter(r => r.reason === 'no_actual_changes');
    if (problematic.length > 0) {
        console.warn(`[Grok] ${problematic.length} changeset(s) have no actual changes - rollback may be incomplete`);
        vscode.window.showWarningMessage(
            `⚠️ ${problematic.length} change(s) failed to apply originally (AI hallucinated file content). These cannot be rolled back.`
        );
    }
    
    // Revert the ones that have actual changes
    for (const { cs, reason } of toRevert) {
        if (reason === 'no_actual_changes') {
            // Mark as reverted even though nothing to do
            changeTracker.markReverted(cs.id);
            continue;
        }
        
        const editGroupId = changeSetToEditGroup.get(cs.id);
        if (editGroupId) {
            try {
                await revertEdits(editGroupId);
            } catch (error) {
                console.error('Failed to revert change set via editGroup:', cs.id, error);
                // Fallback: use stored oldContent directly
                console.log('Attempting direct revert using stored oldContent...');
                const success = await revertChangeSetDirect(cs);
                if (success) {
                    changeTracker.markReverted(cs.id);
                }
            }
        } else {
            // No editGroup mapping - use direct revert
            console.log('No editGroup mapping, using direct revert for:', cs.id);
            const success = await revertChangeSetDirect(cs);
            if (success) {
                changeTracker.markReverted(cs.id);
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
 * 
 * IMPORTANT: This function must handle multiple diff formats:
 * 1. Pure +/- diffs (no context lines)
 * 2. Unified diffs with @@ hunk headers
 * 3. Diffs with context lines (space prefix) but no @@ headers
 */
export function applySimpleDiff(originalContent: string, diffContent: string): string {
    const diffLines = diffContent.split('\n');
    const resultLines: string[] = [];
    
    // Check if diff content is empty or malformed
    if (!diffContent || diffContent.trim() === '') {
        console.warn('[Grok] Empty diff content, returning original');
        return originalContent;
    }
    
    // Count different line types
    const addLines = diffLines.filter(l => l.startsWith('+'));
    const removeLines = diffLines.filter(l => l.startsWith('-'));
    const contextLines = diffLines.filter(l => l.startsWith(' '));
    const hasHunkHeaders = diffLines.some(l => l.startsWith('@@'));
    
    // CRITICAL: If this is supposed to be a diff but has NO diff markers,
    // return original unchanged to prevent file corruption
    if (addLines.length === 0 && removeLines.length === 0 && !hasHunkHeaders) {
        console.warn('[Grok] BLOCKED: Diff content has no +/- markers - would corrupt file. Content preview:', diffContent.slice(0, 200));
        return originalContent;
    }
    
    // If we have @@ headers, use unified diff parser
    if (hasHunkHeaders) {
        return applyUnifiedDiff(originalContent, diffContent);
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
        if (resultLines.length === 0 && addLines.length > 0) {
            console.warn('[Grok] Diff produced empty result, checking for issues');
        }
        
        return resultLines.join('\n');
    }
    
    // Has context lines but no @@ headers - try to apply intelligently
    // This handles AI-generated diffs that include context without proper headers
    console.log(`[Grok] Applying diff with context lines: +${addLines.length} -${removeLines.length} context:${contextLines.length}`);
    
    const originalLines = originalContent.split('\n');
    
    // Strategy: Find where the diff should apply by matching context lines
    // Then apply the +/- changes at that location
    
    // Extract the first few non-+/- lines as context to find match location
    const firstContextLines: string[] = [];
    for (const line of diffLines) {
        if (line.startsWith(' ')) {
            firstContextLines.push(line.substring(1));
        } else if (!line.startsWith('+') && !line.startsWith('-') && line.trim() !== '') {
            // Lines without prefix are also context
            firstContextLines.push(line);
        }
        if (firstContextLines.length >= 3) break;
    }
    
    // Try to find the match location in original file
    let matchIndex = -1;
    if (firstContextLines.length > 0) {
        for (let i = 0; i < originalLines.length; i++) {
            let matches = true;
            for (let j = 0; j < firstContextLines.length && i + j < originalLines.length; j++) {
                if (originalLines[i + j].trim() !== firstContextLines[j].trim()) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                matchIndex = i;
                break;
            }
        }
    }
    
    if (matchIndex === -1) {
        // Couldn't find context match - fall back to extracting just the + lines
        console.warn('[Grok] Could not find context match in original file, extracting + lines only');
        for (const line of diffLines) {
            if (line.startsWith('+')) {
                resultLines.push(line.substring(1));
            } else if (line.startsWith(' ')) {
                resultLines.push(line.substring(1));
            } else if (!line.startsWith('-') && line.trim() !== '') {
                resultLines.push(line);
            }
        }
        
        // If we got nothing useful, return the + lines with context
        if (resultLines.length === 0) {
            console.warn('[Grok] No lines extracted, returning original content unchanged');
            return originalContent;
        }
        
        return resultLines.join('\n');
    }
    
    // Apply the diff at the matched location
    let originalIdx = 0;
    let diffIdx = 0;
    
    // Copy lines before the match
    while (originalIdx < matchIndex) {
        resultLines.push(originalLines[originalIdx]);
        originalIdx++;
    }
    
    // Process the diff lines
    while (diffIdx < diffLines.length) {
        const line = diffLines[diffIdx];
        
        if (line.startsWith('-')) {
            // Remove line - skip in original
            originalIdx++;
            diffIdx++;
        } else if (line.startsWith('+')) {
            // Add line
            resultLines.push(line.substring(1));
            diffIdx++;
        } else if (line.startsWith(' ')) {
            // Context line - copy from original
            resultLines.push(originalLines[originalIdx] || line.substring(1));
            originalIdx++;
            diffIdx++;
        } else if (line.trim() === '') {
            // Empty line - could be context or just formatting
            diffIdx++;
        } else {
            // No prefix - treat as context
            resultLines.push(originalLines[originalIdx] || line);
            originalIdx++;
            diffIdx++;
        }
    }
    
    // Copy remaining original lines
    while (originalIdx < originalLines.length) {
        resultLines.push(originalLines[originalIdx]);
        originalIdx++;
    }
    
    return resultLines.join('\n');
}
