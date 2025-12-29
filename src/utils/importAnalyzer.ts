/**
 * Import Analyzer - Parses file imports to find related local files.
 * Used for Proactive File Bundling feature.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { debug } from './logger';

export interface ImportInfo {
    source: string;        // The import path as written in the file
    resolvedPath: string;  // Absolute path (if local file exists)
    isLocal: boolean;      // true if it's a project file, not node_module/package
}

export interface BundledFile {
    path: string;          // Absolute path to the file
    relativePath: string;  // Relative to workspace root
    type: 'import' | 'test' | 'related';  // Why this file was bundled
    sizeBytes?: number;    // File size for context budget
}

/**
 * Analyze imports in a source file and return local file references.
 */
export function analyzeImports(filePath: string, content: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        imports.push(...analyzeJavaScriptImports(content, dir));
    } else if (ext === '.py') {
        imports.push(...analyzePythonImports(content, dir));
    }

    return imports.filter(i => i.isLocal);
}

/**
 * Analyze JavaScript/TypeScript imports.
 */
function analyzeJavaScriptImports(content: string, dir: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    // Match patterns:
    // import X from 'path'
    // import { X } from 'path'
    // import 'path'
    // require('path')
    // export * from 'path'
    const patterns = [
        /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /export\s+(?:\*|{[^}]*})\s+from\s+['"]([^'"]+)['"]/g
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const source = match[1];
            const result = resolveJsImport(source, dir);
            imports.push(result);
        }
    }

    return imports;
}

/**
 * Resolve a JavaScript/TypeScript import path.
 */
function resolveJsImport(source: string, dir: string): ImportInfo {
    // Skip node_modules and absolute packages
    if (!source.startsWith('.') && !source.startsWith('/')) {
        return { source, resolvedPath: '', isLocal: false };
    }

    // Resolve relative path
    const basePath = path.resolve(dir, source);
    
    // Try common extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '', '/index.ts', '/index.tsx', '/index.js'];
    
    for (const ext of extensions) {
        const fullPath = basePath + ext;
        // We'll check existence later in bundleRelatedFiles
        if (ext === '' || ext.startsWith('/index')) {
            // For index files, return the resolved path
            return { source, resolvedPath: fullPath, isLocal: true };
        }
    }

    // Default to .ts extension for TypeScript projects
    return { source, resolvedPath: basePath + '.ts', isLocal: true };
}

/**
 * Analyze Python imports.
 */
function analyzePythonImports(content: string, dir: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    
    // Match patterns:
    // from module import X
    // import module
    // from .relative import X
    // from ..parent import X
    const patterns = [
        /from\s+(\.+[\w.]*)\s+import/g,      // Relative imports
        /from\s+([\w.]+)\s+import/g,          // Absolute imports
        /^import\s+([\w.]+)/gm                // Simple imports
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            const source = match[1];
            const result = resolvePythonImport(source, dir);
            imports.push(result);
        }
    }

    return imports;
}

/**
 * Resolve a Python import path.
 */
function resolvePythonImport(source: string, dir: string): ImportInfo {
    // Handle relative imports (starting with .)
    if (source.startsWith('.')) {
        let currentDir = dir;
        let relativePart = source;
        
        // Count leading dots for parent traversal
        while (relativePart.startsWith('.')) {
            if (relativePart.startsWith('..')) {
                currentDir = path.dirname(currentDir);
                relativePart = relativePart.slice(1);
            }
            relativePart = relativePart.slice(1);
        }
        
        // Convert dots to path separators
        const modulePath = relativePart.replace(/\./g, path.sep);
        const fullPath = path.join(currentDir, modulePath + '.py');
        
        return { source, resolvedPath: fullPath, isLocal: true };
    }
    
    // Absolute imports - hard to resolve without knowing PYTHONPATH
    // Just mark as non-local for now
    return { source, resolvedPath: '', isLocal: false };
}

/**
 * Find related test files for a source file.
 */
export function findRelatedTests(filePath: string): string[] {
    const tests: string[] = [];
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const dir = path.dirname(filePath);
    
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        // JavaScript/TypeScript test patterns
        tests.push(
            path.join(dir, `${baseName}.test${ext}`),
            path.join(dir, `${baseName}.spec${ext}`),
            path.join(dir, '__tests__', `${baseName}${ext}`),
            path.join(dir, '__tests__', `${baseName}.test${ext}`)
        );
        
        // Also check tests/ directory at project root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const relativePath = path.relative(workspaceRoot, filePath);
            const testPath = relativePath.replace(/^src\//, 'tests/').replace(ext, `.test${ext}`);
            tests.push(path.join(workspaceRoot, testPath));
        }
    } else if (ext === '.py') {
        // Python test patterns
        tests.push(
            path.join(dir, `test_${baseName}.py`),
            path.join(dir, `${baseName}_test.py`)
        );
        
        // Check tests/ directory
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const relativePath = path.relative(workspaceRoot, filePath);
            const testPath = relativePath.replace(/^src\//, 'tests/');
            const testFileName = `test_${baseName}.py`;
            tests.push(path.join(workspaceRoot, path.dirname(testPath), testFileName));
        }
    }
    
    return tests;
}

