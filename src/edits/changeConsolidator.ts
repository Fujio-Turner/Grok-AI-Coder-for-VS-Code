/**
 * Change Consolidator - Merges multiple file changes for the same file.
 * 
 * When AI returns multiple fileChanges for the same file (each with same MD5 hash),
 * only the first one can apply successfully because subsequent changes will have
 * stale hashes after the first modification.
 * 
 * This module consolidates all changes for a file into a single operation,
 * merging lineOperations and applying them sequentially in the correct order.
 */

import { FileChange, LineOperation } from '../prompts/responseSchema';

export interface ConsolidationResult {
    /** Consolidated file changes - one per unique file path */
    consolidatedChanges: FileChange[];
    /** Files that had multiple changes merged */
    mergedFiles: string[];
    /** Statistics about the consolidation */
    stats: {
        originalCount: number;
        consolidatedCount: number;
        mergedCount: number;
    };
}

export interface MergeConflict {
    filePath: string;
    line: number;
    changes: LineOperation[];
    resolution: 'last-wins' | 'combined';
}

/**
 * Consolidate multiple file changes for the same file into single operations.
 * 
 * Strategy:
 * 1. Group changes by file path
 * 2. For files with multiple changes, merge lineOperations in order
 * 3. Handle overlapping line operations by applying last-wins or combining
 * 4. Preserve the MD5 hash from the first change (all should be same)
 * 
 * @param fileChanges Array of file changes from AI response
 * @returns Consolidated changes with one entry per unique file
 */
export function consolidateFileChanges(fileChanges: FileChange[]): ConsolidationResult {
    if (!fileChanges || fileChanges.length === 0) {
        return {
            consolidatedChanges: [],
            mergedFiles: [],
            stats: { originalCount: 0, consolidatedCount: 0, mergedCount: 0 }
        };
    }

    // Group changes by normalized file path
    const changesByFile = new Map<string, FileChange[]>();
    
    for (const fc of fileChanges) {
        const normalizedPath = normalizePath(fc.path);
        const existing = changesByFile.get(normalizedPath) || [];
        existing.push(fc);
        changesByFile.set(normalizedPath, existing);
    }

    const consolidatedChanges: FileChange[] = [];
    const mergedFiles: string[] = [];

    for (const [filePath, changes] of changesByFile) {
        if (changes.length === 1) {
            // Single change - no consolidation needed
            consolidatedChanges.push(changes[0]);
        } else {
            // Multiple changes - need to merge
            const merged = mergeFileChanges(changes);
            consolidatedChanges.push(merged);
            mergedFiles.push(filePath);
        }
    }

    return {
        consolidatedChanges,
        mergedFiles,
        stats: {
            originalCount: fileChanges.length,
            consolidatedCount: consolidatedChanges.length,
            mergedCount: fileChanges.length - consolidatedChanges.length
        }
    };
}

/**
 * Merge multiple changes for the same file into one.
 */
function mergeFileChanges(changes: FileChange[]): FileChange {
    // Use the first change as the base (has the original hash context)
    const base = { ...changes[0] };
    
    // Check if using lineOperations (preferred) or content-based changes
    const hasLineOps = changes.some(c => c.lineOperations && c.lineOperations.length > 0);
    const hasContentChanges = changes.some(c => c.content && !c.lineOperations?.length);

    if (hasLineOps) {
        // Merge all lineOperations
        base.lineOperations = mergeLineOperations(changes);
        // Clear content since we're using lineOperations
        if (base.lineOperations.length > 0) {
            // Keep content as empty - lineOperations will be applied
        }
    } else if (hasContentChanges) {
        // Content-based changes - more complex
        // For isDiff changes, we need to combine diffs
        // For full content, last one wins
        base.content = mergeContentChanges(changes);
        base.isDiff = changes.some(c => c.isDiff);
    }

    // Merge line ranges if applicable
    if (changes.some(c => c.lineRange)) {
        base.lineRange = mergeLineRanges(changes);
    }

    // Keep first todoIndex (or combine if different)
    const todoIndices = changes
        .map(c => c.todoIndex)
        .filter((idx): idx is number => idx !== undefined);
    if (todoIndices.length > 0) {
        base.todoIndex = todoIndices[0];
    }

    return base;
}

/**
 * Merge line operations from multiple changes.
 * 
 * Strategy:
 * 1. Collect all operations
 * 2. Sort by line number (descending for safe application - bottom-up)
 * 3. Handle conflicts on same line (last operation wins, or combine inserts)
 */
