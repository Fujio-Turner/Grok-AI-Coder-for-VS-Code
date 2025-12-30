/**
 * File Corruption Detector - Detects when a file is already in a corrupted/inconsistent state
 * before applying new changes.
 * 
 * This module provides safeguards to prevent applying changes to files that:
 * 1. Show signs of previous incomplete/failed operations
 * 2. Have syntax corruption markers
 * 3. Are in an inconsistent state from partial writes
 * 4. Have been modified by another process since the AI read them
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { debug, info } from '../utils/logger';

export interface CorruptionIndicator {
    type: 'syntax' | 'partial_write' | 'stale' | 'truncation' | 'conflict_markers' | 'missing_closure';
    severity: 'error' | 'warning' | 'info';
    message: string;
    line?: number;
    context?: string;
}

export interface FileCorruptionResult {
    isCorrupted: boolean;
    isSuspicious: boolean;
    canProceed: boolean;
    indicators: CorruptionIndicator[];
    summary: string;
    /** Current file hash for comparison */
    currentHash: string;
    /** File size in bytes */
    sizeBytes: number;
    /** Line count */
    lineCount: number;
}

export interface FileCorruptionCheckOptions {
    /** Expected hash from AI's fileHashes (if available) */
    expectedHash?: string;
    /** Whether to check for syntax issues (may have false positives for some languages) */
    checkSyntax?: boolean;
    /** Language ID for syntax-aware checking */
    languageId?: string;
    /** Last known good hash (from session history) */
    lastKnownHash?: string;
}

/**
 * Compute MD5 hash of content
 */
function computeHash(content: string): string {
    return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

/**
 * Check a file for signs of corruption before applying changes.
 */
export async function checkFileCorruption(
    fileUri: vscode.Uri,
    options: FileCorruptionCheckOptions = {}
): Promise<FileCorruptionResult> {
    const indicators: CorruptionIndicator[] = [];
    let content = '';
    
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        content = doc.getText();
    } catch {
        // File doesn't exist - not corrupted, just new
        return {
            isCorrupted: false,
            isSuspicious: false,
            canProceed: true,
            indicators: [],
            summary: 'File does not exist (new file)',
            currentHash: '',
            sizeBytes: 0,
            lineCount: 0
        };
    }

    const currentHash = computeHash(content);
    const lines = content.split('\n');
    const languageId = options.languageId || getLanguageFromUri(fileUri);

    // 1. Hash mismatch detection (stale content)
    if (options.expectedHash && options.expectedHash !== currentHash) {
        indicators.push({
            type: 'stale',
            severity: 'error',
            message: `File has changed since AI read it. Expected hash: ${options.expectedHash.slice(0, 8)}..., Current: ${currentHash.slice(0, 8)}...`,
            context: 'The file was modified after the AI analyzed it. Re-attach the file for accurate changes.'
        });
    }

    // 2. Check for last known hash from history (detect unexpected modifications)
    if (options.lastKnownHash && options.lastKnownHash !== currentHash && !options.expectedHash) {
        indicators.push({
            type: 'stale',
            severity: 'warning',
            message: `File differs from last known state. May have been modified externally.`,
            context: `Last known hash: ${options.lastKnownHash.slice(0, 8)}..., Current: ${currentHash.slice(0, 8)}...`
        });
    }

    // 3. Conflict marker detection (git merge conflicts)
    const conflictMarkers = detectConflictMarkers(content, lines);
    indicators.push(...conflictMarkers);

    // 4. Partial write / truncation detection
    const truncationIndicators = detectTruncation(content, lines, languageId);
    indicators.push(...truncationIndicators);

    // 5. Syntax corruption markers (unbalanced brackets, incomplete structures)
    if (options.checkSyntax !== false) {
        const syntaxIndicators = detectSyntaxCorruption(content, lines, languageId);
        indicators.push(...syntaxIndicators);
    }

    // 6. Check for AI-specific corruption patterns
    const aiPatterns = detectAiCorruptionPatterns(content, lines);
    indicators.push(...aiPatterns);

    // Determine overall status
    const errorCount = indicators.filter(i => i.severity === 'error').length;
    const warningCount = indicators.filter(i => i.severity === 'warning').length;
    
    const isCorrupted = errorCount > 0;
    const isSuspicious = warningCount > 0;
    const canProceed = !isCorrupted; // Block on errors, allow with warnings

    let summary: string;
    if (isCorrupted) {
        summary = `File appears corrupted: ${errorCount} error(s) detected. Changes blocked to prevent further damage.`;
    } else if (isSuspicious) {
        summary = `File has ${warningCount} suspicious indicator(s). Proceed with caution.`;
    } else {
        summary = 'File integrity check passed.';
    }

    return {
        isCorrupted,
        isSuspicious,
        canProceed,
        indicators,
        summary,
        currentHash,
        sizeBytes: content.length,
        lineCount: lines.length
    };
}