/**
 * Bundle related files for a changed file.
 * Finds imports and test files, filters to existing files, limits count.
 */
export async function bundleRelatedFiles(
    changedFilePath: string,
    options: {
        includeImports?: boolean;
        includeTests?: boolean;
        maxFiles?: number;
    } = {}
): Promise<BundledFile[]> {
    const {
        includeImports = true,
        includeTests = true,
        maxFiles = 5
    } = options;

    const bundled: BundledFile[] = [];
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    if (!workspaceRoot) {
        return bundled;
    }

    try {
        // Read the changed file
        const uri = vscode.Uri.file(changedFilePath);
        const content = (await vscode.workspace.fs.readFile(uri)).toString();

        // Analyze imports
        if (includeImports) {
            const imports = analyzeImports(changedFilePath, content);
            
            for (const imp of imports) {
                if (!imp.isLocal || !imp.resolvedPath) continue;
                if (bundled.length >= maxFiles) break;
                
                // Try to resolve the actual file
                const resolvedUri = await resolveImportPath(imp.resolvedPath);
                if (resolvedUri) {
                    const relativePath = path.relative(workspaceRoot, resolvedUri.fsPath);
                    
                    // Skip if already bundled or if it's the same file
                    if (bundled.some(b => b.path === resolvedUri.fsPath)) continue;
                    if (resolvedUri.fsPath === changedFilePath) continue;
                    
                    try {
                        const stat = await vscode.workspace.fs.stat(resolvedUri);
                        bundled.push({
                            path: resolvedUri.fsPath,
                            relativePath,
                            type: 'import',
                            sizeBytes: stat.size
                        });
                    } catch {
                        // File doesn't exist, skip
                    }
                }
            }
        }

        // Find test files
        if (includeTests) {
            const testPaths = findRelatedTests(changedFilePath);
            
            for (const testPath of testPaths) {
                if (bundled.length >= maxFiles) break;
                
                // Skip if already bundled
                if (bundled.some(b => b.path === testPath)) continue;
                
                try {
                    const testUri = vscode.Uri.file(testPath);
                    const stat = await vscode.workspace.fs.stat(testUri);
                    const relativePath = path.relative(workspaceRoot, testPath);
                    
                    bundled.push({
                        path: testPath,
                        relativePath,
                        type: 'test',
                        sizeBytes: stat.size
                    });
                } catch {
                    // Test file doesn't exist, skip
                }
            }
        }

        debug(`Bundled ${bundled.length} related files for ${path.basename(changedFilePath)}`);
        
    } catch (err) {
        debug('Error bundling related files:', err);
    }

    return bundled.slice(0, maxFiles);
}

/**
 * Try to resolve an import path to an actual file.
 */
async function resolveImportPath(importPath: string): Promise<vscode.Uri | null> {
    // Extensions to try
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json'];
    const indexFiles = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    
    for (const ext of extensions) {
        try {
            const uri = vscode.Uri.file(importPath + ext);
            await vscode.workspace.fs.stat(uri);
            return uri;
        } catch {
            // Try next extension
        }
    }
    
    // Try index files
    for (const indexFile of indexFiles) {
        try {
            const uri = vscode.Uri.file(importPath + indexFile);
            await vscode.workspace.fs.stat(uri);
            return uri;
        } catch {
            // Try next
        }
    }
    
    return null;
}

/**
 * Build a summary of bundled files for AI context injection.
 */
export function buildBundledFilesSummary(files: BundledFile[]): string {
    if (!files || files.length === 0) {
        return '';
    }

    const lines: string[] = [];
    lines.push('\n## 📦 AUTO-BUNDLED FILES');
    lines.push('These files were automatically attached because they are related to files you modified.\n');

    const imports = files.filter(f => f.type === 'import');
    const tests = files.filter(f => f.type === 'test');
    const related = files.filter(f => f.type === 'related');

    if (imports.length > 0) {
        lines.push('### Imported Files');
        for (const f of imports) {
            const size = f.sizeBytes ? ` (${formatSize(f.sizeBytes)})` : '';
            lines.push(`- 📄 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    if (tests.length > 0) {
        lines.push('### Test Files');
        for (const f of tests) {
            const size = f.sizeBytes ? ` (${formatSize(f.sizeBytes)})` : '';
            lines.push(`- 🧪 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    if (related.length > 0) {
        lines.push('### Related Files');
        for (const f of related) {
            const size = f.sizeBytes ? ` (${formatSize(f.sizeBytes)})` : '';
            lines.push(`- 📎 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    lines.push('*These files are included in your context. Review before making changes.*');

    return lines.join('\n');
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
