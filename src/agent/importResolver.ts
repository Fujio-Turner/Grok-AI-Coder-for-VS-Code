/**
 * Import Resolver - Resolves imports to actual files or URLs.
 * Follows imports with depth limiting to prevent infinite recursion.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ParsedImport, parseImports, getLanguageFromPath } from './importParser';
import { readFile, FileContent } from './workspaceFiles';
import { fetchUrl } from './httpFetcher';
import { debug, info, error as logError } from '../utils/logger';

export interface ResolvedImport {
    import: ParsedImport;
    resolved: boolean;
    localPath?: string;
    content?: string;
    externalUrl?: string;
    externalContent?: string;
    error?: string;
}

export interface ImportFollowResult {
    files: Map<string, FileContent>;      // Local files loaded
    external: Map<string, string>;         // External URLs -> content
    depth: number;                         // Current depth
    errors: string[];                      // Any errors encountered
}

const MAX_DEPTH = 3;
const MAX_FILES = 15;
const MAX_EXTERNAL = 5;

/**
 * Follow imports from a source file, recursively up to MAX_DEPTH.
 */
export async function followImports(
    startFilePath: string,
    startContent: string,
    onProgress?: (message: string) => void
): Promise<ImportFollowResult> {
    const result: ImportFollowResult = {
        files: new Map(),
        external: new Map(),
        depth: 0,
        errors: []
    };
    
    // Track visited files to avoid cycles
    const visited = new Set<string>();
    
    // Queue external fetches for parallel execution
    const externalFetchQueue: Array<{ module: string; githubUrl: string }> = [];
    
    // Queue of files to process: [filePath, content, depth]
    const queue: Array<{ path: string; content: string; depth: number }> = [
        { path: startFilePath, content: startContent, depth: 0 }
    ];
    
    while (queue.length > 0) {
        const current = queue.shift()!;
        
        // Check limits
        if (current.depth >= MAX_DEPTH) {
            debug(`Skipping ${current.path} - max depth ${MAX_DEPTH} reached`);
            continue;
        }
        
        if (result.files.size >= MAX_FILES) {
            debug(`Stopping import following - max files ${MAX_FILES} reached`);
            break;
        }
        
        if (visited.has(current.path)) {
            continue;
        }
        visited.add(current.path);
        
        // Parse imports from this file
        const language = getLanguageFromPath(current.path);
        const imports = parseImports(current.content, language);
        
        info(`Found ${imports.length} imports in ${path.basename(current.path)} at depth ${current.depth}`);
        
        for (const imp of imports) {
            // Skip builtins
            if (imp.isBuiltin) {
                debug(`Skipping builtin: ${imp.module}`);
                continue;
            }
            
            if (imp.isRelative) {
                // Resolve local import
                const resolved = await resolveLocalImport(imp, current.path, language);
                if (resolved && !visited.has(resolved.path)) {
                    onProgress?.(`📂 Following import: ${imp.module}`);
                    
                    result.files.set(resolved.path, resolved);
                    result.depth = Math.max(result.depth, current.depth + 1);
                    
                    // Queue for recursive processing
                    queue.push({
                        path: resolved.path,
                        content: resolved.content,
                        depth: current.depth + 1
                    });
                }
            } else if (imp.isExternal && imp.githubUrl && result.external.size < MAX_EXTERNAL) {
                // Queue external fetches for parallel execution (collected below)
                if (!result.external.has(imp.githubUrl)) {
                    externalFetchQueue.push({ module: imp.module, githubUrl: imp.githubUrl });
                }
            }
        }
    }
    
    // CONCURRENT FETCH: Execute all external fetches in parallel for speed
    if (externalFetchQueue.length > 0) {
        const startTime = Date.now();
        onProgress?.(`🌐 Fetching ${externalFetchQueue.length} doc(s) in parallel...`);
        
        const fetchPromises = externalFetchQueue.map(async ({ module, githubUrl }) => {
            const fetchStart = Date.now();
            try {
                const rawUrl = `https://raw.githubusercontent.com/${githubUrl.replace('https://github.com/', '')}/main/README.md`;
                const fetchResult = await fetchUrl(rawUrl);
                const fetchMs = Date.now() - fetchStart;
                
                if (fetchResult.success && fetchResult.content) {
                    const truncated = fetchResult.content.length > 5000 
                        ? fetchResult.content.substring(0, 5000) + '\n\n[Truncated...]'
                        : fetchResult.content;
                    onProgress?.(`✅ ${module} (${fetchMs}ms, ${fetchResult.bytes || 0}B)`);
                    return { githubUrl, content: truncated, success: true };
                }
                onProgress?.(`⚠️ ${module} failed (${fetchMs}ms)`);
                return { githubUrl, success: false };
            } catch (err: any) {
                const fetchMs = Date.now() - fetchStart;
                debug(`Failed to fetch docs for ${module}: ${err.message}`);
                onProgress?.(`❌ ${module} error (${fetchMs}ms)`);
                return { githubUrl, success: false };
            }
        });
        
        const fetchResults = await Promise.all(fetchPromises);
        const totalMs = Date.now() - startTime;
        
        // Store successful results
        for (const { githubUrl, content, success } of fetchResults) {
            if (success && content) {
                result.external.set(githubUrl, content);
            }
        }
        
        const successCount = fetchResults.filter(r => r.success).length;
        onProgress?.(`✅ Fetched ${successCount}/${externalFetchQueue.length} in ${totalMs}ms (parallel)`);
    }
    
    info(`Import following complete: ${result.files.size} files, ${result.external.size} external, depth ${result.depth}`);
    return result;
}

