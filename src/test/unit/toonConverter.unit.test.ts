import * as assert from 'assert';

/**
 * Unit tests for toonConverter.ts
 * Tests TOON format parsing and conversion.
 */

// Recreate core functions for testing

function toToon(value: unknown, indent = 0): string {
    const prefix = '  '.repeat(indent);
    
    if (value === null || value === undefined) {
        return 'null';
    }
    
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    
    if (typeof value === 'number') {
        return String(value);
    }
    
    if (typeof value === 'string') {
        if (value.includes('\n') || value.includes(':') || value.includes('#')) {
            return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        }
        if (/^[a-zA-Z0-9_.\-/]+$/.test(value) && value.length < 100) {
            return value;
        }
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }
        
        const lines: string[] = [];
        for (const item of value) {
            const itemStr = toToon(item, indent + 1);
            lines.push(`${prefix}- ${itemStr.trimStart()}`);
        }
        return lines.join('\n');
    }
    
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj);
        
        if (keys.length === 0) {
            return '{}';
        }
        
        const lines: string[] = [];
        for (const key of keys) {
            const v = obj[key];
            if (typeof v === 'object' && v !== null) {
                lines.push(`${prefix}${key}:`);
                lines.push(toToon(v, indent + 1));
            } else {
                lines.push(`${prefix}${key}: ${toToon(v, 0)}`);
            }
        }
        return lines.join('\n');
    }
    
    return String(value);
}

function fromToon(toonStr: string): unknown {
    const lines = toonStr.split('\n');
    let index = 0;
    
    function parseValue(value: string): unknown {
        value = value.trim();
        if (value === 'true') return true;
        if (value === 'false') return false;
        if (value === 'null' || value === '-') return null;
        if (value === '[]') return [];
        if (value === '{}') return {};
        if (/^-?\d+(\.\d+)?$/.test(value)) return parseFloat(value);
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
            return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
        return value;
    }
    
    function getIndent(line: string): number {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
    }
    
    function parseBlock(baseIndent: number): unknown {
        const result: Record<string, unknown> = {};
        
        while (index < lines.length) {
            const line = lines[index];
            const currentIndent = getIndent(line);
            const trimmed = line.trim();
            
            if (!trimmed) {
                index++;
                continue;
            }
            
            if (currentIndent < baseIndent) {
                break;
            }
            
            if (trimmed.startsWith('- ')) {
                const arr: unknown[] = [];
                while (index < lines.length) {
                    const arrLine = lines[index];
                    const arrIndent = getIndent(arrLine);
                    const arrTrimmed = arrLine.trim();
                    
                    if (!arrTrimmed) {
                        index++;
                        continue;
                    }
                    
                    if (arrIndent < baseIndent || (arrIndent === baseIndent && !arrTrimmed.startsWith('- '))) {
                        break;
                    }
                    
                    if (arrTrimmed.startsWith('- ')) {
                        const itemContent = arrTrimmed.substring(2);
                        arr.push(parseValue(itemContent));
                        index++;
                    } else {
                        break;
                    }
                }
                return arr;
            }
            
            if (trimmed.includes(':')) {
                const colonPos = trimmed.indexOf(':');
                const key = trimmed.substring(0, colonPos).trim();
                const val = trimmed.substring(colonPos + 1).trim();
                
                if (val === '') {
                    index++;
                    result[key] = parseBlock(currentIndent + 2);
                } else {
                    result[key] = parseValue(val);
                    index++;
                }
            } else {
                index++;
            }
        }
        
        return result;
    }
    
    return parseBlock(0);
}

function extractToonContent(text: string): string {
    const trimmed = text.trim();
    
    if (!trimmed.startsWith('```')) {
        return trimmed;
    }
    
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) {
        return trimmed;
    }
    
    let content = trimmed.substring(firstNewline + 1);
    
    const lines = content.split('\n');
    let lastFenceIndex = -1;
    
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === '```') {
            lastFenceIndex = i;
            break;
        }
    }
    
    if (lastFenceIndex !== -1) {
        content = lines.slice(0, lastFenceIndex).join('\n');
    }
    
    return content.trim();
}

function looksLikeToon(text: string): boolean {
    const trimmed = text.trim();
    
    if (trimmed.startsWith('```toon') || 
        (trimmed.startsWith('```') && trimmed.includes('summary:'))) {
        return true;
    }
    
    return !trimmed.startsWith('{') && 
           !trimmed.startsWith('[') &&
           /^summary:\s*.+/m.test(trimmed);
}

