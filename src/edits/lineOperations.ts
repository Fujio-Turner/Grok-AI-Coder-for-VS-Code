/**
 * Line-level operations for safe, transactional file edits.
 * 
 * Instead of replacing whole file content or applying diffs,
 * this module validates each line operation before applying.
 * If any validation fails, the entire edit is aborted.
 */

import * as vscode from 'vscode';

// Types of line operations
export type LineOperationType = 'insert' | 'delete' | 'replace' | 'insertAfter' | 'insertBefore';

export interface LineOperation {
    type: LineOperationType;
    line: number;              // 1-indexed line number
    expectedContent?: string;  // For delete/replace: what we expect to find (validation)
    newContent?: string;       // For insert/replace: what to add
    fuzzyMatch?: boolean;      // Allow whitespace/case differences in validation
}

export interface LineOperationResult {
    success: boolean;
    error?: string;
    failedOperation?: LineOperation;
    failedAtLine?: number;
    newContent?: string;       // The resulting file content if successful
}

export interface ValidationResult {
    valid: boolean;
    error?: string;
    actualContent?: string;
}

/**
 * Validate a single line operation against the current file content
 */
export function validateOperation(
    lines: string[],
    op: LineOperation
): ValidationResult {
    const lineIndex = op.line - 1; // Convert to 0-indexed
    
    // Check line exists (for operations that need it)
    if (op.type !== 'insert' && op.type !== 'insertAfter' && op.type !== 'insertBefore') {
        if (lineIndex < 0 || lineIndex >= lines.length) {
            return {
                valid: false,
                error: `Line ${op.line} does not exist (file has ${lines.length} lines)`
            };
        }
    }
    
    // For delete/replace, validate expected content matches
    if ((op.type === 'delete' || op.type === 'replace') && op.expectedContent !== undefined) {
        const actualLine = lines[lineIndex];
        const expected = op.expectedContent;
        
        if (op.fuzzyMatch) {
            // Fuzzy: ignore leading/trailing whitespace, case-insensitive
            const normalizedActual = actualLine.trim().toLowerCase();
            const normalizedExpected = expected.trim().toLowerCase();
            if (!normalizedActual.includes(normalizedExpected) && !normalizedExpected.includes(normalizedActual)) {
                return {
                    valid: false,
                    error: `Line ${op.line} content mismatch (fuzzy)`,
                    actualContent: actualLine
                };
            }
        } else {
            // Strict: must contain the expected content
            if (!actualLine.includes(expected)) {
                return {
                    valid: false,
                    error: `Line ${op.line} does not contain expected content: "${expected}"`,
                    actualContent: actualLine
                };
            }
        }
    }
    
    return { valid: true };
}

/**
 * Apply a single line operation to the lines array (mutates in place)
 */
export function applyOperation(
    lines: string[],
    op: LineOperation
): void {
    const lineIndex = op.line - 1; // Convert to 0-indexed
    
    switch (op.type) {
        case 'delete':
            lines.splice(lineIndex, 1);
            break;
            
        case 'replace':
            if (op.newContent !== undefined) {
                // If expectedContent is provided, do a substring replace
                if (op.expectedContent) {
                    lines[lineIndex] = lines[lineIndex].replace(op.expectedContent, op.newContent);
                } else {
                    lines[lineIndex] = op.newContent;
                }
            }
            break;
            
        case 'insert':
            // Insert at the specified line (pushing existing content down)
            if (op.newContent !== undefined) {
                lines.splice(lineIndex, 0, op.newContent);
            }
            break;
            
        case 'insertAfter':
            if (op.newContent !== undefined) {
                lines.splice(lineIndex + 1, 0, op.newContent);
            }
            break;
            
        case 'insertBefore':
            if (op.newContent !== undefined) {
                lines.splice(lineIndex, 0, op.newContent);
            }
            break;
    }
}

/**
 * Validate and apply all line operations atomically.
 * Returns the new file content if all validations pass, or an error if any fail.
 * 
 * Operations are applied in reverse order for deletes to maintain correct line numbers.
 */
export function validateAndApplyOperations(
    originalContent: string,
    operations: LineOperation[]
): LineOperationResult {
    const lines = originalContent.split('\n');
    
    // Sort operations: process from bottom to top for deletes,
    // and group by type to handle line number shifts correctly
    const sortedOps = [...operations].sort((a, b) => {
        // Deletes should be processed bottom-to-top
        if (a.type === 'delete' && b.type === 'delete') {
            return b.line - a.line;
        }
        // Inserts should be processed bottom-to-top too
        if ((a.type === 'insert' || a.type === 'insertAfter' || a.type === 'insertBefore') &&
            (b.type === 'insert' || b.type === 'insertAfter' || b.type === 'insertBefore')) {
            return b.line - a.line;
        }
        // Replaces can be in any order (they don't shift lines)
        return 0;
    });
    
    // First pass: validate all operations
    for (const op of sortedOps) {
        const validation = validateOperation(lines, op);
        if (!validation.valid) {
            return {
                success: false,
                error: validation.error,
                failedOperation: op,
                failedAtLine: op.line
            };
        }
    }
    
    // Second pass: apply all operations (already sorted)
    for (const op of sortedOps) {
        applyOperation(lines, op);
    }
    
    return {
        success: true,
        newContent: lines.join('\n')
    };
}

/**
 * Parse AI's line operations from structured response
 */
export interface FileLineOperations {
    path: string;
    operations: LineOperation[];
}

/**
 * Apply line operations to a file with full validation
 */
export async function applyFileLineOperations(
    fileUri: vscode.Uri,
    operations: LineOperation[]
): Promise<LineOperationResult> {
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const originalContent = doc.getText();
        
        const result = validateAndApplyOperations(originalContent, operations);
        
        if (!result.success) {
            console.error(`[Grok] Line operation failed:`, result.error);
            return result;
        }
        
        // Apply the edit
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            doc.lineAt(0).range.start,
            doc.lineAt(doc.lineCount - 1).range.end
        );
        edit.replace(fileUri, fullRange, result.newContent!);
        
        const success = await vscode.workspace.applyEdit(edit);
        if (!success) {
            return {
                success: false,
                error: 'VS Code failed to apply the edit'
            };
        }
        
        // Save the file
        await doc.save();
        
        return result;
        
    } catch (err: any) {
        return {
            success: false,
            error: `Failed to apply line operations: ${err.message}`
        };
    }
}

/**
 * Convert a unified diff to line operations for safer application.
 * This is a bridge for backwards compatibility with diff format.
 */
export function diffToLineOperations(
    originalContent: string,
    diffContent: string
): LineOperation[] | null {
    const operations: LineOperation[] = [];
    const diffLines = diffContent.split('\n');
    
    let currentLine = 1;
    
    for (const line of diffLines) {
        // Skip hunk headers
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+)/);
            if (match) {
                currentLine = parseInt(match[1], 10);
            }
            continue;
        }
        
        if (line.startsWith('-')) {
            // Delete this line
            operations.push({
                type: 'delete',
                line: currentLine,
                expectedContent: line.substring(1).trim(),
                fuzzyMatch: true
            });
            currentLine++;
        } else if (line.startsWith('+')) {
            // Insert new line
            operations.push({
                type: 'insertBefore',
                line: currentLine,
                newContent: line.substring(1)
            });
            // Don't increment - we're inserting, not moving past
        } else if (line.startsWith(' ')) {
            // Context line - just move past it
            currentLine++;
        } else {
            // No prefix - treat as context
            currentLine++;
        }
    }
    
    return operations.length > 0 ? operations : null;
}
