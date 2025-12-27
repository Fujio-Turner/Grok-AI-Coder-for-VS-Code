/**
 * JSON Helper utilities for handling LLM responses.
 * Validates, repairs, and safely parses JSON from AI responses.
 */

// Use console.log for debug in tests (vscode not available)
const debug = (msg: string, ...args: unknown[]) => {
    if (typeof process !== 'undefined' && process.env.DEBUG_JSON) {
        console.log('[jsonHelper]', msg, ...args);
    }
};

export interface JsonValidationResult {
    isValid: boolean;
    parsed?: unknown;
    error?: string;
}

/**
 * Check if a string is valid JSON without throwing.
 */
export function isValidJson(text: string): JsonValidationResult {
    try {
        const parsed = JSON.parse(text);
        return { isValid: true, parsed };
    } catch (e) {
        return { 
            isValid: false, 
            error: e instanceof Error ? e.message : 'Unknown parse error'
        };
    }
}

/**
 * Check if a response looks like JSON (starts with { or [).
 */
export function looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
           (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

/**
 * Check if a response is an HTTP error message (not JSON from our AI).
 */
export function isHttpError(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('<!doctype html') ||
           lower.includes('<html') ||
           lower.includes('502 bad gateway') ||
           lower.includes('503 service unavailable') ||
           lower.includes('504 gateway timeout') ||
           lower.includes('internal server error') ||
           lower.includes('rate limit exceeded') ||
           lower.includes('unauthorized') ||
           lower.includes('forbidden');
}

/**
 * Extract JSON from a response that might have extra text before/after.
 */
export function extractJson(text: string): string | null {
    // Try to find JSON wrapped in markdown code blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
        const extracted = codeBlockMatch[1].trim();
        if (looksLikeJson(extracted)) {
            return extracted;
        }
    }

    // Find first { and last } for object
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return text.substring(firstBrace, lastBrace + 1);
    }

    // Find first [ and last ] for array
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        return text.substring(firstBracket, lastBracket + 1);
    }

    return null;
}

/**
 * Repair common JSON errors from LLM output.
 */