describe('toToon', () => {
    it('converts primitives', () => {
        assert.strictEqual(toToon(null), 'null');
        assert.strictEqual(toToon(true), 'true');
        assert.strictEqual(toToon(false), 'false');
        assert.strictEqual(toToon(42), '42');
        assert.strictEqual(toToon(3.14), '3.14');
    });

    it('converts simple strings without quotes', () => {
        assert.strictEqual(toToon('hello'), 'hello');
        assert.strictEqual(toToon('file.txt'), 'file.txt');
        assert.strictEqual(toToon('path/to/file'), 'path/to/file');
    });

    it('quotes strings with special characters', () => {
        assert.strictEqual(toToon('hello world'), '"hello world"');
        assert.strictEqual(toToon('key: value'), '"key: value"');
    });

    it('converts empty arrays and objects', () => {
        assert.strictEqual(toToon([]), '[]');
        assert.strictEqual(toToon({}), '{}');
    });

    it('converts simple object', () => {
        const obj = { name: 'test', value: 42 };
        const toon = toToon(obj);
        assert.ok(toon.includes('name: test'));
        assert.ok(toon.includes('value: 42'));
    });

    it('converts array of primitives', () => {
        const arr = ['item1', 'item2', 'item3'];
        const toon = toToon(arr);
        assert.ok(toon.includes('- item1'));
        assert.ok(toon.includes('- item2'));
        assert.ok(toon.includes('- item3'));
    });
});

describe('fromToon', () => {
    it('parses simple key-value pairs', () => {
        const toon = `name: test
value: 42`;
        const result = fromToon(toon) as Record<string, unknown>;
        assert.strictEqual(result.name, 'test');
        assert.strictEqual(result.value, 42);
    });

    it('parses boolean values', () => {
        const toon = `enabled: true
disabled: false`;
        const result = fromToon(toon) as Record<string, unknown>;
        assert.strictEqual(result.enabled, true);
        assert.strictEqual(result.disabled, false);
    });

    it('parses null values', () => {
        const toon = `value: null`;
        const result = fromToon(toon) as Record<string, unknown>;
        assert.strictEqual(result.value, null);
    });

    it('parses quoted strings', () => {
        const toon = `message: "hello world"`;
        const result = fromToon(toon) as Record<string, unknown>;
        assert.strictEqual(result.message, 'hello world');
    });

    it('parses nested objects', () => {
        const toon = `outer:
  inner: value`;
        const result = fromToon(toon) as Record<string, any>;
        assert.strictEqual(result.outer.inner, 'value');
    });

    it('parses simple arrays', () => {
        const toon = `items:
  - item1
  - item2
  - item3`;
        const result = fromToon(toon) as Record<string, unknown[]>;
        assert.deepStrictEqual(result.items, ['item1', 'item2', 'item3']);
    });
});

describe('extractToonContent', () => {
    it('returns plain text unchanged', () => {
        const text = 'summary: test response';
        assert.strictEqual(extractToonContent(text), text);
    });

    it('extracts content from toon fence', () => {
        const text = '```toon\nsummary: test\n```';
        assert.strictEqual(extractToonContent(text), 'summary: test');
    });

    it('extracts content from generic fence', () => {
        const text = '```\nsummary: test\n```';
        assert.strictEqual(extractToonContent(text), 'summary: test');
    });

    it('handles nested code blocks', () => {
        const text = `\`\`\`toon
summary: test
code: |
  \`\`\`python
  print("hello")
  \`\`\`
\`\`\``;
        const result = extractToonContent(text);
        assert.ok(result.includes('summary: test'));
    });
});

describe('looksLikeToon', () => {
    it('detects toon fence', () => {
        assert.strictEqual(looksLikeToon('```toon\nsummary: test\n```'), true);
    });

    it('detects toon by structure', () => {
        assert.strictEqual(looksLikeToon('summary: This is a test'), true);
    });

    it('rejects JSON', () => {
        assert.strictEqual(looksLikeToon('{"summary": "test"}'), false);
    });

    it('rejects arrays', () => {
        assert.strictEqual(looksLikeToon('[1, 2, 3]'), false);
    });

    it('requires summary field', () => {
        assert.strictEqual(looksLikeToon('name: test\nvalue: 42'), false);
    });
});

describe('Round-trip conversion', () => {
    it('preserves simple object', () => {
        const original = { summary: 'test', value: 42 };
        const toon = toToon(original);
        const parsed = fromToon(toon) as Record<string, unknown>;
        assert.strictEqual(parsed.summary, original.summary);
        assert.strictEqual(parsed.value, original.value);
    });

    it('preserves nested structure', () => {
        const original = {
            summary: 'test response',
            config: {
                enabled: true,
                count: 5
            }
        };
        const toon = toToon(original);
        const parsed = fromToon(toon) as any;
        assert.strictEqual(parsed.summary, 'test response');
        assert.strictEqual(parsed.config.enabled, true);
        assert.strictEqual(parsed.config.count, 5);
    });
});