/**
 * Resolve a relative import to an actual file.
 */
async function resolveLocalImport(
    imp: ParsedImport,
    currentFilePath: string,
    language: string
): Promise<FileContent | null> {
    const currentDir = path.dirname(currentFilePath);
    
    // Build possible file paths based on the import
    const possiblePaths: string[] = [];
    
    if (language === 'python') {
        // Python: from .module import x -> ./module.py or ./module/__init__.py
        let modulePath = imp.module;
        if (modulePath.startsWith('.')) {
            // Handle relative imports
            const dots = modulePath.match(/^\.+/)?.[0] || '.';
            const rest = modulePath.slice(dots.length);
            const upDirs = '../'.repeat(dots.length - 1);
            modulePath = upDirs + rest.replace(/\./g, '/');
        } else {
            modulePath = modulePath.replace(/\./g, '/');
        }
        
        possiblePaths.push(
            path.join(currentDir, `${modulePath}.py`),
            path.join(currentDir, modulePath, '__init__.py')
        );
    } else if (language === 'javascript' || language === 'typescript') {
        // JS/TS: import x from './file' -> ./file.js, ./file.ts, ./file/index.js, etc.
        const basePath = path.join(currentDir, imp.module);
        possiblePaths.push(
            basePath,
            `${basePath}.ts`,
            `${basePath}.tsx`,
            `${basePath}.js`,
            `${basePath}.jsx`,
            path.join(basePath, 'index.ts'),
            path.join(basePath, 'index.tsx'),
            path.join(basePath, 'index.js'),
            path.join(basePath, 'index.jsx')
        );
    } else if (language === 'c' || language === 'cpp') {
        // C/C++: #include "file.h" -> relative path
        possiblePaths.push(path.join(currentDir, imp.module));
    }
    
    // Try each possible path
    for (const tryPath of possiblePaths) {
        try {
            const normalized = path.normalize(tryPath);
            const content = await readFile(normalized);
            if (content) {
                debug(`Resolved ${imp.module} -> ${normalized}`);
                return content;
            }
        } catch (err) {
            // File doesn't exist, try next
        }
    }
    
    debug(`Could not resolve import: ${imp.module}`);
    return null;
}

/**
 * Format followed imports for inclusion in prompt.
 */
export function formatImportContext(result: ImportFollowResult): string {
    let context = '';
    
    if (result.files.size > 0) {
        context += '\n\n---\n**Imported Local Files:**\n';
        for (const [filePath, file] of result.files) {
            context += `\n### ${file.relativePath || filePath}\n\`\`\`${file.language}\n${file.content}\n\`\`\`\n`;
        }
    }
    
    if (result.external.size > 0) {
        context += '\n\n---\n**External Library Documentation:**\n';
        for (const [url, content] of result.external) {
            context += `\n### ${url}\n${content}\n`;
        }
    }
    
    return context;
}
