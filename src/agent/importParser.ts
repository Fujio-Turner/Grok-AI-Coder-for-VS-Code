/**
 * Import Parser - Extracts import statements from source files.
 * Supports Python, JavaScript, TypeScript, and C/C++.
 */

import { debug } from '../utils/logger';

export interface ParsedImport {
    raw: string;           // Original import statement
    module: string;        // Module/file being imported
    isRelative: boolean;   // Is it a relative import (./file, ../file)
    isBuiltin: boolean;    // Is it a standard library/builtin
    isExternal: boolean;   // Is it an external package (npm, pypi, github)
    language: string;      // Source language
    githubUrl?: string;    // GitHub URL if detectable
}

// Common standard library modules to skip
const PYTHON_BUILTINS = new Set([
    'os', 'sys', 'json', 'time', 'datetime', 'math', 'random', 're', 'collections',
    'itertools', 'functools', 'typing', 'pathlib', 'subprocess', 'threading',
    'multiprocessing', 'asyncio', 'logging', 'unittest', 'copy', 'io', 'string',
    'hashlib', 'base64', 'urllib', 'http', 'socket', 'ssl', 'email', 'html',
    'xml', 'csv', 'sqlite3', 'pickle', 'struct', 'array', 'queue', 'heapq',
    'bisect', 'weakref', 'types', 'abc', 'contextlib', 'dataclasses', 'enum',
    'traceback', 'warnings', 'inspect', 'dis', 'gc', 'builtins', '__future__'
]);

const JS_BUILTINS = new Set([
    'fs', 'path', 'http', 'https', 'url', 'util', 'os', 'crypto', 'stream',
    'events', 'buffer', 'querystring', 'child_process', 'cluster', 'net',
    'dns', 'tls', 'readline', 'repl', 'vm', 'zlib', 'assert', 'console',
    'process', 'timers', 'module', 'worker_threads', 'perf_hooks'
]);

// Common external packages with GitHub URLs
const KNOWN_PACKAGES: Record<string, string> = {
    // Python
    'couchbase': 'https://github.com/couchbase/couchbase-python-client',
    'requests': 'https://github.com/psf/requests',
    'flask': 'https://github.com/pallets/flask',
    'django': 'https://github.com/django/django',
    'fastapi': 'https://github.com/tiangolo/fastapi',
    'pandas': 'https://github.com/pandas-dev/pandas',
    'numpy': 'https://github.com/numpy/numpy',
    'pytest': 'https://github.com/pytest-dev/pytest',
    // JavaScript/TypeScript
    'express': 'https://github.com/expressjs/express',
    'react': 'https://github.com/facebook/react',
    'vue': 'https://github.com/vuejs/vue',
    'axios': 'https://github.com/axios/axios',
    'lodash': 'https://github.com/lodash/lodash',
    'moment': 'https://github.com/moment/moment',
    'uuid': 'https://github.com/uuidjs/uuid',
};

/**
 * Parse imports from a source file.
 */
export function parseImports(content: string, language: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    
    switch (language.toLowerCase()) {
        case 'python':
        case 'py':
            imports.push(...parsePythonImports(content));
            break;
        case 'javascript':
        case 'typescript':
        case 'js':
        case 'ts':
        case 'jsx':
        case 'tsx':
            imports.push(...parseJsImports(content));
            break;
        case 'c':
        case 'cpp':
        case 'c++':
        case 'h':
        case 'hpp':
            imports.push(...parseCImports(content));
            break;
    }
    
    debug(`Parsed ${imports.length} imports from ${language} file`);
    return imports;
}

/**
 * Parse Python import statements.
 */
function parsePythonImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        // Skip comments
        if (trimmed.startsWith('#')) continue;
        
        // Match: import module or import module as alias
        const importMatch = trimmed.match(/^import\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (importMatch) {
            const module = importMatch[1];
            imports.push(createImport(trimmed, module, 'python'));
        }
        
        // Match: from module import ... or from .module import ...
        const fromMatch = trimmed.match(/^from\s+(\.{0,2}[a-zA-Z_][a-zA-Z0-9_.]*)\s+import/);
        if (fromMatch) {
            const module = fromMatch[1];
            imports.push(createImport(trimmed, module, 'python'));
        }
    }
    
    return imports;
}

/**
 * Parse JavaScript/TypeScript import statements.
 */
function parseJsImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    
    // Match: import ... from 'module' or import ... from "module"
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        imports.push(createImport(match[0], match[1], 'javascript'));
    }
    
    // Match: require('module') or require("module")
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
        imports.push(createImport(match[0], match[1], 'javascript'));
    }
    
    // Match: import 'module' (side-effect import)
    const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
    while ((match = sideEffectRegex.exec(content)) !== null) {
        imports.push(createImport(match[0], match[1], 'javascript'));
    }
    
    return imports;
}

/**
 * Parse C/C++ include statements.
 */
function parseCImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    
    // Match: #include "file.h" (local)
    const localRegex = /#include\s*"([^"]+)"/g;
    let match;
    while ((match = localRegex.exec(content)) !== null) {
        imports.push({
            raw: match[0],
            module: match[1],
            isRelative: true,
            isBuiltin: false,
            isExternal: false,
            language: 'c'
        });
    }
    
    // Match: #include <file.h> (system - skip these)
    const systemRegex = /#include\s*<([^>]+)>/g;
    while ((match = systemRegex.exec(content)) !== null) {
        imports.push({
            raw: match[0],
            module: match[1],
            isRelative: false,
            isBuiltin: true,
            isExternal: false,
            language: 'c'
        });
    }
    
    return imports;
}

/**
 * Create a ParsedImport with classification.
 */
function createImport(raw: string, module: string, language: string): ParsedImport {
    const isRelative = module.startsWith('.') || module.startsWith('/');
    const baseModule = module.split('/')[0].split('.')[0];
    
    const builtins = language === 'python' ? PYTHON_BUILTINS : JS_BUILTINS;
    const isBuiltin = builtins.has(baseModule);
    
    const isExternal = !isRelative && !isBuiltin;
    const githubUrl = KNOWN_PACKAGES[baseModule];
    
    return {
        raw,
        module,
        isRelative,
        isBuiltin,
        isExternal,
        language,
        githubUrl
    };
}

/**
 * Get language from file extension.
 */
export function getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'jsx': 'javascript',
        'tsx': 'typescript',
        'mjs': 'javascript',
        'cjs': 'javascript',
        'c': 'c',
        'h': 'c',
        'cpp': 'cpp',
        'hpp': 'cpp',
        'cc': 'cpp',
        'cxx': 'cpp'
    };
    return langMap[ext] || ext;
}