/**
 * Detect git merge conflict markers.
 */
function detectConflictMarkers(content: string, lines: string[]): CorruptionIndicator[] {
    const indicators: CorruptionIndicator[] = [];
    
    const hasConflictStart = content.includes('<<<<<<<');
    const hasConflictMiddle = content.includes('=======');
    const hasConflictEnd = content.includes('>>>>>>>');
    
    if (hasConflictStart || hasConflictEnd) {
        // Find specific lines
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('<<<<<<<')) {
                indicators.push({
                    type: 'conflict_markers',
                    severity: 'error',
                    message: 'Git merge conflict marker found: <<<<<<<',
                    line: i + 1,
                    context: line.substring(0, 50)
                });
            } else if (line.startsWith('>>>>>>>')) {
                indicators.push({
                    type: 'conflict_markers',
                    severity: 'error',
                    message: 'Git merge conflict marker found: >>>>>>>',
                    line: i + 1,
                    context: line.substring(0, 50)
                });
            }
        }
        
        // Only report once if multiple markers
        if (indicators.length === 0 && (hasConflictStart || hasConflictMiddle || hasConflictEnd)) {
            indicators.push({
                type: 'conflict_markers',
                severity: 'error',
                message: 'File contains unresolved merge conflict markers',
                context: 'Resolve merge conflicts before applying AI changes'
            });
        }
    }
    
    return indicators;
}

/**
 * Detect truncation or partial write indicators.
 */