function mergeLineOperations(changes: FileChange[]): LineOperation[] {
    const allOps: Array<LineOperation & { changeIndex: number }> = [];
    
    // Collect all operations with their source change index
    changes.forEach((change, changeIndex) => {
        if (change.lineOperations) {
            for (const op of change.lineOperations) {
                allOps.push({ ...op, changeIndex });
            }
        }
    });

    if (allOps.length === 0) {
        return [];
    }

    // Group operations by line number
    const opsByLine = new Map<number, Array<LineOperation & { changeIndex: number }>>();
    for (const op of allOps) {
        const existing = opsByLine.get(op.line) || [];
        existing.push(op);
        opsByLine.set(op.line, existing);
    }

    const mergedOps: LineOperation[] = [];

    // Process each line's operations
    for (const [line, ops] of opsByLine) {
        if (ops.length === 1) {
            // Single operation on this line
            const { changeIndex, ...op } = ops[0];
            mergedOps.push(op);
        } else {
            // Multiple operations on same line - need to resolve
            const resolved = resolveLineConflict(line, ops);
            mergedOps.push(...resolved);
        }
    }

    // Sort by line number DESCENDING for bottom-up application
    // This prevents line number shifting issues
    mergedOps.sort((a, b) => b.line - a.line);

    return mergedOps;
}

/**
 * Resolve conflicting operations on the same line.
 */
function resolveLineConflict(
    line: number, 
    ops: Array<LineOperation & { changeIndex: number }>
): LineOperation[] {
    // Sort by change index to maintain order of AI's responses
    ops.sort((a, b) => a.changeIndex - b.changeIndex);

    // Group by operation type
    const deletes = ops.filter(o => o.type === 'delete');
    const replaces = ops.filter(o => o.type === 'replace');
    const inserts = ops.filter(o => o.type === 'insert' || o.type === 'insertAfter' || o.type === 'insertBefore');

    const result: LineOperation[] = [];

    // If there's a delete, it takes precedence
    if (deletes.length > 0) {
        const { changeIndex, ...lastDelete } = deletes[deletes.length - 1];
        result.push(lastDelete);
        return result;
    }

    // If there are replaces, use the last one (most recent)
    if (replaces.length > 0) {
        const { changeIndex, ...lastReplace } = replaces[replaces.length - 1];
        result.push(lastReplace);
        return result;
    }

    // For inserts, we can combine them (insert all content)
    if (inserts.length > 0) {
        // Combine insert contents
        const combinedContent = inserts
            .map(i => i.newContent || '')
            .filter(c => c)
            .join('\n');
        
        const { changeIndex, ...firstInsert } = inserts[0];
        result.push({
            ...firstInsert,
            newContent: combinedContent
        });
    }

    return result;
}

/**
 * Merge content-based changes.
 * For diff changes, combines them. For full content, last one wins.
 */
function mergeContentChanges(changes: FileChange[]): string {
    const diffChanges = changes.filter(c => c.isDiff);
    const fullChanges = changes.filter(c => !c.isDiff);

    if (fullChanges.length > 0) {
        // Last full content change wins
        return fullChanges[fullChanges.length - 1].content;
    }

    if (diffChanges.length > 0) {
        // Combine diff contents
        return diffChanges.map(c => c.content).join('\n');
    }

    return changes[changes.length - 1].content;
}

/**
 * Merge line ranges from multiple changes.
 */
function mergeLineRanges(changes: FileChange[]): { start: number; end: number } | undefined {
    const ranges = changes
        .map(c => c.lineRange)
        .filter((r): r is { start: number; end: number } => r !== undefined);

    if (ranges.length === 0) {
        return undefined;
    }

    // Find the overall range that covers all changes
    const start = Math.min(...ranges.map(r => r.start));
    const end = Math.max(...ranges.map(r => r.end));

    return { start, end };
}

/**
 * Normalize file path for consistent comparison.
 */
function normalizePath(path: string): string {
    // Remove leading ./ or /
    let normalized = path.replace(/^\.\//, '').replace(/^\//, '');
    // Normalize slashes
    normalized = normalized.replace(/\\/g, '/');
    // Lowercase for case-insensitive comparison (optional - depends on OS)
    return normalized;
}

/**
 * Check if consolidation is needed for a set of file changes.
 */
export function needsConsolidation(fileChanges: FileChange[]): boolean {
    if (!fileChanges || fileChanges.length <= 1) {
        return false;
    }

    const paths = new Set(fileChanges.map(fc => normalizePath(fc.path)));
    return paths.size < fileChanges.length;
}

/**
 * Get a summary of what would be consolidated.
 */
export function getConsolidationPreview(fileChanges: FileChange[]): string {
    const changesByFile = new Map<string, number>();
    
    for (const fc of fileChanges) {
        const path = normalizePath(fc.path);
        changesByFile.set(path, (changesByFile.get(path) || 0) + 1);
    }

    const duplicates = Array.from(changesByFile.entries())
        .filter(([_, count]) => count > 1)
        .map(([path, count]) => `${path} (${count} changes)`);

    if (duplicates.length === 0) {
        return 'No consolidation needed';
    }

    return `Will merge: ${duplicates.join(', ')}`;
}
