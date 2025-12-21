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
 * Get TOON system prompt addition
 */
export function getToonSystemPromptAddition(): string {
    return `
## TOON FORMAT UNDERSTANDING

You may receive data in TOON (Token-Oriented Object Notation) format, which is a compact alternative to JSON:
- Key-value pairs: \`key: value\` (no quotes needed for simple values)
- Objects use indentation instead of braces
- Arrays use \`- \` prefix for each item
- Tabular data uses \`fields:\` header followed by \`rows:\` count and space-separated values

Example TOON data:
\`\`\`toon
name: ProjectX
version: 1.0.0
dependencies:
  fields: name, version, required
  rows: 2
  react 18.2.0 true
  lodash 4.17.21 false
\`\`\`

Parse TOON data as you would parse YAML or JSON - the structure is equivalent.
`;
}
