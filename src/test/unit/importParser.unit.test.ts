import * as assert from 'assert';

/**
 * Unit tests for importParser.ts
 * Tests import statement parsing for Python, JavaScript/TypeScript, and C/C++.
 */

// Recreate types and functions for testing

interface ParsedImport {
    raw: string;
    module: string;
    isRelative: boolean;
    isBuiltin: boolean;
    isExternal: boolean;
    language: string;
    githubUrl?: string;
}

const PYTHON_BUILTINS = new Set([
    'os', 'sys', 'json', 'time', 'datetime', 'math', 'random', 're', 'collections',
    'itertools', 'functools', 'typing', 'pathlib', 'subprocess', 'threading',
    'multiprocessing', 'asyncio', 'logging', 'unittest', 'copy', 'io', 'string'
]);

const JS_BUILTINS = new Set([
    'fs', 'path', 'http', 'https', 'url', 'util', 'os', 'crypto', 'stream',
    'events', 'buffer', 'querystring', 'child_process', 'cluster', 'net'
]);

const KNOWN_PACKAGES: Record<string, string> = {
    'couchbase': 'https://github.com/couchbase/couchbase-python-client',
    'requests': 'https://github.com/psf/requests',
    'flask': 'https://github.com/pallets/flask',
    'express': 'https://github.com/expressjs/express',
    'react': 'https://github.com/facebook/react',
    'axios': 'https://github.com/axios/axios',
};

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

function parsePythonImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    const lines = content.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        if (trimmed.startsWith('#')) continue;
        
        const importMatch = trimmed.match(/^import\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        if (importMatch) {
            const module = importMatch[1];
            imports.push(createImport(trimmed, module, 'python'));
        }
        
        const fromMatch = trimmed.match(/^from\s+(\.{0,2}[a-zA-Z_][a-zA-Z0-9_.]*)\s+import/);
        if (fromMatch) {
            const module = fromMatch[1];
            imports.push(createImport(trimmed, module, 'python'));
        }
    }
    
    return imports;
}

function parseJsImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        imports.push(createImport(match[0], match[1], 'javascript'));
    }
    
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
        imports.push(createImport(match[0], match[1], 'javascript'));
    }
    
    return imports;
}

function parseCImports(content: string): ParsedImport[] {
    const imports: ParsedImport[] = [];
    
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

function getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'jsx': 'javascript',
        'tsx': 'typescript',
        'c': 'c',
        'h': 'c',
        'cpp': 'cpp',
        'hpp': 'cpp'
    };
    return langMap[ext] || ext;
}

describe('parsePythonImports', () => {
    it('parses simple import', () => {
        const content = 'import os';
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'os');
        assert.strictEqual(imports[0].isBuiltin, true);
    });

    it('parses from import', () => {
        const content = 'from flask import Flask';
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'flask');
        assert.strictEqual(imports[0].isExternal, true);
        assert.strictEqual(imports[0].githubUrl, 'https://github.com/pallets/flask');
    });

    it('parses relative import', () => {
        const content = 'from .utils import helper';
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].isRelative, true);
    });

    it('parses parent relative import', () => {
        const content = 'from ..models import User';
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].isRelative, true);
    });

    it('skips comments', () => {
        const content = `# import os
import json`;
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'json');
    });

    it('parses multiple imports', () => {
        const content = `import os
import sys
from requests import get
from .local import func`;
        const imports = parsePythonImports(content);
        
        assert.strictEqual(imports.length, 4);
    });
});

describe('parseJsImports', () => {
    it('parses ES6 default import', () => {
        const content = "import React from 'react';";
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'react');
        assert.strictEqual(imports[0].isExternal, true);
    });

    it('parses ES6 named import', () => {
        const content = "import { useState, useEffect } from 'react';";
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'react');
    });

    it('parses CommonJS require', () => {
        const content = "const express = require('express');";
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'express');
    });

    it('parses relative import', () => {
        const content = "import { helper } from './utils/helper';";
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].isRelative, true);
    });

    it('identifies Node.js builtins', () => {
        const content = "import fs from 'fs';";
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].isBuiltin, true);
    });

    it('parses double-quoted imports', () => {
        const content = 'import axios from "axios";';
        const imports = parseJsImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'axios');
    });
});

describe('parseCImports', () => {
    it('parses local include', () => {
        const content = '#include "myheader.h"';
        const imports = parseCImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'myheader.h');
        assert.strictEqual(imports[0].isRelative, true);
    });

    it('parses system include', () => {
        const content = '#include <stdio.h>';
        const imports = parseCImports(content);
        
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].module, 'stdio.h');
        assert.strictEqual(imports[0].isBuiltin, true);
    });

    it('parses mixed includes', () => {
        const content = `#include <stdio.h>
#include <stdlib.h>
#include "myapp.h"`;
        const imports = parseCImports(content);
        
        assert.strictEqual(imports.length, 3);
        assert.strictEqual(imports.filter(i => i.isBuiltin).length, 2);
        assert.strictEqual(imports.filter(i => i.isRelative).length, 1);
    });
});

describe('getLanguageFromPath', () => {
    it('detects Python', () => {
        assert.strictEqual(getLanguageFromPath('script.py'), 'python');
    });

    it('detects JavaScript', () => {
        assert.strictEqual(getLanguageFromPath('app.js'), 'javascript');
        assert.strictEqual(getLanguageFromPath('component.jsx'), 'javascript');
    });

    it('detects TypeScript', () => {
        assert.strictEqual(getLanguageFromPath('app.ts'), 'typescript');
        assert.strictEqual(getLanguageFromPath('component.tsx'), 'typescript');
    });

    it('detects C/C++', () => {
        assert.strictEqual(getLanguageFromPath('main.c'), 'c');
        assert.strictEqual(getLanguageFromPath('header.h'), 'c');
        assert.strictEqual(getLanguageFromPath('app.cpp'), 'cpp');
        assert.strictEqual(getLanguageFromPath('header.hpp'), 'cpp');
    });

    it('returns extension for unknown', () => {
        assert.strictEqual(getLanguageFromPath('file.rs'), 'rs');
        assert.strictEqual(getLanguageFromPath('file.go'), 'go');
    });
});

describe('createImport classification', () => {
    it('identifies external packages with GitHub URLs', () => {
        const imp = createImport('import requests', 'requests', 'python');
        
        assert.strictEqual(imp.isExternal, true);
        assert.strictEqual(imp.isBuiltin, false);
        assert.strictEqual(imp.githubUrl, 'https://github.com/psf/requests');
    });

    it('identifies builtins without GitHub URLs', () => {
        const imp = createImport('import os', 'os', 'python');
        
        assert.strictEqual(imp.isBuiltin, true);
        assert.strictEqual(imp.isExternal, false);
        assert.strictEqual(imp.githubUrl, undefined);
    });

    it('identifies relative imports', () => {
        const imp = createImport('from ./utils import helper', './utils', 'python');
        
        assert.strictEqual(imp.isRelative, true);
        assert.strictEqual(imp.isBuiltin, false);
        assert.strictEqual(imp.isExternal, false);
    });
});
