/**
 * TOON (Token-Oriented Object Notation) Converter
 * 
 * TOON is a compact text format optimized for LLM token efficiency.
 * It reduces token usage by 30-60% compared to JSON by:
 * - Using indentation instead of braces/brackets
 * - Using headers for tabular data
 * - Eliminating quotes and commas
 * 
 * Format spec: https://github.com/toon-format/toon
 */

import { GrokMessage, GrokMessageContent } from '../api/grokClient';

/**
 * Convert a value to TOON format
 */
export function toToon(value: unknown, indent = 0): string {
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
        // Escape special characters and handle multiline
        if (value.includes('\n') || value.includes(':') || value.includes('#')) {
            // Use quoted string for complex values
            return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        }
        // Simple strings don't need quotes in TOON
        if (/^[a-zA-Z0-9_.\-/]+$/.test(value) && value.length < 100) {
            return value;
        }
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '[]';
        }
        
        // Check if array of uniform objects (tabular data)
        if (value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))) {
            const allKeys = new Set<string>();
            value.forEach(item => Object.keys(item as object).forEach(k => allKeys.add(k)));
            const keys = Array.from(allKeys);
            
            // Use tabular format for uniform objects
            if (keys.length > 0 && keys.length <= 10) {
                const lines: string[] = [];
                lines.push(`${prefix}fields: ${keys.join(', ')}`);
                lines.push(`${prefix}rows: ${value.length}`);
                
                for (const item of value) {
                    const obj = item as Record<string, unknown>;
                    const rowValues = keys.map(k => {
                        const v = obj[k];
                        if (v === undefined || v === null) return '-';
                        if (typeof v === 'string' && v.includes(' ')) return `"${v}"`;
                        return String(v);
                    });
                    lines.push(`${prefix}${rowValues.join(' ')}`);
                }
                return lines.join('\n');
            }
        }
        
        // Standard array format
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

/**
 * Convert messages array to TOON format for API optimization
 */
export function messagesToToon(messages: GrokMessage[]): string {
    const lines: string[] = [];
    
    for (const msg of messages) {
        lines.push(`[${msg.role}]`);
        
        if (typeof msg.content === 'string') {
            // Preserve string content as-is (may contain important formatting)
            lines.push(msg.content);
        } else if (Array.isArray(msg.content)) {
            // Multimodal content
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    lines.push(part.text);
                } else if (part.type === 'image_url' && part.image_url) {
                    lines.push(`[image: ${part.image_url.url.substring(0, 50)}...]`);
                }
            }
        }
        
        lines.push('');
    }
    
    return lines.join('\n');
}

/**
 * Wrap content in TOON format with a header for the model
 */
export function wrapToonContent(content: string): string {
    return `[TOON Format - Compact data notation]\n${content}`;
}

/**
 * Convert a GrokMessage to use TOON-optimized content
 * Only converts user messages with structured data
 */
export function optimizeMessageContent(content: string | GrokMessageContent[]): string | GrokMessageContent[] {
    if (typeof content !== 'string') {
        // Keep multimodal content as-is
        return content;
    }
    
    // Try to detect and convert embedded JSON in the content
    const jsonPattern = /```json\s*([\s\S]*?)```/g;
    let optimized = content;
    let match;
    
    while ((match = jsonPattern.exec(content)) !== null) {
        try {
            const jsonData = JSON.parse(match[1]);
            const toonData = toToon(jsonData);
            optimized = optimized.replace(match[0], `\`\`\`toon\n${toonData}\n\`\`\``);
        } catch {
            // Not valid JSON, keep as-is
        }
    }
    
    return optimized;
}

/**
 * Get TOON system prompt addition for INPUT understanding
 */
export function getToonSystemPromptAddition(): string {
    return `
## TOON FORMAT UNDERSTANDING

You may receive data in TOON (Token-Oriented Object Notation) format, which is a compact alternative to JSON:
- Key-value pairs: \`key: value\` (no quotes needed for simple values)
- Objects use indentation instead of braces
- Arrays use \`- \` prefix for each item
- Tabular data uses \`fields:\` header followed by \`rows:\` count and space-separated values

Parse TOON data as you would parse YAML or JSON - the structure is equivalent.
`;
}

/**
 * Get TOON OUTPUT instructions - replaces JSON output format in system prompt
 */
