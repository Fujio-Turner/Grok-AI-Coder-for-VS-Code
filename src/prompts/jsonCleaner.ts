/**
 * JSON/TOON Cleaner - Optional pass using fast model to fix malformed responses.
 * 
 * When regex-based repair fails, send the broken JSON/TOON to the fast model
 * with explicit instructions to fix it and return valid JSON.
 */

import { sendChatCompletion, GrokMessage } from '../api/grokClient';
import { safeParseJson, isHttpError } from './jsonHelper';
import { validateResponse, GrokStructuredResponse } from './responseSchema';
import { debug, info, error as logError } from '../utils/logger';
import { extractToonContent, fromToon, looksLikeToon } from '../utils/toonConverter';

const JSON_CLEANUP_PROMPT = `You are a JSON repair assistant. Your ONLY job is to fix malformed JSON and return valid JSON.

The user will provide broken JSON from an AI response. Fix ALL syntax errors and return ONLY the corrected JSON.

Common issues to fix:
1. Missing colons after keys: "key" "value" -> "key": "value"
2. Missing commas between properties: "a": 1 "b": 2 -> "a": 1, "b": 2
3. Missing quotes around string values: "key": value -> "key": "value"
4. Unclosed strings, objects, or arrays
5. Trailing commas before } or ]
6. Empty keys "" that should be "heading", "content", "text", "message", or "sections"

CRITICAL RULES:
- Return ONLY valid JSON, nothing else
- Start with { and end with }
- Preserve all the data - don't remove content
- If the structure has sections with heading/content, keep that structure
- Ensure all arrays and objects are properly closed

Return ONLY the fixed JSON, no explanation.`;

const TOON_TO_JSON_PROMPT = `You are a TOON-to-JSON converter. Convert the malformed TOON (Token-Oriented Object Notation) to valid JSON.

TOON is a compact format like YAML:
- Key-value: \`key: value\` (no quotes for simple values)
- Objects use indentation
- Arrays use \`- \` prefix
- Tabular data uses \`fields:\` + \`rows:\` format
- Multiline strings use \`|\` followed by indented content

The response uses this schema:
{
  "summary": "string (required)",
  "sections": [{"heading": "string", "content": "string", "codeBlocks": [...]}],
  "todos": [{"text": "string", "completed": boolean}],
  "fileChanges": [{"path": "string", "language": "string", "content": "string", "isDiff": boolean}],
  "commands": [{"command": "string", "description": "string"}],
  "nextSteps": ["string"]
}

CRITICAL RULES:
- Return ONLY valid JSON, nothing else
- Start with { and end with }
- Preserve ALL the data - don't remove content
- Convert TOON structure to proper JSON
- Extract summary value correctly (first key in TOON)
- Convert tabular todos (fields/rows format) to array of {text, completed} objects
- Handle multiline content (after |) as string values

Return ONLY the converted JSON, no explanation or markdown fences.`;

export interface CleanupResult {
    success: boolean;
    cleaned?: GrokStructuredResponse;
    rawCleaned?: string;
    error?: string;
    usedCleanup: boolean;
    timeMs?: number;
    tokensIn?: number;
    tokensOut?: number;
}

/**
 * Attempt to clean malformed JSON using the fast model.
 */
export async function cleanJsonWithModel(
    brokenJson: string,
    apiKey: string,
    fastModel: string
): Promise<CleanupResult> {
    debug('Attempting JSON cleanup with model...');
    const startTime = Date.now();
    
    // First, try our regex repair
    const regexResult = safeParseJson(brokenJson);
    if (regexResult) {
        const validated = validateResponse(regexResult.parsed);
        if (validated) {
            debug('Regex repair succeeded');
            return {
                success: true,
                cleaned: validated,
                usedCleanup: false,
                timeMs: Date.now() - startTime
            };
        }
    }
    
    // Regex failed, try the model
    info('Regex repair failed, using model cleanup...');
    
    try {
        const messages: GrokMessage[] = [
            { role: 'system', content: JSON_CLEANUP_PROMPT },
            { role: 'user', content: `Fix this broken JSON:\n\n${brokenJson}` }
        ];

        const response = await sendChatCompletion(
            messages,
            fastModel,
            apiKey,
            undefined,
            undefined
        );

        const cleanedText = response.text.trim();
        debug('Model cleanup response length:', cleanedText.length);

        const tokensIn = response.usage?.promptTokens || 0;
        const tokensOut = response.usage?.completionTokens || 0;

        // Try to parse the cleaned response
        const parseResult = safeParseJson(cleanedText);
        if (parseResult) {
            const validated = validateResponse(parseResult.parsed);
            if (validated) {
                info('Model cleanup succeeded');
                return {
                    success: true,
                    cleaned: validated,
                    rawCleaned: cleanedText,
                    usedCleanup: true,
                    timeMs: Date.now() - startTime,
                    tokensIn,
                    tokensOut
                };
            }
        }

        // Model response also failed to parse
        logError('Model cleanup returned invalid JSON');
        return {
            success: false,
            error: 'Model cleanup returned invalid JSON',
            rawCleaned: cleanedText,
            usedCleanup: true,
            timeMs: Date.now() - startTime,
            tokensIn,
            tokensOut
        };

    } catch (err: any) {
        logError('Model cleanup error:', err);
        return {
            success: false,
            error: err.message,
            usedCleanup: true,
            timeMs: Date.now() - startTime
        };
    }
}

/**
 * Attempt to clean malformed TOON using the fast model (converts to JSON).
 */
