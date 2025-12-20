/**
 * JSON Cleaner - Optional pass using fast model to fix malformed JSON.
 * 
 * When regex-based repair fails, send the broken JSON to the fast model
 * with explicit instructions to fix it and return valid JSON.
 */

import { sendChatCompletion, GrokMessage } from '../api/grokClient';
import { safeParseJson, isHttpError } from './jsonHelper';
import { validateResponse, GrokStructuredResponse } from './responseSchema';
import { debug, info, error as logError } from '../utils/logger';

const JSON_CLEANUP_PROMPT = `You are a JSON repair assistant. Your ONLY job is to fix malformed JSON and return valid JSON.

The user will provide broken JSON from an AI response. Fix ALL syntax errors and return ONLY the corrected JSON.

Common issues to fix:
1. Missing colons after keys: "key" "value" -> "key": "value"
2. Missing commas between properties: "a": 1 "b": 2 -> "a": 1, "b": 2
3. Missing quotes around string values: "key": value -> "key": "value"
4. Unclosed strings, objects, or arrays
5. Trailing commas before } or ]
6. Empty keys "" that should be "heading", "content", "text", or "message"

CRITICAL RULES:
- Return ONLY valid JSON, nothing else
- Start with { and end with }
- Preserve all the data - don't remove content
- If the structure has sections with heading/content, keep that structure
- Ensure all arrays and objects are properly closed

Return ONLY the fixed JSON, no explanation.`;

export interface CleanupResult {
    success: boolean;
    cleaned?: GrokStructuredResponse;
    rawCleaned?: string;
    error?: string;
    usedCleanup: boolean;
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
    
    // First, try our regex repair
    const regexResult = safeParseJson(brokenJson);
    if (regexResult) {
        const validated = validateResponse(regexResult.parsed);
        if (validated) {
            debug('Regex repair succeeded');
            return {
                success: true,
                cleaned: validated,
                usedCleanup: false
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
                    usedCleanup: true
                };
            }
        }

        // Model response also failed to parse
        logError('Model cleanup returned invalid JSON');
        return {
            success: false,
            error: 'Model cleanup returned invalid JSON',
            rawCleaned: cleanedText,
            usedCleanup: true
        };

    } catch (err: any) {
        logError('Model cleanup error:', err);
        return {
            success: false,
            error: err.message,
            usedCleanup: true
        };
    }
}

/**
 * Parse response with optional model cleanup fallback.
 */
export async function parseWithCleanup(
    responseText: string,
    apiKey?: string,
    fastModel?: string,
    enableCleanup: boolean = true
): Promise<{ structured: GrokStructuredResponse | null; usedCleanup: boolean }> {
    
    // Quick check for HTTP errors
    if (isHttpError(responseText)) {
        return { structured: null, usedCleanup: false };
    }

    // Try regex-based parsing first
    const regexResult = safeParseJson(responseText);
    if (regexResult) {
        const validated = validateResponse(regexResult.parsed);
        if (validated) {
            return { structured: validated, usedCleanup: false };
        }
    }

    // If cleanup is enabled and we have credentials, try model cleanup
    if (enableCleanup && apiKey && fastModel) {
        const cleanupResult = await cleanJsonWithModel(responseText, apiKey, fastModel);
        if (cleanupResult.success && cleanupResult.cleaned) {
            return { structured: cleanupResult.cleaned, usedCleanup: true };
        }
    }

    return { structured: null, usedCleanup: false };
}