function detectTruncation(content: string, lines: string[], languageId: string): CorruptionIndicator[] {
    const indicators: CorruptionIndicator[] = [];
    const trimmed = content.trimEnd();
    
    // Check for common truncation markers
    if (trimmed.endsWith('...')) {
        const lastLine = lines.length;
        indicators.push({
            type: 'truncation',
            severity: 'warning',
            message: 'File ends with "..." which may indicate truncation',
            line: lastLine,
            context: lines[lastLine - 1]?.substring(0, 50)
        });
    }
    
    // Check for incomplete JSON
    if (languageId === 'json' || languageId === 'jsonc') {
        const jsonIndicators = detectJsonTruncation(content, lines);
        indicators.push(...jsonIndicators);
    }
    
    // Check for common mid-statement truncation
    const midStatementPatterns = [
        { pattern: /,\s*$/, message: 'File ends with trailing comma (incomplete)' },
        { pattern: /:\s*$/, message: 'File ends with colon (incomplete assignment)' },
        { pattern: /\(\s*$/, message: 'File ends with unclosed parenthesis' },
        { pattern: /\{\s*$/, message: 'File ends with unclosed brace' },
        { pattern: /\[\s*$/, message: 'File ends with unclosed bracket' },
        { pattern: /=\s*$/, message: 'File ends with incomplete assignment' }
    ];
    
    for (const { pattern, message } of midStatementPatterns) {
        if (pattern.test(trimmed)) {
            indicators.push({
                type: 'truncation',
                severity: 'warning',
                message,
                line: lines.length,
                context: lines[lines.length - 1]?.substring(0, 50)
            });
            break; // Only report one
        }
    }
    
    return indicators;
}

/**
 * Detect JSON-specific truncation issues.
 */
function detectJsonTruncation(content: string, lines: string[]): CorruptionIndicator[] {
    const indicators: CorruptionIndicator[] = [];
    
    try {
        JSON.parse(content);
    } catch (e: any) {
        // JSON parse failed - could be intentional (JSONC with comments) or corruption
        const errorMessage = e.message || '';
        
        // Check if it's a clear truncation (unexpected end)
        if (errorMessage.includes('Unexpected end') || errorMessage.includes('end of JSON input')) {
            indicators.push({
                type: 'truncation',
                severity: 'error',
                message: 'JSON file appears truncated (parse failed with unexpected end)',
                context: errorMessage
            });
        } else if (errorMessage.includes('Unexpected token')) {
            // Could be JSONC (comments) or corruption - just warn
            indicators.push({
                type: 'syntax',
                severity: 'warning',
                message: 'JSON parse error (may be JSONC with comments)',
                context: errorMessage.substring(0, 100)
            });
        }
    }
    
    return indicators;
}

/**
 * Detect syntax corruption (unbalanced brackets, etc).
 */
function detectSyntaxCorruption(content: string, lines: string[], languageId: string): CorruptionIndicator[] {
    const indicators: CorruptionIndicator[] = [];
    
    // Skip for certain file types
    const skipLanguages = ['markdown', 'text', 'plaintext', 'log'];
    if (skipLanguages.includes(languageId)) {
        return indicators;
    }
    
    // Count brackets (simple heuristic - doesn't account for strings/comments)
    const braceCount = countBrackets(content);
    
    if (braceCount.curly !== 0) {
        indicators.push({
            type: 'missing_closure',
            severity: Math.abs(braceCount.curly) > 2 ? 'error' : 'warning',
            message: `Unbalanced curly braces: ${braceCount.curly > 0 ? 'missing ' + braceCount.curly + ' closing' : 'extra ' + Math.abs(braceCount.curly) + ' closing'}`,
            context: `Found ${braceCount.openCurly} '{' and ${braceCount.closeCurly} '}'`
        });
    }
    
    if (braceCount.square !== 0) {
        indicators.push({
            type: 'missing_closure',
            severity: Math.abs(braceCount.square) > 2 ? 'error' : 'warning',
            message: `Unbalanced square brackets: ${braceCount.square > 0 ? 'missing ' + braceCount.square + ' closing' : 'extra ' + Math.abs(braceCount.square) + ' closing'}`,
            context: `Found ${braceCount.openSquare} '[' and ${braceCount.closeSquare} ']'`
        });
    }
    
    if (braceCount.paren !== 0) {
        indicators.push({
            type: 'missing_closure',
            severity: Math.abs(braceCount.paren) > 3 ? 'error' : 'warning',
            message: `Unbalanced parentheses: ${braceCount.paren > 0 ? 'missing ' + braceCount.paren + ' closing' : 'extra ' + Math.abs(braceCount.paren) + ' closing'}`,
            context: `Found ${braceCount.openParen} '(' and ${braceCount.closeParen} ')'`
        });
    }
    
    return indicators;
}

interface BracketCount {
    curly: number;  // { minus }
    square: number; // [ minus ]
    paren: number;  // ( minus )
    openCurly: number;
    closeCurly: number;
    openSquare: number;
    closeSquare: number;
    openParen: number;
    closeParen: number;
}

/**
 * Count brackets in content (simple heuristic, ignores strings/comments).
 */
function countBrackets(content: string): BracketCount {
    // Simple approach: just count characters
    // This isn't perfect but catches obvious issues
    let openCurly = 0, closeCurly = 0;
    let openSquare = 0, closeSquare = 0;
    let openParen = 0, closeParen = 0;
    
    for (const char of content) {
        switch (char) {
            case '{': openCurly++; break;
            case '}': closeCurly++; break;
            case '[': openSquare++; break;
            case ']': closeSquare++; break;
            case '(': openParen++; break;
            case ')': closeParen++; break;
        }
    }
    
    return {
        curly: openCurly - closeCurly,
        square: openSquare - closeSquare,
        paren: openParen - closeParen,
        openCurly,
        closeCurly,
        openSquare,
        closeSquare,
        openParen,
        closeParen
    };
}

/**
 * Detect AI-specific corruption patterns.
 */
function detectAiCorruptionPatterns(content: string, lines: string[]): CorruptionIndicator[] {
    const indicators: CorruptionIndicator[] = [];
    
    // Check for common AI truncation markers
    const aiTruncationMarkers = [
        { pattern: /\[\.\.\.code truncated\.\.\.\]/i, message: 'AI truncation marker found' },
        { pattern: /\/\/ \.\.\. rest of file/i, message: 'AI "rest of file" marker found' },
        { pattern: /# \.\.\. remaining code/i, message: 'AI "remaining code" marker found' },
        { pattern: /\/\/ TODO: AI implementation/i, message: 'AI incomplete implementation marker' },
        { pattern: /\[TRUNCATED\]/i, message: 'TRUNCATED marker found' },
        { pattern: /\[CONTINUED\]/i, message: 'CONTINUED marker found (incomplete split)' },
        { pattern: /\/\*\s*\.\.\.\s*\*\//g, message: 'AI "..." comment marker found' }
    ];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { pattern, message } of aiTruncationMarkers) {
            if (pattern.test(line)) {
                indicators.push({
                    type: 'partial_write',
                    severity: 'warning',
                    message,
                    line: i + 1,
                    context: line.substring(0, 60)
                });
            }
        }
    }
    
    // Check for duplicate adjacent lines (sign of paste errors)
    for (let i = 1; i < lines.length; i++) {
        const prev = lines[i - 1].trim();
        const curr = lines[i].trim();
        if (prev.length > 30 && prev === curr) {
            indicators.push({
                type: 'partial_write',
                severity: 'info',
                message: 'Duplicate adjacent lines detected (possible paste error)',
                line: i + 1,
                context: curr.substring(0, 50)
            });
            break; // Only report once
        }
    }
    
    return indicators;
}

/**
 * Get language ID from file URI.
 */
function getLanguageFromUri(fileUri: vscode.Uri): string {
    const ext = fileUri.fsPath.split('.').pop()?.toLowerCase() || '';
    const extMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'typescriptreact',
        'js': 'javascript',
        'jsx': 'javascriptreact',
        'py': 'python',
        'json': 'json',
        'jsonc': 'jsonc',
        'md': 'markdown',
        'html': 'html',
        'css': 'css',
        'scss': 'scss',
        'yaml': 'yaml',
        'yml': 'yaml',
        'xml': 'xml',
        'sql': 'sql',
        'sh': 'shellscript',
        'bash': 'shellscript',
        'go': 'go',
        'rs': 'rust',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c'
    };
    return extMap[ext] || 'text';
}

/**
 * Quick check if a file needs full corruption analysis.
 * Returns true if file shows obvious signs that warrant deeper inspection.
 */
export async function needsCorruptionCheck(
    fileUri: vscode.Uri,
    expectedHash?: string
): Promise<boolean> {
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const content = doc.getText();
        
        // Quick checks that indicate we need full analysis
        
        // 1. Hash mismatch
        if (expectedHash) {
            const currentHash = computeHash(content);
            if (expectedHash !== currentHash) {
                return true;
            }
        }
        
        // 2. Conflict markers
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
            return true;
        }
        
        // 3. AI truncation markers
        if (content.includes('[...code truncated') || content.includes('[TRUNCATED]')) {
            return true;
        }
        
        // 4. File ends suspiciously
        const trimmed = content.trimEnd();
        if (trimmed.endsWith('...') || trimmed.endsWith(',') || trimmed.endsWith(':')) {
            return true;
        }
        
        return false;
    } catch {
        // File doesn't exist - no corruption check needed
        return false;
    }
}

/**
 * Format corruption result for display to user.
 */
export function formatCorruptionReport(result: FileCorruptionResult, filePath: string): string {
    if (!result.isCorrupted && !result.isSuspicious) {
        return '';
    }
    
    let report = `\n⚠️ **File Integrity Issues Detected: ${filePath}**\n`;
    report += `Status: ${result.isCorrupted ? '🛑 CORRUPTED (changes blocked)' : '⚡ SUSPICIOUS (proceed with caution)'}\n\n`;
    
    for (const indicator of result.indicators) {
        const icon = indicator.severity === 'error' ? '❌' : indicator.severity === 'warning' ? '⚠️' : 'ℹ️';
        report += `${icon} **${indicator.type}**: ${indicator.message}`;
        if (indicator.line) {
            report += ` (line ${indicator.line})`;
        }
        report += '\n';
        if (indicator.context) {
            report += `   Context: \`${indicator.context}\`\n`;
        }
    }
    
    return report;
}
