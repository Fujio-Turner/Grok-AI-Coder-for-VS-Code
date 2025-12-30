/**
 * Smart File Reader - Intelligent strategies for reading large files.
 * 
 * For files > 50KB, this module provides strategies to efficiently
 * send relevant content to the AI API without exceeding token limits:
 * 
 * 1. **Targeted Search** - Use grep/search patterns to find relevant sections
 * 2. **Structured Exploration** - Read imports, class definitions, exports first
 * 3. **Chunked Reading** - Read files in ~500 line segments with overlap
 * 4. **Smart Summarization** - For very large files, provide structure + samples
 * 
 * NOTE: Avoids vscode dependencies where possible for testability.
 */

import * as path from 'path';
import * as crypto from 'crypto';

// Size thresholds
const LARGE_FILE_THRESHOLD = 50 * 1024;  // 50KB
const HUGE_FILE_THRESHOLD = 200 * 1024;  // 200KB - use summary mode
const DEFAULT_CHUNK_LINES = 500;         // Lines per chunk
const OVERLAP_LINES = 50;                // Overlap between chunks
const MAX_SEARCH_RESULTS = 20;           // Max grep results to include

// Conditional logging
const isTestEnv = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const debug = isTestEnv ? () => {} : (msg: string, ...args: any[]) => console.log(`[SmartFileReader] ${msg}`, ...args);
const info = isTestEnv ? () => {} : (msg: string, ...args: any[]) => console.log(`[SmartFileReader] ${msg}`, ...args);

export interface FileInfo {
    path: string;
    relativePath: string;
    content: string;
    language: string;
    lineCount: number;
    sizeBytes: number;
    md5Hash: string;
}

export interface ReadRange {
    startLine: number;  // 1-indexed
    endLine: number;    // 1-indexed, inclusive
}

export interface SmartReadResult {
    /** The file being read */
    file: FileInfo;
    /** Strategy used to read the file */
    strategy: 'full' | 'chunked' | 'targeted' | 'structured' | 'summarized';
    /** Formatted content ready for API prompt */
    formattedContent: string;
    /** Sections that were read */
    sections: ReadSection[];
    /** Total tokens estimated */
    estimatedTokens: number;
    /** Reason for strategy selection */
    reason: string;
    /** If chunked, total chunks available */
    totalChunks?: number;
    /** If chunked, current chunk index (0-based) */
    currentChunk?: number;
    /** If there are more chunks to read */
    hasMoreChunks?: boolean;
}

export interface ReadSection {
    type: 'header' | 'imports' | 'exports' | 'class' | 'function' | 'search-match' | 'chunk' | 'summary';
    startLine: number;
    endLine: number;
    content: string;
    label?: string;
}

export interface SmartReadOptions {
    /** Search pattern to find relevant sections (regex) */
    searchPattern?: string;
    /** Specific line ranges to read */
    ranges?: ReadRange[];
    /** Force chunked reading at specific chunk index */
    chunkIndex?: number;
    /** Custom lines per chunk (default: 500) */
    linesPerChunk?: number;
    /** Force a specific strategy */
    forceStrategy?: 'full' | 'chunked' | 'targeted' | 'structured' | 'summarized';
    /** Include imports section (for structured) */
    includeImports?: boolean;
    /** Include exports section (for structured) */
    includeExports?: boolean;
    /** Maximum content size to return (in bytes) */
    maxOutputSize?: number;
}

/**
 * Language-specific patterns for structured exploration
 */