export function getToonOutputPrompt(): string {
    return `
## OUTPUT FORMAT - TOON (Token-Oriented Object Notation)

You MUST respond in TOON format (NOT JSON). TOON is compact and token-efficient:

### TOON Rules:
- Key-value: \`key: value\` (no quotes for simple values)
- Nested objects: Use 2-space indentation
- Arrays: Use \`- \` prefix for each item
- Tabular arrays: Use \`fields:\` header + \`rows:\` count + space-separated data
- Strings with spaces/special chars: Use double quotes
- Booleans: true/false (lowercase)
- Multiline strings: Use \`|\` followed by indented lines

### Required Response Structure:
\`\`\`toon
summary: Brief 1-2 sentence summary of your response
sections:
  - heading: Section Title
    content: Plain text content for this section
    codeBlocks:
      - language: python
        code: |
          print('hello')
        caption: Example
todos:
  - text: "Step one description"
    completed: false
  - text: "Step two description"
    completed: false
fileChanges:
  - path: src/file.py
    language: python
    isDiff: true
    lineRange:
      start: 10
      end: 15
    content: |
      -old line
      +new line
commands:
  - command: npm test
    description: Run tests
nextSteps:
  - First action
  - Second action
\`\`\`

### Field Descriptions:
| Field | Required | Description |
|-------|----------|-------------|
| summary | YES | Brief 1-2 sentence summary |
| sections | no | Array with heading, content, optional codeBlocks |
| todos | no | Array of {text, completed} objects |
| fileChanges | no | Files to create/modify |
| commands | no | Terminal commands to run |
| nextSteps | no | Follow-up suggestions |

### Examples:

Simple answer:
\`\`\`toon
summary: Use a null check to fix the undefined error.
codeBlocks:
  - language: javascript
    code: |
      if (value !== null) {
        doSomething(value);
      }
    caption: Add null check
\`\`\`

File change (diff format):
\`\`\`toon
summary: Fixed the helper function.
fileChanges:
  - path: src/utils.py
    language: python
    isDiff: true
    lineRange:
      start: 5
      end: 7
    content: |
      def add(a, b):
      -    return a + b
      +    result = a + b
      +    return result
\`\`\`

## ⚠️ CRITICAL: EXACT CONTEXT LINES REQUIRED FOR DIFFS

**NEVER use placeholders or ellipsis in diffs.** The system applies diffs by matching exact text.

❌ WRONG - Diffs with placeholders WILL FAIL to apply:
\`\`\`
def settings():
    # ... existing code ...
+    new_line_here()
\`\`\`

❌ WRONG - Comment placeholders WILL FAIL:
\`\`\`
@app.route('/settings')
def settings():
    # ... existing body ...
+@app.route('/tasks')
\`\`\`

✅ CORRECT - Use EXACT lines from the file:
\`\`\`
@app.route('/settings')
def settings():
    if 'email' not in session:
        return redirect(url_for('login'))
+
+@app.route('/tasks')
+def tasks():
+    if 'email' not in session:
+        return redirect(url_for('login'))
\`\`\`

**Rules for context lines:**
1. Copy 2-3 EXACT lines from the file before/after your changes
2. NEVER use "...", "# existing code", "// rest of function", etc.
3. NEVER summarize or abbreviate existing code
4. If you don't know the exact lines, ask the user to share the file content first
5. Context lines MUST match the file exactly (including whitespace)

CRITICAL: Start your response directly with TOON content (summary: ...). No markdown fences around the entire response.
`;
}

/**
 * Parse TOON format back to JavaScript object
 */
