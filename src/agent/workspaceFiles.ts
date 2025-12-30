/**
 * Workspace file utilities for finding and reading files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { debug, info } from '../utils/logger';

/**
 * Add line numbers to file content (1-indexed).
 * Format: "  1: content" with padding for alignment.
 * This helps AI accurately reference line numbers in file edits.
 */
export function addLineNumbers(content: string): string {
    const lines = content.split('\n');
    const padding = String(lines.length).length;
    return lines.map((line, i) => {
        const lineNum = String(i + 1).padStart(padding, ' ');
        return `${lineNum}: ${line}`;
    }).join('\n');
}

export interface FileMatch {
    path: string;
    relativePath: string;
    name: string;
}

export interface FileContent {
    path: string;
    relativePath: string;
    name: string;
    content: string;
    language: string;
    lineCount: number;
    /** MD5 hash of file content - computed when file is read */
    md5Hash: string;
}

/**
 * Find files matching a glob pattern in the workspace.
 */
/**
 * Directories to always exclude from file searches.
 * These are dependencies, build artifacts, and other non-project files.
 */
const EXCLUDED_DIRECTORIES = [
    // Package managers / dependencies
    '**/node_modules/**',
    '**/venv/**',
    '**/.venv/**',
    '**/env/**',
    '**/.env/**',
    '**/virtualenv/**',
    '**/__pycache__/**',
    '**/.pycache/**',
    '**/site-packages/**',
    '**/dist-packages/**',
    '**/vendor/**',
    '**/bower_components/**',
    
    // Build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/target/**',  // Rust/Java
    '**/bin/**',
    '**/obj/**',     // .NET
    
    // Version control
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    
    // IDE / Editor
    '**/.idea/**',
    '**/.vscode/**',
    '**/.vs/**',
    
    // Cache / Temp
    '**/.cache/**',
    '**/tmp/**',
    '**/temp/**',
    '**/*.egg-info/**',
    '**/.eggs/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.tox/**',
    
    // Coverage / Test artifacts
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
];

/**
 * Build the exclusion pattern for VS Code file search.
 */
function getExclusionPattern(): string {
    return `{${EXCLUDED_DIRECTORIES.join(',')}}`;
}

export async function findFiles(pattern: string, maxResults: number = 20): Promise<FileMatch[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    debug(`Finding files matching: ${pattern}`);
    
    try {
        const exclusions = getExclusionPattern();
        const uris = await vscode.workspace.findFiles(pattern, exclusions, maxResults);
        
        const matches: FileMatch[] = uris.map(uri => ({
            path: uri.fsPath,
            relativePath: vscode.workspace.asRelativePath(uri),
            name: path.basename(uri.fsPath)
        }));

        info(`Found ${matches.length} files matching ${pattern}`);
        return matches;
    } catch (error) {
        debug(`Error finding files: ${error}`);
        return [];
    }
}

/**
 * Compute MD5 hash of content
 */
