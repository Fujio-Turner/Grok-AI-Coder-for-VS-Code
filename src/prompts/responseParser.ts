/**
 * Parser for Grok AI responses.
 * Handles JSON parsing with fallback for non-JSON responses.
 */

import { 
    GrokStructuredResponse, 
    validateResponse, 
    TodoItem, 
    FileChange, 
    TerminalCommand,
    Section,
    CodeBlock
} from './responseSchema';
import { safeParseJson, isHttpError, looksLikeJson } from './jsonHelper';
import { debug } from '../utils/logger';
import { looksLikeToon, fromToon, extractToonContent } from '../utils/toonConverter';

export { GrokStructuredResponse } from './responseSchema';

export interface ParseResult {
    success: boolean;
    structured?: GrokStructuredResponse;
    raw?: string;
    error?: string;
    wasRepaired?: boolean;
    wasTruncated?: boolean;
    truncatedFileChangesCount?: number;
}

/**
 * Attempts to parse the AI response as structured JSON or TOON.
 * Falls back to legacy parsing if parsing fails.
 */
export function parseGrokResponse(responseText: string): ParseResult {
    const trimmed = responseText.trim();
    
    // Quick check: is this an HTTP error?
    if (isHttpError(trimmed)) {
        debug('Response is an HTTP error, using legacy fallback');
        return {
            success: false,
            raw: responseText,
            error: 'HTTP error response'
        };
    }
    
    // Check if response is in TOON format first
    if (looksLikeToon(trimmed)) {
        debug('Response appears to be TOON format, attempting to parse');
        try {
            // Extract TOON content from markdown fences if present
            const toonContent = extractToonContent(trimmed);
            debug('Extracted TOON content', { 
                originalLength: trimmed.length, 
                extractedLength: toonContent.length,
                startsWithSummary: toonContent.startsWith('summary:')
            });
            
            const parsed = fromToon(toonContent);
            const validated = validateResponse(parsed);
            
            if (validated) {
                debug('Successfully parsed TOON response');
                return {
                    success: true,
                    structured: validated,
                    wasRepaired: false
                };
            } else {
                debug('TOON parsed but failed schema validation, trying JSON fallback');
            }
        } catch (err) {
            debug('TOON parsing failed, trying JSON fallback', { error: String(err) });
        }
    }
    
    // Check if response contains JSON anywhere (not just at start)
    // Look for our expected JSON structure markers - now includes "summary"
    const hasJsonMarkers = (trimmed.includes('"summary"') || trimmed.includes('"message"')) && 
                          (trimmed.includes('"todos"') || 
                           trimmed.includes('"commands"') || 
                           trimmed.includes('"nextSteps"') ||
                           trimmed.includes('"sections"') ||
                           trimmed.includes('"codeBlocks"') ||
                           trimmed.includes('"fileChanges"'));
    
    const containsJson = looksLikeJson(trimmed) || 
                        trimmed.includes('```json') ||
                        hasJsonMarkers ||
                        (trimmed.includes('{') && (trimmed.includes('"summary"') || trimmed.includes('"message"')));
    
    if (!containsJson) {
        debug('Response does not contain JSON structure, using legacy fallback');
        return {
            success: false,
            raw: responseText,
            error: 'Response is not JSON or TOON'
        };
    }
    
    // Try to parse JSON (with extraction and repair)
    const parseResult = safeParseJson(trimmed);
    
    if (parseResult) {
        const validated = validateResponse(parseResult.parsed);
        
        if (validated) {
            const wasTruncated = !!parseResult.truncatedFileChanges;
            debug('Successfully parsed structured response', { 
                wasRepaired: parseResult.wasRepaired,
                wasTruncated,
                truncatedFileChangesCount: parseResult.truncatedFileChanges?.length
            });
            return {
                success: true,
                structured: validated,
                wasRepaired: parseResult.wasRepaired,
                wasTruncated,
                truncatedFileChangesCount: parseResult.truncatedFileChanges?.length
            };
        } else {
            debug('JSON parsed but failed schema validation');
            return {
                success: false,
                raw: responseText,
                error: 'Response does not match expected schema'
            };
        }
    }
    
    debug('All JSON parse attempts failed, using legacy fallback');
    return {
        success: false,
        raw: responseText,
        error: 'Failed to parse JSON'
    };
}

/**
 * Converts a legacy markdown response to structured format.
 * This provides backward compatibility during migration.
 */
export function parseLegacyResponse(responseText: string): GrokStructuredResponse {
    const response: GrokStructuredResponse = {
        summary: responseText.split('\n')[0].substring(0, 200), // First line as summary
        message: responseText,
        todos: [],
        fileChanges: [],
        commands: []
    };

    // Extract TODOs from legacy format: 📋 TODOS\n- [ ] item
    const todoMatch = responseText.match(/📋\s*TODOS?\s*\n((?:- \[[ x]\] .+\n?)+)/i);
    if (todoMatch) {
        const todoLines = todoMatch[1].match(/- \[([ x])\] (.+)/g) || [];
        response.todos = todoLines.map(line => {
            const match = line.match(/- \[([ x])\] (.+)/);
            return {
                text: match?.[2] || line,
                completed: match?.[1] === 'x'
            };
        });
        // Remove from message
        if (response.message) {
            response.message = response.message.replace(todoMatch[0], '').trim();
        }
    }

    // Extract file changes from legacy format: 📄 filename\n```lang\ncontent\n```
    const filePattern = /[\u{1F4C4}\u{1F5CE}]\s*([^\s\n(]+)\s*(?:\(lines?\s*(\d+)(?:-(\d+))?\))?[\s\n]*```(\w+)?\n([\s\S]*?)```/gu;
    let fileMatch;
    while ((fileMatch = filePattern.exec(responseText)) !== null) {
        const [fullMatch, path, startLine, endLine, language, content] = fileMatch;
        
        const fileChange: FileChange = {
            path,
            language: language || 'text',
            content: content.trim(),
            isDiff: content.includes('\n-') && content.includes('\n+')
        };

        if (startLine) {
            fileChange.lineRange = {
                start: parseInt(startLine, 10),
                end: endLine ? parseInt(endLine, 10) : parseInt(startLine, 10)
            };
        }

        response.fileChanges!.push(fileChange);
        // Remove from message
        if (response.message) {
            response.message = response.message.replace(fullMatch, '').trim();
        }
    }

    // Extract terminal commands from legacy format: 🖥️ `command`
    const cmdPattern = /🖥️\s*`([^`]+)`/g;
    let cmdMatch;
    while ((cmdMatch = cmdPattern.exec(responseText)) !== null) {
        response.commands!.push({
            command: cmdMatch[1]
        });
        if (response.message) {
            response.message = response.message.replace(cmdMatch[0], '').trim();
        }
    }

    // Clean up multiple newlines in message
    if (response.message) {
        response.message = response.message.replace(/\n{3,}/g, '\n\n').trim();
    }

    return response;
}

/**
 * Main entry point: parse response with automatic fallback.
 */
export function parseResponse(responseText: string): GrokStructuredResponse {
    const result = parseGrokResponse(responseText);
    
    if (result.success && result.structured) {
        return result.structured;
    }
    
    // Fallback to legacy parsing
    debug('Using legacy parser fallback');
    return parseLegacyResponse(responseText);
}