export function repairJson(jsonString: string): string {
    let repaired = jsonString;
    
    debug('Attempting JSON repair on:', jsonString.substring(0, 100) + '...');
    
    // FIX 0: Remove duplicate opening braces {{ -> {
    // AI sometimes starts with double braces
    repaired = repaired.replace(/^\s*\{\s*\{/, '{');
    
    // FIX -1: Fix missing opening quote before known keys at start of properties
    // Pattern: , sections": or { sections": -> , "sections": or { "sections":
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z]+)"\s*:/g, '$1"$2":');
    
    // FIX -2: Fix codeBlocks/sections/todos not being array: "key": { -> "key": [{
    // AI sometimes outputs object instead of array for array fields
    repaired = repaired.replace(/"(codeBlocks|sections|todos|fileChanges|commands|nextSteps)"\s*:\s*\{\s*"/g, '"$1": [{"');
    
    // FIX 0a: Fix missing colon after key before array/object: "sections" [ -> "sections": [
    // Common AI error where colon is omitted before [ or {
    repaired = repaired.replace(/"(sections|todos|fileChanges|commands|nextSteps|codeBlocks|lineRange)"\s*(\[|\{)/gi, '"$1": $2');
    
    // FIX 0b: Fix word concatenated with array key: "improvementssections":[ -> "improvements", "sections": [
    // AI sometimes omits ", " between value end and next key
    repaired = repaired.replace(/([a-z])(sections|todos|fileChanges|commands|nextSteps|codeBlocks)"\s*:\s*\[/gi, '$1", "$2": [');
    
    // FIX 0b2: Fix missing array bracket after sections: "sections":heading" -> "sections": [{"heading"
    // AI sometimes omits [{ between "sections": and "heading"
    // Handles: "sections":heading": or "sections": heading": or "sections":"heading":
    repaired = repaired.replace(/"sections"\s*:\s*"?heading"\s*:\s*/gi, '"sections": [{"heading": ');
    
    // FIX 0c: Fix missing opening [{ for array keys followed by object content
    // Pattern: "sections": "heading": -> "sections": [{"heading":
    repaired = repaired.replace(/"(sections|todos|fileChanges|commands|codeBlocks)"\s*:\s*"(heading|text|path|command|language)"\s*:/gi, '"$1": [{"$2":');
    
    // FIX 0d: (REMOVED - was incomplete, now handled by FIX 0d2)
    // Old: "summary\":value -> "summary": "value (but didn't add closing quote!)
    
    // FIX 0d2: Fix missing opening quote for string values after colon (CRITICAL)
    // Pattern: "content":Excellent text here.} -> "content": "Excellent text here."}
    // Pattern: "heading":Overview of the code, -> "heading": "Overview of the code",
    // This catches unquoted values that start with a letter
    // The value ends at: }, ], or ," (comma followed by quote for next key)
    // Must be careful to not match booleans (true/false) or null
    repaired = repaired.replace(
        /"(summary|heading|content|text|message|description)"\s*:\s*([A-Za-z][^"]*?)(,\s*"|}\]?|])/gi,
        (match, key, value, delim) => {
            const trimmedValue = value.trim();
            // Don't quote if it's a boolean or null
            if (['true', 'false', 'null'].includes(trimmedValue.toLowerCase())) {
                return `"${key}": ${trimmedValue.toLowerCase()}${delim}`;
            }
            // Handle the different delimiters
            return `"${key}": "${trimmedValue}"${delim}`;
        }
    );
    
    // FIX 0e: Fix missing colon with space: "content "value -> "content": "value
    repaired = repaired.replace(/"(summary|heading|content|text|message|path|command|description)"\s+"([^"]*?)"/gi, '"$1": "$2"');
    
    // FIX 0e2: Fix missing colon after key (space instead): "language "python" -> "language": "python"
    // Also handles: "code "print('hello')" -> "code": "print('hello')"
    repaired = repaired.replace(/"(language|code|caption|path|command|description)\s+"([^"]*?)"/gi, '"$1": "$2"');
    
    // FIRST: Fix unclosed key followed by quoted value: "heading "value" -> "heading": "value"
    // Must run before empty key fixes so we can properly detect section structure
    repaired = repaired.replace(/"(text|message|path|command|description|content|heading)\s+"([^"]*?)"/gi, '"$1": "$2"');
    
    // SECOND: Fix missing comma/quote after heading value: "heading": "Value "content": -> "heading": "Value", "content":
    // AI sometimes omits closing quote AND comma between heading value and content key
    // Pattern matches: "heading": "Value "content" where value is missing closing quote
    repaired = repaired.replace(/("heading"\s*:\s*"[^"]*)\s+"content"\s*:/g, '$1", "content":');
    
    // 0. Fix empty key for sections array: "summary": "...", "": [{"heading" -> "summary": "...", "sections": [{"heading"
    // AI sometimes outputs "" instead of "sections" for the sections array key
    repaired = repaired.replace(/,\s*""\s*:\s*\[\s*\{\s*"heading"/g, ', "sections": [{"heading"');
    
    // 0-alt. Fix empty key for heading in sections: {"": "Title", "content" -> {"heading": "Title", "content"
    // Must come FIRST - more specific than text rule (checks for "content" after)
    repaired = repaired.replace(/\{\s*""\s*:\s*"([^"]+)"\s*,\s*"content"/g, '{"heading": "$1", "content"');
    
    // 0a. Fix empty key for text in todos array: {"":"Fix..." -> {"text":"Fix..."
    // Must come before message fix - context: inside todos array after [ or },
    repaired = repaired.replace(/(\[|},)\s*\{\s*""\s*:\s*"/g, '$1{"text": "');
    
    // 0b. Fix empty key after heading -> content: "heading": "Title", "": "..." -> "heading": "Title", "content": "..."
    repaired = repaired.replace(/"heading"\s*:\s*"([^"]+)"\s*,\s*""\s*:\s*"/g, '"heading": "$1", "content": "');
    
    // 0b2. Fix codeBlocks outside section object: "content": "..."}, "codeBlocks" -> "content": "...", "codeBlocks"
    // AI sometimes closes section too early before codeBlocks
    repaired = repaired.replace(/("content"\s*:\s*"[^"]*")\s*\}\s*,\s*"codeBlocks"/g, '$1, "codeBlocks"');
    
    // 0b3. Fix missing section close after codeBlocks array: }]]} -> }]}]  (close section before array)
    // After fixing 0b2, section object may be missing closing brace
    repaired = repaired.replace(/("codeBlocks"\s*:\s*\[[^\]]*\])\s*\]\s*([,\}])/g, '$1}]$2');
    
    // 0c. Fix empty key for message (top-level): "": "# text" -> "message": "# text"
    repaired = repaired.replace(/""\s*:\s*"#/g, '"message": "#');
    repaired = repaired.replace(/""\s*:\s*"/g, '"message": "');
    
    // 1. Fix "text" concatenated with value (missing colon): "textValue" -> "text": "Value"
    repaired = repaired.replace(/"text([A-Z][^"]*?)"/g, '"text": "$1"');
    
    // 1d. Fix missing opening quote after colon for path/file values: "path":advanced_prep.py" -> "path": "advanced_prep.py"
    // This is a common LLM error where the opening quote is omitted
    // Match unquoted value that ends with a quote OR continues to comma/brace
    repaired = repaired.replace(/"(path|language)"\s*:\s*([a-zA-Z0-9_][a-zA-Z0-9_.\-/]*)"/g, '"$1": "$2"');
    // Also handle when followed by comma or closing brace (value never got closing quote)
    repaired = repaired.replace(/"(path|language)"\s*:\s*([a-zA-Z0-9_][a-zA-Z0-9_.\-/]*)\s*([,}])/g, '"$1": "$2"$3');
    
    // 1b. Fix "completed" concatenated with previous value: "valuecompleted":false -> "value", "completed": false
    // Pattern: word immediately followed by 'completed":'
    repaired = repaired.replace(/([a-z])completed"\s*:\s*(true|false)/gi, '$1", "completed": $2');
    
    // 1c. Fix missing comma + opening quote before key: ,completed" -> , "completed"
    repaired = repaired.replace(/,\s*(completed|text|message|path|command)"/gi, ', "$1"');
    
    // 2. Fix unquoted string values: "content":Excellent text here.} -> "content": "Excellent text here."}
    // Must capture the entire unquoted value up to }, ], or ,"
    // Use function replacement to avoid issues with $ in replacement string
    // Allow values starting with letters, digits, or # (for numbered lists like "1. First item")
    repaired = repaired.replace(/"(text|message|path|command|description|content|heading)"\s*:\s*([A-Za-z0-9#][^"}\]]*?)([}\],])/gi, 
        (_, key, value, delim) => `"${key}": "${value}"${delim}`);
    
    // 3. Fix missing } between array items: false { "text" -> false }, { "text"
    repaired = repaired.replace(/(true|false)\s+\{\s*"(text|completed)"/gi, '$1 }, { "$2"');
    
    // 3b. Fix "completed":falsetext": -> "completed": false }, { "text":
    // LLM sometimes omits }, { between array items
    repaired = repaired.replace(/(true|false)(text"\s*:)/gi, '$1 }, { "$2');
    
    // 4. Fix missing colon after any quoted key followed by space and value
    // Pattern: "key" value -> "key": value (for any key)
    // Must do this BEFORE escaping newlines in strings
    // Handle both "key" "value" and "key" value patterns
    repaired = repaired.replace(/"(text|message|todos|fileChanges|commands|nextSteps|path|language|content|command|description)"\s+"([^"]*?)"/gi, '"$1": "$2"');
    repaired = repaired.replace(/"(text|message|todos|fileChanges|commands|nextSteps|path|language|content|command|description)"\s+([{\[\w#])/gi, '"$1": $2');
    
    // 4b. Fix unclosed key followed by quoted value: "text "value" -> "text": "value"
    // LLM sometimes forgets the closing quote on the key
    repaired = repaired.replace(/"(text|message|path|command|description|content|heading)\s+"([^"]*?)"/gi, '"$1": "$2"');
    
    // 5. Fix empty values: "completed": } or "completed": , -> "completed": false
    repaired = repaired.replace(/"(completed|done|checked|status)"\s*:\s*([},\]])/gi, '"$1": false$2');
    
    // 2. Fix missing colon before booleans: "completed" false -> "completed": false
    repaired = repaired.replace(/"(completed|status|done|checked)"\s+(true|false)/gi, '"$1": $2');
    
    // 3. Fix array items missing closing brace before ] or ,
    // Pattern: "completed": false ] -> "completed": false } ]
    // Look for todo items that are missing their closing brace
    repaired = repaired.replace(/("completed"\s*:\s*(?:true|false))\s*([,\]])/gi, (match, comp, ending) => {
        // Check if there's already a } before the ending
        if (match.includes('}')) {
            return match;
        }
        return `${comp} }${ending}`;
    });
    
    // 4. Fix literal newlines inside JSON strings (most common LLM error)
    // This is tricky - we need to find strings and escape newlines within them
    repaired = repaired.replace(/"([^"]*?)"/g, (match, content) => {
        // Escape literal newlines, carriage returns, and tabs
        const escaped = content
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        return `"${escaped}"`;
    });
    
    // 5. Fix missing quotes after colons for string values: "key":unquoted value, -> "key": "unquoted value",
    // Only match when the value is an unquoted word (not starting with ", [, {, or digit)
    repaired = repaired.replace(/"([^"]+)":\s*([A-Za-z][A-Za-z0-9_\- ]*)\s*([,}\]])/g, (match, key, value, ending) => {
        const trimmed = value.trim();
        // Don't quote if it's a boolean or null
        if (['true', 'false', 'null'].includes(trimmed.toLowerCase())) {
            return `"${key}": ${trimmed.toLowerCase()}${ending}`;
        }
        // Quote the unquoted string value
        return `"${key}": "${trimmed}"${ending}`;
    });
    
    // 10. Fix missing opening brace before "text": in arrays
    // Pattern: }, "text": -> }, { "text":
    repaired = repaired.replace(/\},\s*"text"\s*:/g, '}, { "text":');
    
    // Also fix: [ "text": -> [ { "text":
    repaired = repaired.replace(/\[\s*"text"\s*:/g, '[ { "text":');
    
    // Also fix standalone "text": after array items missing }
    // Pattern: false, "text": -> false }, { "text":
    repaired = repaired.replace(/(true|false)\s*,\s*"text"\s*:/gi, '$1 }, { "text":');
    
    // 7. Fix missing quote at start of value: "text":value" -> "text": "value"
    // Only match if there's actual content between : and the trailing quote (not just whitespace)
    repaired = repaired.replace(/"text"\s*:\s*([A-Za-z][^"]+)"/g, '"text": "$1"');
    
    // 8. Fix empty keys - remove objects with empty keys
    repaired = repaired.replace(/\{\s*""\s*:\s*"[^"]*"[^}]*\}/g, '');
    
    // 9. Fix unclosed objects before comma or bracket
    repaired = repaired.replace(
        /\{\s*"text"\s*:\s*"[^"]*"\s*,\s*"completed"\s*:\s*(true|false)\s*(?=[,\]])/gi,
        (match) => {
            if (!match.trim().endsWith('}')) {
                return match.trim() + ' }';
            }
            return match;
        }
    );
    
    // 7. Clean up resulting issues
    // Remove double commas
    repaired = repaired.replace(/,\s*,+/g, ',');
    // Remove comma before closing bracket/brace
    repaired = repaired.replace(/,\s*([\]}])/g, '$1');
    // Remove comma after opening bracket/brace
    repaired = repaired.replace(/([\[{])\s*,/g, '$1');
    // Remove empty objects/arrays from arrays
    repaired = repaired.replace(/,\s*\{\s*\}/g, '');
    repaired = repaired.replace(/\{\s*\}\s*,/g, '');
    
    // 8. Fix trailing content after JSON
    const lastBrace = repaired.lastIndexOf('}');
    if (lastBrace !== -1 && lastBrace < repaired.length - 1) {
        const afterBrace = repaired.substring(lastBrace + 1).trim();
        if (afterBrace && !afterBrace.startsWith(',') && !afterBrace.startsWith(']')) {
            repaired = repaired.substring(0, lastBrace + 1);
        }
    }
    
    debug('Repaired JSON:', repaired.substring(0, 100) + '...');
    
    return repaired;
}

/**
 * Attempt to recover complete fileChanges entries from a truncated JSON response.
 * Returns an array of complete fileChange objects that were parsed before truncation.
 */
export function recoverTruncatedFileChanges(text: string): { path: string; content: string; language?: string; isDiff?: boolean }[] {
    const recovered: { path: string; content: string; language?: string; isDiff?: boolean }[] = [];
    
    // Find the fileChanges array
    const fileChangesMatch = text.match(/"fileChanges"\s*:\s*\[/);
    if (!fileChangesMatch) {
        return recovered;
    }
    
    const startIdx = fileChangesMatch.index! + fileChangesMatch[0].length;
    
    // Extract individual fileChange objects using a more robust pattern
    // Match complete objects: {"path": "...", "language": "...", "content": "...", "isDiff": ...}
    const fileChangePattern = /\{\s*"path"\s*:\s*"([^"]+)"\s*,\s*"language"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*(?:,\s*"isDiff"\s*:\s*(true|false))?\s*\}/g;
    
    let match;
    while ((match = fileChangePattern.exec(text)) !== null) {
        try {
            const [, path, language, content, isDiff] = match;
            // Validate that this is a complete entry (content should end properly)
            if (path && content !== undefined) {
                recovered.push({
                    path,
                    language: language || 'text',
                    content: content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\'),
                    isDiff: isDiff === 'true'
                });
                debug(`Recovered fileChange: ${path}`);
            }
        } catch (e) {
            debug(`Failed to recover fileChange: ${e}`);
        }
    }
    
    if (recovered.length > 0) {
        debug(`Recovered ${recovered.length} complete fileChanges from truncated response`);
    }
    
    return recovered;
}

/**
 * Recover all useful fields from a truncated JSON response.
 * Extracts summary, todos, nextSteps, commands, and fileChanges.
 */
export function recoverTruncatedResponse(text: string): {
    summary?: string;
    todos?: { text: string; completed: boolean }[];
    nextSteps?: Array<{ html: string; inputText: string } | string>;
    commands?: { command: string; description?: string }[];
    fileChanges?: { path: string; content: string; language?: string; isDiff?: boolean }[];
} {
    const result: ReturnType<typeof recoverTruncatedResponse> = {};
    
    // Extract summary - look for "summary": "..." pattern
    const summaryMatch = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (summaryMatch) {
        result.summary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        debug('Recovered summary from truncated response');
    }
    
    // Extract todos array - look for complete todo objects
    const todoPattern = /\{\s*"text"\s*:\s*"([^"]+)"\s*,\s*"completed"\s*:\s*(true|false)\s*\}/g;
    const todos: { text: string; completed: boolean }[] = [];
    let todoMatch;
    while ((todoMatch = todoPattern.exec(text)) !== null) {
        todos.push({
            text: todoMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
            completed: todoMatch[2] === 'true'
        });
    }
    if (todos.length > 0) {
        result.todos = todos;
        debug(`Recovered ${todos.length} todos from truncated response`);
    }
    
    // Extract nextSteps - look for complete nextStep objects (new structured format)
    const nextStepPattern = /\{\s*"html"\s*:\s*"([^"]+)"\s*,\s*"inputText"\s*:\s*"([^"]+)"\s*\}/g;
    const nextSteps: Array<{ html: string; inputText: string }> = [];
    let nextStepMatch;
    while ((nextStepMatch = nextStepPattern.exec(text)) !== null) {
        nextSteps.push({
            html: nextStepMatch[1].replace(/\\"/g, '"'),
            inputText: nextStepMatch[2].replace(/\\"/g, '"')
        });
    }
    if (nextSteps.length > 0) {
        result.nextSteps = nextSteps;
        debug(`Recovered ${nextSteps.length} nextSteps from truncated response`);
    }
    
    // Extract commands - look for complete command objects
    const commandPattern = /\{\s*"command"\s*:\s*"([^"]+)"(?:\s*,\s*"description"\s*:\s*"([^"]*)")?\s*\}/g;
    const commands: { command: string; description?: string }[] = [];
    let commandMatch;
    while ((commandMatch = commandPattern.exec(text)) !== null) {
        commands.push({
            command: commandMatch[1].replace(/\\"/g, '"'),
            description: commandMatch[2]?.replace(/\\"/g, '"')
        });
    }
    if (commands.length > 0) {
        result.commands = commands;
        debug(`Recovered ${commands.length} commands from truncated response`);
    }
    
    // Extract fileChanges using existing function
    const fileChanges = recoverTruncatedFileChanges(text);
    if (fileChanges.length > 0) {
        result.fileChanges = fileChanges;
    }
    
    return result;
}

export interface SafeParseResult {
    parsed: unknown;
    wasRepaired: boolean;
    truncatedFileChanges?: { path: string; content: string; language?: string; isDiff?: boolean }[];
    recoveryInfo?: {
        fileCount: number;
        todoCount: number;
        nextStepCount: number;
        commandCount: number;
        hadOriginalSummary: boolean;
    };
}

/**
 * Safely parse JSON with validation, extraction, and repair.
 * Returns parsed object or null if all attempts fail.
 */
export function safeParseJson(text: string): SafeParseResult | null {
    // Step 1: Check if it's an HTTP error
    if (isHttpError(text)) {
        debug('Response appears to be an HTTP error, not JSON');
        return null;
    }
    
    // Step 2: Try direct parse first
    const directResult = isValidJson(text.trim());
    if (directResult.isValid) {
        debug('Direct JSON parse succeeded');
        return { parsed: directResult.parsed, wasRepaired: false };
    }
    
    // Step 3: Try to extract JSON from the text
    const extracted = extractJson(text);
    if (extracted) {
        const extractedResult = isValidJson(extracted);
        if (extractedResult.isValid) {
            debug('Extracted JSON parse succeeded');
            return { parsed: extractedResult.parsed, wasRepaired: false };
        }
        
        // Step 4: Try to repair the extracted JSON
        const repaired = repairJson(extracted);
        const repairedResult = isValidJson(repaired);
        if (repairedResult.isValid) {
            debug('Repaired JSON parse succeeded');
            return { parsed: repairedResult.parsed, wasRepaired: true };
        }
    }
    
    // Step 5: Try repair on original text as last resort
    const repairedOriginal = repairJson(text);
    const repairedOriginalResult = isValidJson(repairedOriginal);
    if (repairedOriginalResult.isValid) {
        debug('Repaired original text parse succeeded');
        return { parsed: repairedOriginalResult.parsed, wasRepaired: true };
    }
    
    // Step 6: If all else fails, try to recover ALL useful fields from truncated response
    const recovered = recoverTruncatedResponse(text);
    const hasRecoveredContent = recovered.fileChanges?.length || recovered.todos?.length || 
                                recovered.nextSteps?.length || recovered.commands?.length || recovered.summary;
    
    if (hasRecoveredContent) {
        const counts = [
            recovered.fileChanges?.length ? `${recovered.fileChanges.length} files` : '',
            recovered.todos?.length ? `${recovered.todos.length} todos` : '',
            recovered.nextSteps?.length ? `${recovered.nextSteps.length} next steps` : '',
            recovered.commands?.length ? `${recovered.commands.length} commands` : ''
        ].filter(Boolean).join(', ');
        debug(`Recovered from truncated response: ${counts}`);
        
        // Build a complete response with all recovered fields
        const parsedResponse: Record<string, unknown> = {};
        
        // Use original summary if recovered, otherwise indicate truncation
        if (recovered.summary) {
            parsedResponse.summary = recovered.summary + ' ⚠️ (response was truncated)';
        } else {
            parsedResponse.summary = 'Response was truncated - partial content recovered';
        }
        
        if (recovered.todos?.length) parsedResponse.todos = recovered.todos;
        if (recovered.nextSteps?.length) parsedResponse.nextSteps = recovered.nextSteps;
        if (recovered.commands?.length) parsedResponse.commands = recovered.commands;
        if (recovered.fileChanges?.length) parsedResponse.fileChanges = recovered.fileChanges;
        
        return { 
            parsed: parsedResponse, 
            wasRepaired: true,
            truncatedFileChanges: recovered.fileChanges,
            recoveryInfo: {
                fileCount: recovered.fileChanges?.length || 0,
                todoCount: recovered.todos?.length || 0,
                nextStepCount: recovered.nextSteps?.length || 0,
                commandCount: recovered.commands?.length || 0,
                hadOriginalSummary: !!recovered.summary
            }
        };
    }
    
    debug('All JSON parse attempts failed');
    return null;
}