export async function cleanToonWithModel(
    brokenToon: string,
    apiKey: string,
    fastModel: string
): Promise<CleanupResult> {
    debug('Attempting TOON cleanup with model...');
    const startTime = Date.now();
    
    // First, extract TOON content from markdown fences
    const toonContent = extractToonContent(brokenToon);
    
    // Try our TOON parser first
    try {
        const parsed = fromToon(toonContent);
        const validated = validateResponse(parsed);
        if (validated) {
            debug('TOON parser succeeded');
            return {
                success: true,
                cleaned: validated,
                usedCleanup: false,
                timeMs: Date.now() - startTime
            };
        }
    } catch (err) {
        debug('TOON parser failed:', err);
    }
    
    // TOON parser failed, use model to convert to JSON
    info('TOON parser failed, using model to convert to JSON...');
    
    try {
        const messages: GrokMessage[] = [
            { role: 'system', content: TOON_TO_JSON_PROMPT },
            { role: 'user', content: `Convert this TOON to valid JSON:\n\n${toonContent}` }
        ];

        const response = await sendChatCompletion(
            messages,
            fastModel,
            apiKey,
            undefined,
            undefined
        );

        const cleanedText = response.text.trim();
        debug('TOON cleanup response length:', cleanedText.length);

        const tokensIn = response.usage?.promptTokens || 0;
        const tokensOut = response.usage?.completionTokens || 0;

        // Try to parse the JSON response
        const parseResult = safeParseJson(cleanedText);
        if (parseResult) {
            const validated = validateResponse(parseResult.parsed);
            if (validated) {
                info('TOON-to-JSON cleanup succeeded');
                return {
                    success: true,
                    cleaned: validated,
                    rawCleaned: cleanedText,
                    usedCleanup: true,
                    timeMs: Date.now() - startTime,
                    tokensIn,
                    tokensOut
                };
            }
        }

        // Model response also failed to parse
        logError('TOON cleanup returned invalid JSON');
        return {
            success: false,
            error: 'TOON cleanup returned invalid JSON',
            rawCleaned: cleanedText,
            usedCleanup: true,
            timeMs: Date.now() - startTime,
            tokensIn,
            tokensOut
        };

    } catch (err: any) {
        logError('TOON cleanup error:', err);
        return {
            success: false,
            error: err.message,
            usedCleanup: true,
            timeMs: Date.now() - startTime
        };
    }
}

export interface ParseWithCleanupResult {
    structured: GrokStructuredResponse | null;
    usedCleanup: boolean;
    wasTruncated?: boolean;
    truncatedFileChangesCount?: number;
    cleanupMetrics?: {
        timeMs: number;
        tokensIn: number;
        tokensOut: number;
    };
}

/**
 * Parse response with optional model cleanup fallback.
 * Handles both JSON and TOON formats.
 */
export async function parseWithCleanup(
    responseText: string,
    apiKey?: string,
    fastModel?: string,
    enableCleanup: boolean = true
): Promise<ParseWithCleanupResult> {
    
    // Quick check for HTTP errors
    if (isHttpError(responseText)) {
        return { structured: null, usedCleanup: false };
    }

    // Check if this is a TOON response first
    if (looksLikeToon(responseText)) {
        debug('Detected TOON format, attempting TOON parsing...');
        
        // Try local TOON parsing first
        try {
            const toonContent = extractToonContent(responseText);
            const parsed = fromToon(toonContent);
            const validated = validateResponse(parsed);
            if (validated) {
                debug('Local TOON parsing succeeded');
                return { 
                    structured: validated, 
                    usedCleanup: false
                };
            }
        } catch (err) {
            debug('Local TOON parsing failed:', err);
        }
        
        // If cleanup enabled, use model to convert TOON to JSON
        if (enableCleanup && apiKey && fastModel) {
            debug('Local TOON parsing failed, attempting model cleanup...');
            const cleanupResult = await cleanToonWithModel(responseText, apiKey, fastModel);
            debug('Model cleanup result:', { success: cleanupResult.success, usedCleanup: cleanupResult.usedCleanup, error: cleanupResult.error });
            if (cleanupResult.success && cleanupResult.cleaned) {
                return { 
                    structured: cleanupResult.cleaned, 
                    usedCleanup: cleanupResult.usedCleanup,
                    cleanupMetrics: cleanupResult.usedCleanup ? {
                        timeMs: cleanupResult.timeMs || 0,
                        tokensIn: cleanupResult.tokensIn || 0,
                        tokensOut: cleanupResult.tokensOut || 0
                    } : undefined
                };
            } else {
                logError('TOON model cleanup failed:', cleanupResult.error || 'Unknown error');
            }
        } else {
            debug('Cleanup not attempted:', { enableCleanup, hasApiKey: !!apiKey, hasFastModel: !!fastModel });
        }
    }

    // Try JSON parsing (regex-based)
    const regexResult = safeParseJson(responseText);
    if (regexResult) {
        const validated = validateResponse(regexResult.parsed);
        if (validated) {
            const wasTruncated = !!regexResult.truncatedFileChanges;
            return { 
                structured: validated, 
                usedCleanup: false,
                wasTruncated,
                truncatedFileChangesCount: regexResult.truncatedFileChanges?.length
            };
        }
    }

    // If cleanup is enabled and we have credentials, try model cleanup for JSON
    if (enableCleanup && apiKey && fastModel) {
        const cleanupResult = await cleanJsonWithModel(responseText, apiKey, fastModel);
        if (cleanupResult.success && cleanupResult.cleaned) {
            return { 
                structured: cleanupResult.cleaned, 
                usedCleanup: true,
                cleanupMetrics: cleanupResult.usedCleanup ? {
                    timeMs: cleanupResult.timeMs || 0,
                    tokensIn: cleanupResult.tokensIn || 0,
                    tokensOut: cleanupResult.tokensOut || 0
                } : undefined
            };
        }
    }

    return { structured: null, usedCleanup: false };
}
