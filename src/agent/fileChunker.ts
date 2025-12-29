/**
 * File Chunker - Intelligently splits large files for API processing.
 * 
 * When files exceed token limits, this module splits them into logical chunks
 * that can be processed independently and have their results merged.
 * 
 * Chunking strategies:
 * 1. Function/class boundaries (preferred for code)
 * 2. Section markers (for config files, markdown)
 * 3. Line-based fallback (last resort)
 * 
 * NOTE: This module avoids vscode dependencies for unit testing.
 */

/** Minimal file content interface for chunking (compatible with workspaceFiles.FileContent) */
export interface ChunkableFileContent {
    path: string;
    relativePath: string;
    name: string;
    content: string;
    language: string;
    lineCount: number;
    md5Hash: string;
}

// Conditional logging - use console in test environment
const isTestEnv = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
const debug = isTestEnv ? () => {} : (msg: string, ...args: any[]) => console.log(`[DEBUG] ${msg}`, ...args);
const info = isTestEnv ? () => {} : (msg: string, ...args: any[]) => console.log(`[INFO] ${msg}`, ...args);

// ~4 chars per token is a reasonable estimate
const CHARS_PER_TOKEN = 4;

// Default chunk size: 30KB (~7500 tokens) - leaves room for system prompt + response
const DEFAULT_CHUNK_SIZE = 30 * 1024;

// Maximum file size before chunking is required: 50KB
const CHUNK_THRESHOLD = 50 * 1024;

// Overlap between chunks to maintain context (in lines)
const CHUNK_OVERLAP_LINES = 20;

export interface FileChunk {
    /** Original file this chunk belongs to */
    originalPath: string;
    /** Chunk index (0-based) */
    chunkIndex: number;
    /** Total number of chunks for this file */
    totalChunks: number;
    /** Starting line number (1-indexed) */
    startLine: number;
    /** Ending line number (1-indexed, inclusive) */
    endLine: number;
    /** The chunk content (with line numbers) */
    content: string;
    /** Raw content without line numbers */
    rawContent: string;
    /** Language of the file */
    language: string;
    /** MD5 of original full file */
    originalMd5: string;
    /** Size in bytes of this chunk */
    sizeBytes: number;
    /** Approximate token count */
    estimatedTokens: number;
}

export interface ChunkingResult {
    /** File was chunked */
    wasChunked: boolean;
    /** Original file info */
    originalFile: ChunkableFileContent;
    /** Array of chunks (length 1 if not chunked) */
    chunks: FileChunk[];
    /** Reason for chunking decision */
    reason: string;
}

export interface ChunkingOptions {
    /** Maximum chunk size in bytes (default: 30KB) */
    maxChunkSize?: number;
    /** Threshold above which chunking is required (default: 50KB) */
    chunkThreshold?: number;
    /** Number of overlap lines between chunks (default: 20) */
    overlapLines?: number;
    /** Prefer splitting at function/class boundaries */
    preferLogicalBoundaries?: boolean;
}

/**
 * Patterns that indicate logical boundaries in code files.
 * These are preferable split points.
 */