export function computeMd5Hash(content: string): string {
    return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

/**
 * Read file contents.
 */
export async function readFile(filePath: string): Promise<FileContent | null> {
    try {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const content = document.getText();
        
        return {
            path: filePath,
            relativePath: vscode.workspace.asRelativePath(uri),
            name: path.basename(filePath),
            content,
            language: document.languageId,
            lineCount: document.lineCount,
            md5Hash: computeMd5Hash(content)
        };
    } catch (error) {
        debug(`Error reading file ${filePath}: ${error}`);
        return null;
    }
}

/**
 * Read multiple files in parallel using Promise.all.
 * This is significantly faster than sequential reading for multiple files.
 */
export async function readFiles(filePaths: string[]): Promise<FileContent[]> {
    if (filePaths.length === 0) {
        return [];
    }
    
    // Read all files in parallel
    const filePromises = filePaths.map(filePath => readFile(filePath));
    const results = await Promise.all(filePromises);
    
    // Filter out null results (files that failed to read)
    return results.filter((content): content is FileContent => content !== null);
}

/**
 * Read multiple files in parallel with progress callback.
 * Useful for UI feedback during batch file loading.
 */
export async function readFilesWithProgress(
    filePaths: string[],
    onProgress?: (loaded: number, total: number, fileName: string) => void
): Promise<FileContent[]> {
    if (filePaths.length === 0) {
        return [];
    }
    
    const total = filePaths.length;
    let loaded = 0;
    
    // Read all files in parallel, but track progress
    const filePromises = filePaths.map(async (filePath) => {
        const result = await readFile(filePath);
        loaded++;
        const fileName = filePath.split('/').pop() || filePath;
        onProgress?.(loaded, total, fileName);
        return result;
    });
    
    const results = await Promise.all(filePromises);
    return results.filter((content): content is FileContent => content !== null);
}

/**
 * Find and read files matching a pattern.
 */
export async function findAndReadFiles(pattern: string, maxResults: number = 10): Promise<FileContent[]> {
    const matches = await findFiles(pattern, maxResults);
    const filePaths = matches.map(m => m.path);
    return readFiles(filePaths);
}

/**
 * Format file contents for inclusion in a prompt.
 */
export function formatFilesForPrompt(files: FileContent[]): string {
    if (files.length === 0) {
        return 'No matching files found.';
    }

    return files.map(file => {
        return `## File: ${file.relativePath}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
    }).join('\n\n');
}

/**
 * Get summary of files (for display).
 */
export function getFilesSummary(files: FileContent[]): string {
    if (files.length === 0) {
        return 'No files found';
    }
    
    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
    return `${files.length} file(s), ${totalLines} lines total`;
}

// ============================================================================
// User Message Truncation - Detect and summarize pasted code in user messages
// ============================================================================

/**
 * Thresholds for detecting pasted code in user messages.
 */
const PASTED_CODE_MIN_LINES = 50;
const PASTED_CODE_MIN_CHARS = 2000;
const PASTED_CODE_CONTEXT_LINES = 30; // Lines to keep around the error

/**
 * Patterns that indicate code was pasted (not just described)
 */
const CODE_BLOCK_INDICATORS = [
    /^(import|from|def |class |async def |function |const |let |var |export |package |use |#include)/m,
    /^\s*@\w+\s*$/m, // Decorators
    /^\s*"""[\s\S]+?"""/m, // Docstrings
    /^\s*\/\*[\s\S]+?\*\//m, // Block comments
    /^\s*#!\/usr\/bin/m, // Shebang
];

/**
 * Detects if user message contains pasted code (not in markdown code blocks).
 * Returns info about the pasted code if found.
 */
export function detectPastedCode(message: string): {
    hasPastedCode: boolean;
    startIndex: number;
    endIndex: number;
    lineCount: number;
    charCount: number;
} {
    // Skip if message is inside markdown code blocks
    const withoutCodeBlocks = message.replace(/```[\s\S]*?```/g, '');
    
    // Check for code indicators
    const hasCodeIndicators = CODE_BLOCK_INDICATORS.some(pattern => pattern.test(withoutCodeBlocks));
    if (!hasCodeIndicators) {
        return { hasPastedCode: false, startIndex: 0, endIndex: 0, lineCount: 0, charCount: 0 };
    }
    
    // Find the longest sequence of code-like lines
    const lines = withoutCodeBlocks.split('\n');
    let codeStart = -1;
    let codeEnd = -1;
    let currentStart = -1;
    let longestStart = -1;
    let longestEnd = -1;
    let longestLength = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isCodeLine = /^(\s*)(import|from|def |class |async |function |const |let |var |export |package |use |#|\/\/|\/\*|\*|@|\}|\{|\[|\]|return |if |else |for |while |try |except |catch |with |raise |throw )/.test(line) ||
                          /^\s*$/.test(line) ||  // Empty lines in code
                          /^\s+\S/.test(line);    // Indented lines
        
        if (isCodeLine) {
            if (currentStart === -1) currentStart = i;
            codeEnd = i;
        } else if (currentStart !== -1) {
            // End of code block
            const length = codeEnd - currentStart + 1;
            if (length > longestLength) {
                longestStart = currentStart;
                longestEnd = codeEnd;
                longestLength = length;
            }
            currentStart = -1;
        }
    }
    
    // Check final block
    if (currentStart !== -1 && codeEnd !== -1) {
        const length = codeEnd - currentStart + 1;
        if (length > longestLength) {
            longestStart = currentStart;
            longestEnd = codeEnd;
            longestLength = length;
        }
    }
    
    if (longestLength >= PASTED_CODE_MIN_LINES) {
        // Calculate character positions
        let startChar = 0;
        for (let i = 0; i < longestStart; i++) {
            startChar += lines[i].length + 1;
        }
        let endChar = startChar;
        for (let i = longestStart; i <= longestEnd; i++) {
            endChar += lines[i].length + 1;
        }
        
        return {
            hasPastedCode: true,
            startIndex: startChar,
            endIndex: endChar,
            lineCount: longestLength,
            charCount: endChar - startChar
        };
    }
    
    return { hasPastedCode: false, startIndex: 0, endIndex: 0, lineCount: 0, charCount: 0 };
}

/**
 * Truncate pasted code in user message, keeping context around error references.
 * This prevents users from accidentally sending huge amounts of code as the prompt.
 * 
 * @param message - The user's message
 * @param maxCodeLines - Maximum lines of code to keep (default: 100)
 * @returns Truncated message and info about what was removed
 */
export function truncatePastedCode(
    message: string,
    maxCodeLines: number = 100
): { message: string; wasTruncated: boolean; originalLines: number; keptLines: number } {
    const detection = detectPastedCode(message);
    
    if (!detection.hasPastedCode || detection.lineCount <= maxCodeLines) {
        return { message, wasTruncated: false, originalLines: 0, keptLines: 0 };
    }
    
    // Extract error line references
    const errorContexts = extractErrorContext(message);
    const errorLines = errorContexts.map(c => c.lineNumber);
    
    // Get the pasted code section
    const beforeCode = message.substring(0, detection.startIndex);
    const codeSection = message.substring(detection.startIndex, detection.endIndex);
    const afterCode = message.substring(detection.endIndex);
    
    const codeLines = codeSection.split('\n');
    
    // If we have error context, keep lines around the error
    if (errorLines.length > 0) {
        const includedLines = new Set<number>();
        
        // Always include first 20 lines
        for (let i = 0; i < Math.min(20, codeLines.length); i++) {
            includedLines.add(i);
        }
        
        // Include lines around each error
        for (const errorLine of errorLines) {
            // Adjust for 0-indexing in the code section
            const adjustedLine = Math.min(errorLine - 1, codeLines.length - 1);
            const start = Math.max(0, adjustedLine - PASTED_CODE_CONTEXT_LINES);
            const end = Math.min(codeLines.length - 1, adjustedLine + PASTED_CODE_CONTEXT_LINES);
            for (let i = start; i <= end; i++) {
                includedLines.add(i);
            }
        }
        
        // Build truncated code
        const sortedLines = Array.from(includedLines).sort((a, b) => a - b);
        const truncatedParts: string[] = [];
        let lastLine = -1;
        
        for (const lineNum of sortedLines) {
            if (lineNum > lastLine + 1 && lastLine >= 0) {
                const gapSize = lineNum - lastLine - 1;
                truncatedParts.push(`\n... (${gapSize} lines omitted) ...\n`);
            }
            truncatedParts.push(codeLines[lineNum]);
            lastLine = lineNum;
        }
        
        const keptLines = includedLines.size;
        const truncatedCode = truncatedParts.join('\n');
        const truncationNote = `\n[Code truncated: showing ${keptLines}/${detection.lineCount} lines around error context]\n`;
        
        return {
            message: beforeCode + truncatedCode + truncationNote + afterCode,
            wasTruncated: true,
            originalLines: detection.lineCount,
            keptLines
        };
    } else {
        // No error context - just keep first and last sections
        const keepLines = Math.floor(maxCodeLines / 2);
        const firstPart = codeLines.slice(0, keepLines).join('\n');
        const lastPart = codeLines.slice(-keepLines).join('\n');
        const omitted = detection.lineCount - (keepLines * 2);
        
        const truncatedCode = firstPart + `\n\n... (${omitted} lines omitted) ...\n\n` + lastPart;
        const truncationNote = `\n[Code truncated: showing ${keepLines * 2}/${detection.lineCount} lines]\n`;
        
        return {
            message: beforeCode + truncatedCode + truncationNote + afterCode,
            wasTruncated: true,
            originalLines: detection.lineCount,
            keptLines: keepLines * 2
        };
    }
}

// ============================================================================
// Relevance Filtering - Filter out unrelated files based on error context
// ============================================================================

/**
 * Language groups for relevance filtering.
 * Files in the same group are considered related.
 */
const LANGUAGE_GROUPS: Record<string, string[]> = {
    'python': ['py', 'pyi', 'pyx', 'pxd', 'pyw'],
    'javascript': ['js', 'jsx', 'mjs', 'cjs'],
    'typescript': ['ts', 'tsx', 'mts', 'cts'],
    'web-frontend': ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'sass', 'less', 'vue', 'svelte'],
    'web-backend': ['py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'cs'],
    'config': ['json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'],
    'docs': ['md', 'txt', 'rst', 'adoc'],
    'styles': ['css', 'scss', 'sass', 'less', 'styl'],
};

/**
 * Get the primary language from error context in user message.
 * Returns the detected language or null if unclear.
 */
export function detectPrimaryLanguage(userMessage: string): string | null {
    const lowerMsg = userMessage.toLowerCase();
    
    // Python indicators
    if (lowerMsg.includes('python') || 
        lowerMsg.includes('.py') || 
        lowerMsg.includes('traceback') ||
        lowerMsg.includes('syntaxerror') ||
        lowerMsg.includes('indentationerror') ||
        /file\s+["'][^"']+\.py/.test(lowerMsg)) {
        return 'python';
    }
    
    // JavaScript/TypeScript indicators
    if (lowerMsg.includes('javascript') || 
        lowerMsg.includes('typescript') ||
        lowerMsg.includes('.js') ||
        lowerMsg.includes('.ts') ||
        lowerMsg.includes('node_modules') ||
        lowerMsg.includes('typeerror:') ||
        lowerMsg.includes('referenceerror:')) {
        return 'javascript';
    }
    
    // Go indicators
    if (lowerMsg.includes('golang') || 
        lowerMsg.includes('.go') ||
        lowerMsg.includes('go run') ||
        lowerMsg.includes('package main')) {
        return 'go';
    }
    
    // Rust indicators
    if (lowerMsg.includes('rust') || 
        lowerMsg.includes('.rs') ||
        lowerMsg.includes('cargo')) {
        return 'rust';
    }
    
    return null;
}

/**
 * Check if a file extension is relevant to the detected language.
 */
function isExtensionRelevant(ext: string, primaryLang: string): boolean {
    ext = ext.toLowerCase();
    
    // Config files are always relevant
    if (LANGUAGE_GROUPS['config'].includes(ext)) {
        return true;
    }
    
    // Docs are usually relevant
    if (LANGUAGE_GROUPS['docs'].includes(ext)) {
        return true;
    }
    
    // Check language-specific relevance
    switch (primaryLang) {
        case 'python':
            // Python errors: exclude frontend assets
            return LANGUAGE_GROUPS['python'].includes(ext) ||
                   LANGUAGE_GROUPS['config'].includes(ext) ||
                   ext === 'html' || ext === 'sql'; // Templates and DB
        case 'javascript':
        case 'typescript':
            // JS/TS: include web-frontend
            return LANGUAGE_GROUPS['web-frontend'].includes(ext) ||
                   LANGUAGE_GROUPS['javascript'].includes(ext) ||
                   LANGUAGE_GROUPS['typescript'].includes(ext);
        case 'go':
            return ext === 'go' || LANGUAGE_GROUPS['config'].includes(ext);
        case 'rust':
            return ext === 'rs' || ext === 'toml' || LANGUAGE_GROUPS['config'].includes(ext);
        default:
            return true; // Unknown language, include everything
    }
}

/**
 * Filter files to only include those relevant to the detected error context.
 * This prevents loading CSS/JS when debugging Python errors, etc.
 * 
 * @param files - Array of files found by pattern matching
 * @param userMessage - The user's message (to detect error context)
 * @param maxIrrelevantBytes - Max bytes of irrelevant files to include anyway (default: 10KB)
 * @returns Filtered files with irrelevant large files removed
 */
export function filterByRelevance(
    files: FileContent[],
    userMessage: string,
    maxIrrelevantBytes: number = 10 * 1024
): { files: FileContent[]; filtered: string[]; reason: string } {
    const primaryLang = detectPrimaryLanguage(userMessage);
    
    if (!primaryLang) {
        return { files, filtered: [], reason: 'No primary language detected' };
    }
    
    const relevant: FileContent[] = [];
    const filtered: string[] = [];
    
    for (const file of files) {
        const ext = file.path.split('.').pop() || '';
        const isRelevant = isExtensionRelevant(ext, primaryLang);
        const sizeBytes = file.content.length;
        
        if (isRelevant) {
            relevant.push(file);
        } else if (sizeBytes <= maxIrrelevantBytes) {
            // Include small irrelevant files anyway (might be useful)
            relevant.push(file);
            debug(`Including small irrelevant file: ${file.name} (${sizeBytes} bytes)`);
        } else {
            // Filter out large irrelevant files
            filtered.push(`${file.name} (${(sizeBytes / 1024).toFixed(1)}KB, ${ext})`);
            info(`Filtered irrelevant file: ${file.name} (${(sizeBytes / 1024).toFixed(1)}KB ${ext} not relevant to ${primaryLang})`);
        }
    }
    
    return {
        files: relevant,
        filtered,
        reason: `Primary language: ${primaryLang}`
    };
}

// ============================================================================
// Smart Error Context Extraction
// ============================================================================

/**
 * Patterns to detect error line references in user messages.
 * Captures the line number and optionally the filename.
 */
const ERROR_LINE_PATTERNS = [
    // Python: "line 126", "File "app.py", line 126"
    /File\s+["']?([^"'\s,]+)["']?,?\s+line\s+(\d+)/gi,
    /line\s+(\d+)/gi,
    // JavaScript/TypeScript: "at line 45", "error on line 45"
    /(?:at|on|error.*?)\s+line\s+(\d+)/gi,
    // Generic: ":126:", "app.py:126"
    /([a-zA-Z_][\w.-]*\.[a-zA-Z]+):(\d+)/g,
    // Compiler style: "(45,12)" or "[45:12]"
    /[(\[](\d+)[,:]?\d*[)\]]/g,
];

export interface ErrorContext {
    filename?: string;
    lineNumber: number;
}

/**
 * Extract error line references from user message.
 */
export function extractErrorContext(userMessage: string): ErrorContext[] {
    const contexts: ErrorContext[] = [];
    const seenLines = new Set<number>();
    
    for (const pattern of ERROR_LINE_PATTERNS) {
        // Reset lastIndex for global patterns
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(userMessage)) !== null) {
            let filename: string | undefined;
            let lineNum: number;
            
            // Handle different capture group arrangements
            if (match.length === 3) {
                // Pattern with filename and line: [full, filename, line]
                filename = match[1];
                lineNum = parseInt(match[2], 10);
            } else if (match.length === 2) {
                // Pattern with just line: [full, line]
                lineNum = parseInt(match[1], 10);
            } else {
                continue;
            }
            
            if (!isNaN(lineNum) && lineNum > 0 && !seenLines.has(lineNum)) {
                seenLines.add(lineNum);
                contexts.push({ filename, lineNumber: lineNum });
            }
        }
    }
    
    return contexts;
}

/**
 * Truncate file content to show only lines around error context.
 * Returns the truncated content with line numbers and a note about truncation.
 * 
 * @param file - The file content object
 * @param errorLines - Array of line numbers to focus on
 * @param contextLines - Number of lines before/after each error line (default: 50)
 * @returns Truncated content with line numbers, or original if small enough
 */
export function truncateToErrorContext(
    file: FileContent, 
    errorLines: number[], 
    contextLines: number = 50
): { content: string; wasTruncated: boolean; originalLines: number } {
    const lines = file.content.split('\n');
    const originalLines = lines.length;
    
    // Don't truncate small files (< 200 lines)
    if (lines.length < 200 || errorLines.length === 0) {
        return { 
            content: addLineNumbers(file.content), 
            wasTruncated: false, 
            originalLines 
        };
    }
    
    // Build set of lines to include
    const includedLines = new Set<number>();
    
    for (const errorLine of errorLines) {
        const start = Math.max(1, errorLine - contextLines);
        const end = Math.min(lines.length, errorLine + contextLines);
        for (let i = start; i <= end; i++) {
            includedLines.add(i);
        }
    }
    
    // Always include first 20 lines (imports, setup)
    for (let i = 1; i <= Math.min(20, lines.length); i++) {
        includedLines.add(i);
    }
    
    // Build output with line numbers, showing gaps
    const sortedLines = Array.from(includedLines).sort((a, b) => a - b);
    const outputParts: string[] = [];
    const padding = String(lines.length).length;
    let lastLine = 0;
    
    for (const lineNum of sortedLines) {
        if (lineNum > lastLine + 1 && lastLine > 0) {
            // Show gap indicator
            const gapSize = lineNum - lastLine - 1;
            outputParts.push(`${''.padStart(padding, ' ')}  ... (${gapSize} lines omitted) ...`);
        }
        const lineIdx = lineNum - 1;
        if (lineIdx >= 0 && lineIdx < lines.length) {
            const lineNumStr = String(lineNum).padStart(padding, ' ');
            outputParts.push(`${lineNumStr}: ${lines[lineIdx]}`);
        }
        lastLine = lineNum;
    }
    
    // Add note about truncation
    const includedCount = includedLines.size;
    const truncationNote = `\n${''.padStart(padding, ' ')}  [Truncated: showing ${includedCount}/${originalLines} lines around error context]`;
    
    return {
        content: outputParts.join('\n') + truncationNote,
        wasTruncated: true,
        originalLines
    };
}

/**
 * Apply smart truncation to files based on error context in user message.
 * This significantly reduces token usage when debugging specific errors.
 * 
 * @param files - Array of files to potentially truncate
 * @param userMessage - The user's message (to extract error line references)
 * @param contextLines - Lines of context around each error (default: 50)
 * @returns Files with content potentially truncated to error context
 */
export function applyErrorContextTruncation(
    files: FileContent[],
    userMessage: string,
    contextLines: number = 50
): FileContent[] {
    const errorContexts = extractErrorContext(userMessage);
    
    if (errorContexts.length === 0) {
        return files; // No error context found, return original
    }
    
    debug(`Found ${errorContexts.length} error context(s) in user message:`, 
        errorContexts.map(c => `line ${c.lineNumber}${c.filename ? ` in ${c.filename}` : ''}`).join(', '));
    
    return files.map(file => {
        // Find error contexts that apply to this file
        const relevantContexts = errorContexts.filter(ctx => {
            if (!ctx.filename) return true; // No filename = applies to all
            const fileName = path.basename(file.path).toLowerCase();
            const ctxFileName = ctx.filename.toLowerCase();
            return fileName === ctxFileName || fileName.includes(ctxFileName) || ctxFileName.includes(fileName);
        });
        
        if (relevantContexts.length === 0) {
            return file; // No relevant error context
        }
        
        const errorLines = relevantContexts.map(ctx => ctx.lineNumber);
        const { content, wasTruncated, originalLines } = truncateToErrorContext(file, errorLines, contextLines);
        
        if (wasTruncated) {
            info(`Truncated ${file.name}: ${originalLines} -> ~${content.split('\n').length} lines (error context: lines ${errorLines.join(', ')})`);
            return {
                ...file,
                content: content // Note: content is already line-numbered
            };
        }
        
        return file;
    });
}
