import * as assert from 'assert';

/**
 * Unit tests for lineOperations.ts
 * Tests line-level validation and application functions.
 */

// Types recreated for testing
type LineOperationType = 'insert' | 'delete' | 'replace' | 'insertAfter' | 'insertBefore';

interface LineOperation {
    type: LineOperationType;
    line: number;
    expectedContent?: string;
    newContent?: string;
    fuzzyMatch?: boolean;
}

interface ValidationResult {
    valid: boolean;
    error?: string;
    actualContent?: string;
}

interface LineOperationResult {
    success: boolean;
    error?: string;
    failedOperation?: LineOperation;
    failedAtLine?: number;
    newContent?: string;
}

// Recreate functions for testing
function validateOperation(lines: string[], op: LineOperation): ValidationResult {
    const lineIndex = op.line - 1;
    
    if (op.type !== 'insert' && op.type !== 'insertAfter' && op.type !== 'insertBefore') {
        if (lineIndex < 0 || lineIndex >= lines.length) {
            return {
                valid: false,
                error: `Line ${op.line} does not exist (file has ${lines.length} lines)`
            };
        }
    }
    
    if ((op.type === 'delete' || op.type === 'replace') && op.expectedContent !== undefined) {
        const actualLine = lines[lineIndex];
        const expected = op.expectedContent;
        
        if (op.fuzzyMatch) {
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

function applyOperation(lines: string[], op: LineOperation): void {
    const lineIndex = op.line - 1;
    
    switch (op.type) {
        case 'delete':
            lines.splice(lineIndex, 1);
            break;
            
        case 'replace':
            if (op.newContent !== undefined) {
                if (op.expectedContent) {
                    lines[lineIndex] = lines[lineIndex].replace(op.expectedContent, op.newContent);
                } else {
                    lines[lineIndex] = op.newContent;
                }
            }
            break;
            
        case 'insert':
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

function validateAndApplyOperations(originalContent: string, operations: LineOperation[]): LineOperationResult {
    const lines = originalContent.split('\n');
    
    const sortedOps = [...operations].sort((a, b) => {
        if (a.type === 'delete' && b.type === 'delete') {
            return b.line - a.line;
        }
        if ((a.type === 'insert' || a.type === 'insertAfter' || a.type === 'insertBefore') &&
            (b.type === 'insert' || b.type === 'insertAfter' || b.type === 'insertBefore')) {
            return b.line - a.line;
        }
        return 0;
    });
    
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
    
    for (const op of sortedOps) {
        applyOperation(lines, op);
    }
    
    return {
        success: true,
        newContent: lines.join('\n')
    };
}

describe('validateOperation', () => {
    it('validates existing line for delete', () => {
        const lines = ['line1', 'line2', 'line3'];
        const result = validateOperation(lines, { type: 'delete', line: 2 });
        assert.strictEqual(result.valid, true);
    });

    it('fails for non-existent line', () => {
        const lines = ['line1', 'line2'];
        const result = validateOperation(lines, { type: 'delete', line: 5 });
        assert.strictEqual(result.valid, false);
        assert.ok(result.error?.includes('does not exist'));
    });

    it('validates expected content match', () => {
        const lines = ['const x = 1;', 'const y = 2;'];
        const result = validateOperation(lines, { 
            type: 'replace', 
            line: 1, 
            expectedContent: 'const x' 
        });
        assert.strictEqual(result.valid, true);
    });

    it('fails on expected content mismatch', () => {
        const lines = ['const x = 1;', 'const y = 2;'];
        const result = validateOperation(lines, { 
            type: 'replace', 
            line: 1, 
            expectedContent: 'const z' 
        });
        assert.strictEqual(result.valid, false);
    });

    it('fuzzy match ignores case and whitespace', () => {
        const lines = ['   CONST X = 1;   '];
        const result = validateOperation(lines, { 
            type: 'replace', 
            line: 1, 
            expectedContent: 'const x',
            fuzzyMatch: true
        });
        assert.strictEqual(result.valid, true);
    });

    it('allows insert at any line', () => {
        const lines = ['line1'];
        const result = validateOperation(lines, { type: 'insert', line: 10 });
        assert.strictEqual(result.valid, true);
    });
});

describe('applyOperation', () => {
    it('deletes a line', () => {
        const lines = ['line1', 'line2', 'line3'];
        applyOperation(lines, { type: 'delete', line: 2 });
        assert.deepStrictEqual(lines, ['line1', 'line3']);
    });

    it('replaces entire line', () => {
        const lines = ['old content'];
        applyOperation(lines, { type: 'replace', line: 1, newContent: 'new content' });
        assert.deepStrictEqual(lines, ['new content']);
    });

    it('replaces substring in line', () => {
        const lines = ['hello world'];
        applyOperation(lines, { 
            type: 'replace', 
            line: 1, 
            expectedContent: 'world',
            newContent: 'universe' 
        });
        assert.deepStrictEqual(lines, ['hello universe']);
    });

    it('inserts at specified line', () => {
        const lines = ['line1', 'line3'];
        applyOperation(lines, { type: 'insert', line: 2, newContent: 'line2' });
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
    });

    it('inserts after specified line', () => {
        const lines = ['line1', 'line3'];
        applyOperation(lines, { type: 'insertAfter', line: 1, newContent: 'line2' });
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
    });

    it('inserts before specified line', () => {
        const lines = ['line2', 'line3'];
        applyOperation(lines, { type: 'insertBefore', line: 1, newContent: 'line1' });
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
    });
});

describe('validateAndApplyOperations', () => {
    it('applies multiple operations atomically', () => {
        const content = `line1
line2
line3
line4`;
        
        const ops: LineOperation[] = [
            { type: 'delete', line: 2 },
            { type: 'replace', line: 4, newContent: 'LINE4' }
        ];
        
        const result = validateAndApplyOperations(content, ops);
        assert.strictEqual(result.success, true);
        assert.ok(result.newContent?.includes('line1'));
        assert.ok(!result.newContent?.includes('line2'));
        assert.ok(result.newContent?.includes('LINE4'));
    });

    it('fails entirely if any validation fails', () => {
        const content = 'line1\nline2';
        
        const ops: LineOperation[] = [
            { type: 'delete', line: 1 },
            { type: 'delete', line: 10 } // This should fail
        ];
        
        const result = validateAndApplyOperations(content, ops);
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('does not exist'));
    });

    it('processes deletes bottom-to-top to maintain line numbers', () => {
        const content = `line1
line2
line3
line4`;
        
        const ops: LineOperation[] = [
            { type: 'delete', line: 2 },
            { type: 'delete', line: 4 }
        ];
        
        const result = validateAndApplyOperations(content, ops);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.newContent, 'line1\nline3');
    });

    it('handles complex multi-operation edit', () => {
        const content = `function add(a, b) {
    return a + b;
}`;
        
        const ops: LineOperation[] = [
            { type: 'replace', line: 1, newContent: 'function add(a: number, b: number): number {' },
            { type: 'insertAfter', line: 1, newContent: '    // Add two numbers' }
        ];
        
        const result = validateAndApplyOperations(content, ops);
        assert.strictEqual(result.success, true);
        assert.ok(result.newContent?.includes('a: number'));
        assert.ok(result.newContent?.includes('// Add two numbers'));
    });
});