const BOUNDARY_PATTERNS: { [lang: string]: RegExp[] } = {
    python: [
        /^class\s+\w+/,           // Class definition
        /^def\s+\w+/,             // Function definition
        /^async\s+def\s+\w+/,     // Async function
        /^@\w+/,                  // Decorator (split before)
    ],
    javascript: [
        /^(export\s+)?(async\s+)?function\s+\w+/,  // Function
        /^(export\s+)?class\s+\w+/,                // Class
        /^(export\s+)?const\s+\w+\s*=/,            // Const assignment
        /^\/\*\*/,                                 // JSDoc comment start
    ],
    typescript: [
        /^(export\s+)?(async\s+)?function\s+\w+/,  // Function
        /^(export\s+)?class\s+\w+/,                // Class
        /^(export\s+)?interface\s+\w+/,            // Interface
        /^(export\s+)?type\s+\w+/,                 // Type alias
        /^(export\s+)?const\s+\w+\s*=/,            // Const assignment
        /^\/\*\*/,                                 // JSDoc comment start
    ],
    json: [
        /^\s*"\w+":\s*\{/,        // Object property start
        /^\s*"\w+":\s*\[/,        // Array property start
    ],
    html: [
        /^<(div|section|article|header|footer|main|nav|aside)/i,  // Block elements
        /^<!--/,                  // Comment
    ],
    css: [
        /^[.#@]\w+/,              // Selector or at-rule
    ]
};

/**
 * Normalize language ID for boundary detection
 */
function normalizeLanguage(lang: string): string {
    const langMap: { [key: string]: string } = {
        'py': 'python',
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'htm': 'html',
        'scss': 'css',
        'less': 'css'
    };
    return langMap[lang.toLowerCase()] || lang.toLowerCase();
}

/**
 * Find logical boundary lines in the content.
 * Returns line numbers (1-indexed) that are good split points.
 */
function findLogicalBoundaries(content: string, language: string): number[] {
    const normalizedLang = normalizeLanguage(language);
    const patterns = BOUNDARY_PATTERNS[normalizedLang] || [];
    
    if (patterns.length === 0) {
        return [];
    }

    const lines = content.split('\n');
    const boundaries: number[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        for (const pattern of patterns) {
            if (pattern.test(line)) {
                boundaries.push(i + 1); // 1-indexed
                break;
            }
        }
    }

    debug(`Found ${boundaries.length} logical boundaries in ${normalizedLang} file`);
    return boundaries;
}

/**
 * Add line numbers to content.
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
 * Split content into chunks using logical boundaries when possible.
 */
function splitAtBoundaries(
    lines: string[],
    boundaries: number[],
    maxLinesPerChunk: number,
    overlapLines: number
): { start: number; end: number }[] {
    const chunks: { start: number; end: number }[] = [];
    let currentStart = 0;

    while (currentStart < lines.length) {
        const idealEnd = Math.min(currentStart + maxLinesPerChunk, lines.length);
        
        // Find the best boundary to split at
        let splitPoint = idealEnd;
        
        if (idealEnd < lines.length) {
            // Look for a boundary near the ideal end point
            const nearbyBoundaries = boundaries.filter(b => 
                b > currentStart + overlapLines && 
                b <= idealEnd && 
                b >= idealEnd - (maxLinesPerChunk / 4) // Within last 25% of chunk
            );

            if (nearbyBoundaries.length > 0) {
                // Use the last boundary before ideal end
                splitPoint = nearbyBoundaries[nearbyBoundaries.length - 1] - 1;
                debug(`Using logical boundary at line ${splitPoint + 1}`);
            }
        }

        chunks.push({
            start: currentStart,
            end: Math.min(splitPoint, lines.length)
        });

        // Start next chunk with overlap
        currentStart = Math.max(splitPoint - overlapLines, splitPoint);
        
        // Prevent infinite loop
        if (currentStart <= chunks[chunks.length - 1].start) {
            currentStart = chunks[chunks.length - 1].end;
        }
    }

    return chunks;
}

/**
 * Determine if a file needs chunking based on size.
 */
export function needsChunking(file: ChunkableFileContent, options?: ChunkingOptions): boolean {
    const threshold = options?.chunkThreshold || CHUNK_THRESHOLD;
    return file.content.length > threshold;
}

/**
 * Estimate token count for a string.
 */
export function estimateTokens(content: string): number {
    return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Chunk a file into smaller pieces for API processing.
 */
export function chunkFile(file: ChunkableFileContent, options?: ChunkingOptions): ChunkingResult {
    const maxChunkSize = options?.maxChunkSize || DEFAULT_CHUNK_SIZE;
    const threshold = options?.chunkThreshold || CHUNK_THRESHOLD;
    const overlapLines = options?.overlapLines || CHUNK_OVERLAP_LINES;
    const preferLogical = options?.preferLogicalBoundaries !== false;

    // Check if chunking is needed
    if (file.content.length <= threshold) {
        const singleChunk: FileChunk = {
            originalPath: file.path,
            chunkIndex: 0,
            totalChunks: 1,
            startLine: 1,
            endLine: file.lineCount,
            content: addLineNumbers(file.content),
            rawContent: file.content,
            language: file.language,
            originalMd5: file.md5Hash,
            sizeBytes: file.content.length,
            estimatedTokens: estimateTokens(file.content)
        };

        return {
            wasChunked: false,
            originalFile: file,
            chunks: [singleChunk],
            reason: `File size ${(file.content.length / 1024).toFixed(1)}KB is under threshold`
        };
    }

    info(`Chunking large file: ${file.relativePath} (${(file.content.length / 1024).toFixed(1)}KB)`);

    const lines = file.content.split('\n');
    
    // Calculate target lines per chunk based on byte size
    const avgBytesPerLine = file.content.length / lines.length;
    const targetLinesPerChunk = Math.floor(maxChunkSize / avgBytesPerLine);

    // Find logical boundaries if enabled
    const boundaries = preferLogical ? findLogicalBoundaries(file.content, file.language) : [];

    // Split into chunks
    const chunkRanges = splitAtBoundaries(lines, boundaries, targetLinesPerChunk, overlapLines);
    
    const chunks: FileChunk[] = chunkRanges.map((range, index) => {
        const chunkLines = lines.slice(range.start, range.end);
        const rawContent = chunkLines.join('\n');
        
        return {
            originalPath: file.path,
            chunkIndex: index,
            totalChunks: chunkRanges.length,
            startLine: range.start + 1, // 1-indexed
            endLine: range.end, // 1-indexed
            content: addLineNumbers(rawContent, range.start + 1),
            rawContent,
            language: file.language,
            originalMd5: file.md5Hash,
            sizeBytes: rawContent.length,
            estimatedTokens: estimateTokens(rawContent)
        };
    });

    info(`Split ${file.relativePath} into ${chunks.length} chunks`);
    chunks.forEach((c, i) => {
        debug(`  Chunk ${i + 1}: lines ${c.startLine}-${c.endLine} (${(c.sizeBytes / 1024).toFixed(1)}KB)`);
    });

    return {
        wasChunked: true,
        originalFile: file,
        chunks,
        reason: `File size ${(file.content.length / 1024).toFixed(1)}KB exceeds ${(threshold / 1024).toFixed(0)}KB threshold, split into ${chunks.length} chunks`
    };
}

/**
 * Format a chunk for inclusion in a prompt.
 */
export function formatChunkForPrompt(chunk: FileChunk): string {
    const chunkInfo = chunk.totalChunks > 1 
        ? ` [CHUNK ${chunk.chunkIndex + 1}/${chunk.totalChunks}, lines ${chunk.startLine}-${chunk.endLine}]`
        : '';
    
    return `### ${chunk.originalPath}${chunkInfo} [MD5: ${chunk.originalMd5}]
\`\`\`${chunk.language}
${chunk.content}
\`\`\``;
}

/**
 * Create a summary of chunks for multi-pass processing.
 */
export function createChunkSummary(chunks: FileChunk[]): string {
    if (chunks.length <= 1) {
        return '';
    }

    const file = chunks[0].originalPath;
    const totalLines = chunks[chunks.length - 1].endLine;
    
    let summary = `\n**📦 LARGE FILE CHUNKING ACTIVE for ${file}:**\n`;
    summary += `Total: ${chunks.length} chunks, ${totalLines} lines\n`;
    chunks.forEach(c => {
        summary += `  - Chunk ${c.chunkIndex + 1}: lines ${c.startLine}-${c.endLine} (${(c.sizeBytes / 1024).toFixed(1)}KB)\n`;
    });
    summary += `\n**⚠️ Process one chunk at a time. After completing changes to current chunk, respond with nextSteps to continue.**\n`;
    
    return summary;
}

/**
 * Chunk multiple files, returning both chunked and non-chunked results.
 */
export function chunkFiles(files: ChunkableFileContent[], options?: ChunkingOptions): {
    results: ChunkingResult[];
    totalChunks: number;
    chunkedFiles: number;
} {
    const results = files.map(f => chunkFile(f, options));
    const totalChunks = results.reduce((sum, r) => sum + r.chunks.length, 0);
    const chunkedFiles = results.filter(r => r.wasChunked).length;

    info(`Chunking complete: ${files.length} files -> ${totalChunks} chunks (${chunkedFiles} files were chunked)`);

    return { results, totalChunks, chunkedFiles };
}