export function fromToon(toonStr: string): unknown {
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
        // Remove quotes if present
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
            
            // Skip empty lines
            if (!trimmed) {
                index++;
                continue;
            }
            
            // If we've dedented, return to parent
            if (currentIndent < baseIndent) {
                break;
            }
            
            // Check for tabular data format
            if (trimmed.startsWith('fields:')) {
                const fields = trimmed.substring(7).split(',').map(f => f.trim());
                index++;
                
                // Expect rows: N
                const rowsLine = lines[index]?.trim();
                if (rowsLine?.startsWith('rows:')) {
                    const rowCount = parseInt(rowsLine.substring(5).trim(), 10);
                    index++;
                    
                    const tableData: unknown[] = [];
                    for (let r = 0; r < rowCount && index < lines.length; r++) {
                        const rowLine = lines[index]?.trim();
                        if (!rowLine) {
                            index++;
                            continue;
                        }
                        
                        // Parse space-separated values (respecting quotes)
                        const rowValues = parseRowValues(rowLine);
                        const rowObj: Record<string, unknown> = {};
                        fields.forEach((field, i) => {
                            rowObj[field] = rowValues[i] !== undefined ? parseValue(rowValues[i]) : null;
                        });
                        tableData.push(rowObj);
                        index++;
                    }
                    return tableData;
                }
            }
            
            // Check for array item
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
                        
                        // Check if it's a simple value or starts an object
                        if (itemContent.includes(':')) {
                            // Could be inline key:value or start of nested object
                            const colonPos = itemContent.indexOf(':');
                            const key = itemContent.substring(0, colonPos).trim();
                            const val = itemContent.substring(colonPos + 1).trim();
                            
                            index++;
                            const nestedObj: Record<string, unknown> = {};
                            nestedObj[key] = val ? parseValue(val) : parseBlock(arrIndent + 2);
                            
                            // Continue parsing more keys at same level
                            while (index < lines.length) {
                                const nextLine = lines[index];
                                const nextIndent = getIndent(nextLine);
                                const nextTrimmed = nextLine.trim();
                                
                                if (!nextTrimmed) {
                                    index++;
                                    continue;
                                }
                                
                                if (nextIndent <= arrIndent) break;
                                
                                if (nextTrimmed.includes(':') && !nextTrimmed.startsWith('- ')) {
                                    const nColonPos = nextTrimmed.indexOf(':');
                                    const nKey = nextTrimmed.substring(0, nColonPos).trim();
                                    const nVal = nextTrimmed.substring(nColonPos + 1).trim();
                                    
                                    if (nVal === '' || nVal === '|') {
                                        index++;
                                        if (nVal === '|') {
                                            nestedObj[nKey] = parseMultilineString(nextIndent);
                                        } else {
                                            nestedObj[nKey] = parseBlock(nextIndent + 2);
                                        }
                                    } else {
                                        nestedObj[nKey] = parseValue(nVal);
                                        index++;
                                    }
                                } else {
                                    break;
                                }
                            }
                            arr.push(nestedObj);
                        } else {
                            arr.push(parseValue(itemContent));
                            index++;
                        }
                    } else {
                        break;
                    }
                }
                return arr;
            }
            
            // Key: value pair
            if (trimmed.includes(':')) {
                const colonPos = trimmed.indexOf(':');
                const key = trimmed.substring(0, colonPos).trim();
                const val = trimmed.substring(colonPos + 1).trim();
                
                if (val === '' || val === '|') {
                    index++;
                    if (val === '|') {
                        result[key] = parseMultilineString(currentIndent);
                    } else {
                        result[key] = parseBlock(currentIndent + 2);
                    }
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
    
    function parseMultilineString(baseIndent: number): string {
        const strLines: string[] = [];
        while (index < lines.length) {
            const line = lines[index];
            const indent = getIndent(line);
            
            if (line.trim() === '') {
                strLines.push('');
                index++;
                continue;
            }
            
            if (indent <= baseIndent) break;
            
            strLines.push(line.substring(baseIndent + 2));
            index++;
        }
        return strLines.join('\n').trimEnd();
    }
    
    function parseRowValues(row: string): string[] {
        const values: string[] = [];
        let current = '';
        let inQuotes = false;
        let quoteChar = '';
        
        for (let i = 0; i < row.length; i++) {
            const char = row[i];
            
            if (!inQuotes && (char === '"' || char === "'")) {
                inQuotes = true;
                quoteChar = char;
                current += char;
            } else if (inQuotes && char === quoteChar) {
                inQuotes = false;
                current += char;
                quoteChar = '';
            } else if (!inQuotes && char === ' ') {
                if (current) {
                    values.push(current);
                    current = '';
                }
            } else {
                current += char;
            }
        }
        if (current) {
            values.push(current);
        }
        return values;
    }
    
    return parseBlock(0);
}

/**
 * Extract TOON content from markdown code fences if present
 */
export function extractToonContent(text: string): string {
    const trimmed = text.trim();
    
    // Check if starts with ```toon or ``` fence
    if (!trimmed.startsWith('```')) {
        return trimmed;
    }
    
    // Find the opening fence line end
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline === -1) {
        return trimmed;
    }
    
    // Get content after opening fence
    let content = trimmed.substring(firstNewline + 1);
    
    // Find the LAST ``` that's on its own line (closing fence)
    // This handles nested code blocks in the content
    const lines = content.split('\n');
    let lastFenceIndex = -1;
    
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim() === '```') {
            lastFenceIndex = i;
            break;
        }
    }
    
    if (lastFenceIndex !== -1) {
        // Remove the closing fence and everything after
        content = lines.slice(0, lastFenceIndex).join('\n');
    }
    
    return content.trim();
}

/**
 * Check if a string looks like TOON format
 */
export function looksLikeToon(text: string): boolean {
    const trimmed = text.trim();
    
    // Check if wrapped in toon fences
    if (trimmed.startsWith('```toon') || 
        (trimmed.startsWith('```') && trimmed.includes('summary:'))) {
        return true;
    }
    
    // TOON starts with a key: value, not with { or [
    // And must have summary: which is our required field
    return !trimmed.startsWith('{') && 
           !trimmed.startsWith('[') &&
           /^summary:\s*.+/m.test(trimmed);
}

/**
 * Convert TOON response to JSON for processing
 */
export function toonToJson(toonStr: string): string {
    try {
        const parsed = fromToon(toonStr);
        return JSON.stringify(parsed);
    } catch {
        return toonStr; // Return original if parsing fails
    }
}