const STRUCTURE_PATTERNS: Record<string, {
    imports: RegExp[];
    exports: RegExp[];
    classStart: RegExp;
    functionStart: RegExp;
}> = {
    typescript: {
        imports: [/^import\s+/, /^const\s+\w+\s*=\s*require\(/],
        exports: [/^export\s+(?:default\s+)?(?:class|function|const|interface|type|enum)\s+\w+/, /^export\s*\{/],
        classStart: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
        functionStart: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
    },
    javascript: {
        imports: [/^import\s+/, /^const\s+\w+\s*=\s*require\(/],
        exports: [/^module\.exports\s*=/, /^export\s+/],
        classStart: /^(?:export\s+)?class\s+(\w+)/,
        functionStart: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
    },
    python: {
        imports: [/^import\s+/, /^from\s+\w+\s+import\s+/],
        exports: [], // Python doesn't have explicit exports
        classStart: /^class\s+(\w+)/,
        functionStart: /^(?:async\s+)?def\s+(\w+)/
    },
    go: {
        imports: [/^import\s+\(/, /^import\s+"/],
        exports: [], // Go uses capitalization
        classStart: /^type\s+(\w+)\s+struct\s*\{/,
        functionStart: /^func\s+(?:\([^)]+\)\s+)?(\w+)/
    },
    rust: {
        imports: [/^use\s+/, /^extern\s+crate\s+/],
        exports: [/^pub\s+(?:struct|enum|fn|trait|mod|type)\s+/],
        classStart: /^(?:pub\s+)?(?:struct|enum)\s+(\w+)/,
        functionStart: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/
    }
};

/**
 * Normalize language ID for pattern lookup
 */
function normalizeLanguage(lang: string): string {
    const langMap: Record<string, string> = {
        'ts': 'typescript',
        'tsx': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'py': 'python',
        'rs': 'rust'
    };
    return langMap[lang.toLowerCase()] || lang.toLowerCase();
}

/**
 * Add line numbers to content (1-indexed)
 */
function addLineNumbers(content: string, startLine: number = 1): string {
    const lines = content.split('\n');
    const endLine = startLine + lines.length - 1;
    const padding = String(endLine).length;
    
    return lines.map((line, i) => {
        const lineNum = String(startLine + i).padStart(padding, ' ');
        return `${lineNum}: ${line}`;
    }).join('\n');
}

/**
 * Compute MD5 hash
 */
function computeMd5(content: string): string {
    return crypto.createHash('md5').update(content, 'utf8').digest('hex');
}

/**
 * Estimate token count (~4 chars per token)
 */
function estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
}

/**
 * Determine the file size category
 */
export function getFileSizeCategory(sizeBytes: number): 'small' | 'large' | 'huge' {
    if (sizeBytes > HUGE_FILE_THRESHOLD) return 'huge';
    if (sizeBytes > LARGE_FILE_THRESHOLD) return 'large';
    return 'small';
}

/**
 * Calculate total chunks for a file
 */
export function calculateTotalChunks(lineCount: number, linesPerChunk: number = DEFAULT_CHUNK_LINES): number {
    if (linesPerChunk >= lineCount) return 1;
    return Math.ceil(lineCount / (linesPerChunk - OVERLAP_LINES));
}

/**
 * Find import section in file content
 */
function findImportSection(lines: string[], language: string): ReadSection | null {
    const patterns = STRUCTURE_PATTERNS[normalizeLanguage(language)]?.imports;
    if (!patterns || patterns.length === 0) return null;

    let startLine = -1;
    let endLine = -1;

    for (let i = 0; i < Math.min(lines.length, 100); i++) {
        const line = lines[i].trim();
        const isImport = patterns.some(p => p.test(line));
        
        if (isImport) {
            if (startLine === -1) startLine = i;
            endLine = i;
        } else if (startLine !== -1 && line !== '' && !line.startsWith('//') && !line.startsWith('#')) {
            // Non-import, non-empty line after imports - stop
            break;
        }
    }

    if (startLine === -1) return null;

    return {
        type: 'imports',
        startLine: startLine + 1,
        endLine: endLine + 1,
        content: lines.slice(startLine, endLine + 1).join('\n'),
        label: 'Imports'
    };
}

/**
 * Find export section in file content
 */
function findExportSection(lines: string[], language: string): ReadSection | null {
    const patterns = STRUCTURE_PATTERNS[normalizeLanguage(language)]?.exports;
    if (!patterns || patterns.length === 0) return null;

    const exportLines: number[] = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (patterns.some(p => p.test(line))) {
            exportLines.push(i);
        }
    }

    if (exportLines.length === 0) return null;

    // Get last 10 export lines as sample
    const lastExports = exportLines.slice(-10);
    const startLine = lastExports[0];
    const endLine = lastExports[lastExports.length - 1];

    return {
        type: 'exports',
        startLine: startLine + 1,
        endLine: endLine + 1,
        content: lastExports.map(i => lines[i]).join('\n'),
        label: `Exports (${exportLines.length} total)`
    };
}

/**
 * Find class/function definitions (just signatures, not bodies)
 */
function findStructureDefinitions(lines: string[], language: string): ReadSection[] {
    const lang = normalizeLanguage(language);
    const patterns = STRUCTURE_PATTERNS[lang];
    if (!patterns) return [];

    const sections: ReadSection[] = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        // Check for class definition
        const classMatch = patterns.classStart.exec(trimmed);
        if (classMatch) {
            sections.push({
                type: 'class',
                startLine: i + 1,
                endLine: i + 1,
                content: line,
                label: `class ${classMatch[1]}`
            });
            continue;
        }
        
        // Check for function definition (top-level only - not indented much)
        const indent = line.length - line.trimStart().length;
        if (indent < 4) { // Top-level or method
            const funcMatch = patterns.functionStart.exec(trimmed);
            if (funcMatch) {
                sections.push({
                    type: 'function',
                    startLine: i + 1,
                    endLine: i + 1,
                    content: line,
                    label: `function ${funcMatch[1]}`
                });
            }
        }
    }

    return sections;
}

/**
 * Search for pattern matches in file
 */
function searchInFile(lines: string[], pattern: string): ReadSection[] {
    const sections: ReadSection[] = [];
    const regex = new RegExp(pattern, 'gi');
    
    for (let i = 0; i < lines.length && sections.length < MAX_SEARCH_RESULTS; i++) {
        if (regex.test(lines[i])) {
            // Include context: 3 lines before and after
            const contextStart = Math.max(0, i - 3);
            const contextEnd = Math.min(lines.length - 1, i + 3);
            
            sections.push({
                type: 'search-match',
                startLine: contextStart + 1,
                endLine: contextEnd + 1,
                content: lines.slice(contextStart, contextEnd + 1).join('\n'),
                label: `Match at line ${i + 1}`
            });
            
            // Skip ahead to avoid overlapping matches
            i = contextEnd;
        }
    }

    return sections;
}

/**
 * Get a specific chunk from the file
 */
function getChunk(
    lines: string[], 
    chunkIndex: number, 
    linesPerChunk: number = DEFAULT_CHUNK_LINES
): { section: ReadSection; totalChunks: number; hasMore: boolean } {
    const totalChunks = calculateTotalChunks(lines.length, linesPerChunk);
    const effectiveChunkSize = linesPerChunk - OVERLAP_LINES;
    
    const startIdx = chunkIndex * effectiveChunkSize;
    const endIdx = Math.min(startIdx + linesPerChunk, lines.length);
    
    return {
        section: {
            type: 'chunk',
            startLine: startIdx + 1,
            endLine: endIdx,
            content: lines.slice(startIdx, endIdx).join('\n'),
            label: `Chunk ${chunkIndex + 1}/${totalChunks}`
        },
        totalChunks,
        hasMore: chunkIndex < totalChunks - 1
    };
}

/**
 * Create a file structure summary for huge files
 */
function createFileSummary(fileInfo: FileInfo, lines: string[]): ReadSection {
    const lang = normalizeLanguage(fileInfo.language);
    const patterns = STRUCTURE_PATTERNS[lang];
    
    let summary = `# File Summary: ${fileInfo.relativePath}\n`;
    summary += `- Size: ${(fileInfo.sizeBytes / 1024).toFixed(1)}KB\n`;
    summary += `- Lines: ${fileInfo.lineCount}\n`;
    summary += `- Language: ${fileInfo.language}\n`;
    summary += `- MD5: ${fileInfo.md5Hash}\n\n`;

    // Count structure elements
    let classCount = 0;
    let functionCount = 0;
    const classNames: string[] = [];
    const functionNames: string[] = [];

    if (patterns) {
        for (const line of lines) {
            const trimmed = line.trim();
            const classMatch = patterns.classStart.exec(trimmed);
            if (classMatch) {
                classCount++;
                if (classNames.length < 10) classNames.push(classMatch[1]);
            }
            const funcMatch = patterns.functionStart.exec(trimmed);
            if (funcMatch) {
                functionCount++;
                if (functionNames.length < 20) functionNames.push(funcMatch[1]);
            }
        }
    }

    summary += `## Structure\n`;
    summary += `- Classes: ${classCount}${classNames.length > 0 ? ` (${classNames.join(', ')}${classCount > 10 ? '...' : ''})` : ''}\n`;
    summary += `- Functions: ${functionCount}${functionNames.length > 0 ? ` (${functionNames.slice(0, 10).join(', ')}${functionCount > 10 ? '...' : ''})` : ''}\n\n`;
    
    summary += `## To explore this file:\n`;
    summary += `- Use \`searchPattern\` option to find specific code\n`;
    summary += `- Use \`chunkIndex\` option to read in 500-line segments\n`;
    summary += `- Use \`ranges\` option to read specific line ranges\n`;

    return {
        type: 'summary',
        startLine: 1,
        endLine: fileInfo.lineCount,
        content: summary,
        label: 'File Summary'
    };
}

/**
 * Format sections into a prompt-ready string
 */
function formatSectionsForPrompt(
    fileInfo: FileInfo, 
    sections: ReadSection[], 
    strategy: string
): string {
    let output = `### 📄 ${fileInfo.relativePath}\n`;
    output += `**Size:** ${(fileInfo.sizeBytes / 1024).toFixed(1)}KB | **Lines:** ${fileInfo.lineCount} | **MD5:** ${fileInfo.md5Hash}\n`;
    output += `**Reading Strategy:** ${strategy}\n\n`;

    for (const section of sections) {
        if (section.type === 'summary') {
            output += section.content + '\n\n';
        } else {
            output += `#### ${section.label || section.type} (lines ${section.startLine}-${section.endLine})\n`;
            output += '```' + fileInfo.language + '\n';
            output += addLineNumbers(section.content, section.startLine);
            output += '\n```\n\n';
        }
    }

    return output;
}

/**
 * Smart read a file with automatic strategy selection
 */
export function smartReadFile(fileInfo: FileInfo, options: SmartReadOptions = {}): SmartReadResult {
    const lines = fileInfo.content.split('\n');
    const sizeCategory = getFileSizeCategory(fileInfo.sizeBytes);
    const linesPerChunk = options.linesPerChunk || DEFAULT_CHUNK_LINES;
    
    // Determine strategy
    let strategy: SmartReadResult['strategy'];
    let reason: string;
    let sections: ReadSection[] = [];

    // Force specific strategy if requested
    if (options.forceStrategy) {
        strategy = options.forceStrategy;
        reason = `Forced strategy: ${strategy}`;
    }
    // If search pattern provided, use targeted strategy
    else if (options.searchPattern) {
        strategy = 'targeted';
        reason = `Search pattern provided: ${options.searchPattern}`;
    }
    // If specific ranges requested
    else if (options.ranges && options.ranges.length > 0) {
        strategy = 'targeted';
        reason = `Specific line ranges requested`;
    }
    // If chunk index specified
    else if (options.chunkIndex !== undefined) {
        strategy = 'chunked';
        reason = `Reading chunk ${options.chunkIndex + 1}`;
    }
    // Automatic selection based on size
    else if (sizeCategory === 'small') {
        strategy = 'full';
        reason = `File under ${LARGE_FILE_THRESHOLD / 1024}KB - reading full content`;
    }
    else if (sizeCategory === 'huge') {
        strategy = 'summarized';
        reason = `File over ${HUGE_FILE_THRESHOLD / 1024}KB - providing summary + structure`;
    }
    else {
        strategy = 'structured';
        reason = `Large file (${(fileInfo.sizeBytes / 1024).toFixed(1)}KB) - reading imports, structure, and first chunk`;
    }

    // Execute strategy
    let totalChunks: number | undefined;
    let currentChunk: number | undefined;
    let hasMoreChunks: boolean | undefined;

    switch (strategy) {
        case 'full':
            sections.push({
                type: 'chunk',
                startLine: 1,
                endLine: fileInfo.lineCount,
                content: fileInfo.content,
                label: 'Full file'
            });
            break;

        case 'chunked':
            const chunkIdx = options.chunkIndex || 0;
            const chunkResult = getChunk(lines, chunkIdx, linesPerChunk);
            sections.push(chunkResult.section);
            totalChunks = chunkResult.totalChunks;
            currentChunk = chunkIdx;
            hasMoreChunks = chunkResult.hasMore;
            break;

        case 'targeted':
            // Search matches
            if (options.searchPattern) {
                const matches = searchInFile(lines, options.searchPattern);
                sections.push(...matches);
                if (matches.length === 0) {
                    reason += ' (no matches found)';
                }
            }
            // Specific ranges
            if (options.ranges) {
                for (const range of options.ranges) {
                    const startIdx = range.startLine - 1;
                    const endIdx = Math.min(range.endLine, fileInfo.lineCount);
                    sections.push({
                        type: 'chunk',
                        startLine: range.startLine,
                        endLine: endIdx,
                        content: lines.slice(startIdx, endIdx).join('\n'),
                        label: `Lines ${range.startLine}-${endIdx}`
                    });
                }
            }
            break;

        case 'structured':
            // Get imports
            const imports = findImportSection(lines, fileInfo.language);
            if (imports) sections.push(imports);

            // Get structure definitions
            const definitions = findStructureDefinitions(lines, fileInfo.language);
            if (definitions.length > 0) {
                // Group definitions into a summary section
                sections.push({
                    type: 'header',
                    startLine: 1,
                    endLine: fileInfo.lineCount,
                    content: `# File Structure\n${definitions.map(d => `- ${d.label} (line ${d.startLine})`).join('\n')}`,
                    label: `Structure Overview (${definitions.length} definitions)`
                });
            }

            // Get exports
            const exports = findExportSection(lines, fileInfo.language);
            if (exports) sections.push(exports);

            // Add first chunk for context
            const firstChunk = getChunk(lines, 0, linesPerChunk);
            sections.push({
                ...firstChunk.section,
                label: `First ${linesPerChunk} lines (chunk 1/${firstChunk.totalChunks})`
            });
            totalChunks = firstChunk.totalChunks;
            currentChunk = 0;
            hasMoreChunks = firstChunk.hasMore;
            break;

        case 'summarized':
            // Summary for huge files
            sections.push(createFileSummary(fileInfo, lines));
            
            // Also include imports if available
            const hugeImports = findImportSection(lines, fileInfo.language);
            if (hugeImports) sections.push(hugeImports);

            // And structure definitions
            const hugeDefs = findStructureDefinitions(lines, fileInfo.language);
            if (hugeDefs.length > 0) {
                sections.push({
                    type: 'header',
                    startLine: 1,
                    endLine: fileInfo.lineCount,
                    content: hugeDefs.slice(0, 30).map(d => `${d.startLine}: ${d.content.trim()}`).join('\n'),
                    label: `Top ${Math.min(30, hugeDefs.length)} definitions`
                });
            }

            totalChunks = calculateTotalChunks(lines.length, linesPerChunk);
            currentChunk = undefined; // Not reading any chunk yet
            hasMoreChunks = true;
            break;
    }

    // Format output
    const formattedContent = formatSectionsForPrompt(fileInfo, sections, strategy);
    
    // Apply max output size if specified
    let finalContent = formattedContent;
    if (options.maxOutputSize && formattedContent.length > options.maxOutputSize) {
        finalContent = formattedContent.slice(0, options.maxOutputSize) + '\n\n... (truncated, use chunked reading for more)';
    }

    return {
        file: fileInfo,
        strategy,
        formattedContent: finalContent,
        sections,
        estimatedTokens: estimateTokens(finalContent),
        reason,
        totalChunks,
        currentChunk,
        hasMoreChunks
    };
}

/**
 * Read the next chunk of a file
 */
export function readNextChunk(
    fileInfo: FileInfo, 
    currentChunk: number, 
    linesPerChunk: number = DEFAULT_CHUNK_LINES
): SmartReadResult {
    return smartReadFile(fileInfo, {
        chunkIndex: currentChunk + 1,
        linesPerChunk
    });
}

/**
 * Search and read relevant sections of a file
 */
export function searchAndRead(fileInfo: FileInfo, searchPattern: string): SmartReadResult {
    return smartReadFile(fileInfo, { searchPattern });
}

/**
 * Read specific line ranges from a file
 */
export function readRanges(fileInfo: FileInfo, ranges: ReadRange[]): SmartReadResult {
    return smartReadFile(fileInfo, { ranges });
}

/**
 * Create a FileInfo object from content
 */
export function createFileInfo(
    filePath: string,
    content: string,
    language?: string
): FileInfo {
    const ext = path.extname(filePath).slice(1) || 'text';
    return {
        path: filePath,
        relativePath: filePath,
        content,
        language: language || ext,
        lineCount: content.split('\n').length,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        md5Hash: computeMd5(content)
    };
}

/**
 * Check if smart reading should be used for a file
 */
export function shouldUseSmartReading(sizeBytes: number): boolean {
    return sizeBytes > LARGE_FILE_THRESHOLD;
}

/**
 * Result from parallel smart file reading
 */
export interface ParallelReadResult {
    results: SmartReadResult[];
    totalTokens: number;
    formattedContent: string;
    readTimeMs: number;
}

/**
 * Read multiple files in parallel with smart reading.
 * Returns combined formatted content ready for API.
 */
export async function smartReadFilesParallel(
    files: Array<{ path: string; content: string; language: string }>,
    options: SmartReadOptions = {}
): Promise<ParallelReadResult> {
    const startTime = Date.now();
    
    if (files.length === 0) {
        return {
            results: [],
            totalTokens: 0,
            formattedContent: '',
            readTimeMs: 0
        };
    }

    // Process all files in parallel
    const readPromises = files.map(async (file) => {
        const fileInfo = createFileInfo(file.path, file.content, file.language);
        return smartReadFile(fileInfo, options);
    });

    const results = await Promise.all(readPromises);
    
    // Combine results
    const totalTokens = results.reduce((sum, r) => sum + r.estimatedTokens, 0);
    const formattedContent = results.map(r => r.formattedContent).join('\n\n');
    
    return {
        results,
        totalTokens,
        formattedContent,
        readTimeMs: Date.now() - startTime
    };
}

/**
 * Get reading recommendation for a file
 */
export function getReadingRecommendation(sizeBytes: number, lineCount: number): string {
    const category = getFileSizeCategory(sizeBytes);
    const chunks = calculateTotalChunks(lineCount);
    
    switch (category) {
        case 'small':
            return 'File is small enough to read in full.';
        case 'large':
            return `File is large (${(sizeBytes / 1024).toFixed(1)}KB). ` +
                   `Will read structure + first chunk. ${chunks} total chunks available.`;
        case 'huge':
            return `File is very large (${(sizeBytes / 1024).toFixed(1)}KB). ` +
                   `Will provide summary + structure. Use search or chunks to explore. ` +
                   `${chunks} chunks available.`;
    }
}
