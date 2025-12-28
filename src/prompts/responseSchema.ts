/**
 * Structured response schema for Grok AI responses.
 * This defines the JSON format the AI returns, making parsing reliable
 * and project-agnostic.
 */

export interface TodoItem {
    text: string;
    aiText?: string;  // Verbose AI instructions (hidden from UI)
    completed: boolean;
}

export interface LineOperation {
    type: 'insert' | 'delete' | 'replace' | 'insertAfter' | 'insertBefore';
    line: number;              // 1-indexed line number
    expectedContent?: string;  // For delete/replace: what we expect to find (validation)
    newContent?: string;       // For insert/replace: what to add
}

export interface FileChange {
    path: string;
    language: string;
    content: string;
    lineRange?: {
        start: number;
        end: number;
    };
    isDiff?: boolean;
    // NEW: Safer line-level operations (preferred over content/isDiff)
    lineOperations?: LineOperation[];
}

export interface TerminalCommand {
    command: string;
    description?: string;
}

export interface NextStep {
    html: string;       // Display text shown on the button
    inputText: string;  // Text to insert into input when clicked
}

// Union type for backward compatibility - can be string or structured
export type NextStepItem = string | NextStep;

export interface CodeBlock {
    language: string;
    code: string;
    caption?: string;
}

export interface Section {
    heading: string;
    content: string;
    codeBlocks?: CodeBlock[];
}

export interface GrokStructuredResponse {
    todos?: TodoItem[];
    summary: string;
    sections?: Section[];
    codeBlocks?: CodeBlock[];
    fileChanges?: FileChange[];
    commands?: TerminalCommand[];
    nextSteps?: NextStepItem[];  // Can be string[] or NextStep[] (or mixed)
    // MD5 hashes of files the AI claims to have read (for verification)
    fileHashes?: Record<string, string>;
    // Legacy field - kept for backward compatibility
    message?: string;
}

/**
 * JSON Schema definition to include in the system prompt.
 * This tells the AI exactly what format to return.
 */
export const RESPONSE_JSON_SCHEMA = `{
  "summary": "Brief 1-2 sentence summary of your response",
  "sections": [
    {
      "heading": "Section Title",
      "content": "Plain text content for this section",
      "codeBlocks": [{ "language": "python", "code": "print('hello')", "caption": "Example" }]
    }
  ],
  "codeBlocks": [
    { "language": "python", "code": "def foo(): pass", "caption": "Optional caption" }
  ],
  "todos": [
    { "text": "Step description", "completed": false }
  ],
  "fileHashes": {
    "path/to/file.py": "md5_hash_of_file_content"
  },
  "fileChanges": [
    { "path": "src/file.py", "language": "python", "content": "-old line\\n+new line", "isDiff": true, "lineRange": { "start": 10, "end": 15 } }
  ],
  "commands": [
    { "command": "npm test", "description": "Run tests" }
  ],
  "nextSteps": [
    { "html": "Continue to next step", "inputText": "continue" },
    { "html": "Attach the config file", "inputText": "config.json" }
  ]
}`;

/**
 * Validates that a parsed response matches the expected schema.
 * Returns the validated response or null if invalid.
 */
export function validateResponse(parsed: unknown): GrokStructuredResponse | null {
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Either summary or message is required
    const hasSummary = typeof obj.summary === 'string';
    const hasMessage = typeof obj.message === 'string';
    
    if (!hasSummary && !hasMessage) {
        return null;
    }

    const response: GrokStructuredResponse = {
        summary: (obj.summary as string) || (obj.message as string) || '',
        message: obj.message as string | undefined
    };

    // Validate optional todos
    if (obj.todos !== undefined) {
        if (!Array.isArray(obj.todos)) {
            return null;
        }
        response.todos = obj.todos
            .filter((t): t is TodoItem => 
                typeof t === 'object' && t !== null &&
                typeof (t as TodoItem).text === 'string' &&
                typeof (t as TodoItem).completed === 'boolean'
            )
            .map(t => ({ ...t, text: t.text.trim() }))
            .filter(t => t.text.length > 0);
    }

    // Validate optional sections
    if (obj.sections !== undefined) {
        if (!Array.isArray(obj.sections)) {
            return null;
        }
        response.sections = obj.sections.filter((s): s is Section =>
            typeof s === 'object' && s !== null &&
            typeof (s as Section).heading === 'string' &&
            typeof (s as Section).content === 'string'
        );
    }

    // Validate optional codeBlocks
    if (obj.codeBlocks !== undefined) {
        if (!Array.isArray(obj.codeBlocks)) {
            return null;
        }
        response.codeBlocks = obj.codeBlocks.filter((c): c is CodeBlock =>
            typeof c === 'object' && c !== null &&
            typeof (c as CodeBlock).language === 'string' &&
            typeof (c as CodeBlock).code === 'string'
        );
    }

    // Validate optional fileChanges
    if (obj.fileChanges !== undefined) {
        if (!Array.isArray(obj.fileChanges)) {
            return null;
        }
        response.fileChanges = obj.fileChanges
            .filter((f): f is FileChange =>
                typeof f === 'object' && f !== null &&
                typeof (f as FileChange).path === 'string' &&
                (f as FileChange).path.trim().length > 0 && // Path must not be empty
                typeof (f as FileChange).content === 'string'
            )
            .map(f => {
                // Ensure path has extension - if missing and language hints at it, add it
                let path = f.path.trim();
                let lang = (f.language || '').trim().toLowerCase();
                const hasExtension = /\.[a-zA-Z0-9]+$/.test(path);
                
                // If language is empty but content suggests Python, infer it
                if (!lang && f.content) {
                    const contentLower = f.content.substring(0, 500).toLowerCase();
                    if (contentLower.includes('def ') || contentLower.includes('import ') || 
                        contentLower.includes('from ') || contentLower.includes('"""')) {
                        lang = 'python';
                    } else if (contentLower.includes('function ') || contentLower.includes('const ') ||
                               contentLower.includes('let ') || contentLower.includes('=>')) {
                        lang = 'javascript';
                    }
                }
                
                if (!hasExtension && lang) {
                    const extMap: Record<string, string> = {
                        'python': '.py', 'py': '.py',
                        'javascript': '.js', 'js': '.js',
                        'typescript': '.ts', 'ts': '.ts',
                        'json': '.json', 'markdown': '.md', 'yaml': '.yml',
                        'html': '.html', 'css': '.css', 'sql': '.sql'
                    };
                    const ext = extMap[lang];
                    if (ext) {
                        path = path + ext;
                    }
                }
                return { ...f, path, language: lang || 'text' };
            });
    }

    // Validate optional commands
    if (obj.commands !== undefined) {
        if (!Array.isArray(obj.commands)) {
            return null;
        }
        response.commands = obj.commands.filter((c): c is TerminalCommand =>
            typeof c === 'object' && c !== null &&
            typeof (c as TerminalCommand).command === 'string'
        );
    }

    // Validate optional nextSteps - supports both string[] and NextStep[] formats
    if (obj.nextSteps !== undefined) {
        if (!Array.isArray(obj.nextSteps)) {
            return null;
        }
        response.nextSteps = obj.nextSteps
            .map((s): NextStepItem | null => {
                // String format (legacy)
                if (typeof s === 'string') {
                    return s;
                }
                // Object format (preferred)
                if (typeof s === 'object' && s !== null) {
                    const step = s as Record<string, unknown>;
                    if (typeof step.html === 'string' && typeof step.inputText === 'string') {
                        return { html: step.html, inputText: step.inputText };
                    }
                }
                return null;
            })
            .filter((s): s is NextStepItem => s !== null);
    }

    // Validate optional fileHashes - map of file path to MD5 hash
    if (obj.fileHashes !== undefined) {
        if (typeof obj.fileHashes === 'object' && obj.fileHashes !== null && !Array.isArray(obj.fileHashes)) {
            const hashes: Record<string, string> = {};
            for (const [path, hash] of Object.entries(obj.fileHashes as Record<string, unknown>)) {
                if (typeof hash === 'string' && hash.length > 0) {
                    hashes[path] = hash;
                }
            }
            if (Object.keys(hashes).length > 0) {
                response.fileHashes = hashes;
            }
        }
    }

    return response;
}

/**
 * JSON Schema for xAI Structured Outputs API.
 * When passed as response_format, the API GUARANTEES responses match this schema.
 * This eliminates all JSON parsing/malformed response issues.
 * 
 * @see https://docs.x.ai/docs/guides/structured-outputs
 */
export const STRUCTURED_OUTPUT_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "grok_response",
        strict: true,
        schema: {
            type: "object",
            properties: {
                summary: {
                    type: "string",
                    description: "Brief 1-2 sentence summary of the response"
                },
                sections: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            heading: { type: "string", description: "Section title" },
                            content: { type: "string", description: "Plain text content" },
                            codeBlocks: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        language: { type: "string" },
                                        code: { type: "string" },
                                        caption: { type: "string" }
                                    },
                                    required: ["language", "code"],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["heading", "content"],
                        additionalProperties: false
                    }
                },
                codeBlocks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            language: { type: "string", description: "Programming language" },
                            code: { type: "string", description: "Code content" },
                            caption: { type: "string", description: "Optional caption" }
                        },
                        required: ["language", "code"],
                        additionalProperties: false
                    }
                },
                todos: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            text: { type: "string", description: "Task description" },
                            completed: { type: "boolean", description: "Whether task is done" }
                        },
                        required: ["text", "completed"],
                        additionalProperties: false
                    }
                },
                fileHashes: {
                    type: "object",
                    description: "MD5 hashes of files that were read, keyed by file path",
                    additionalProperties: { type: "string" }
                },
                fileChanges: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "File path relative to workspace" },
                            language: { type: "string", description: "Programming language" },
                            content: { type: "string", description: "New content or diff" },
                            isDiff: { type: "boolean", description: "If true, content is a unified diff" },
                            lineRange: {
                                type: "object",
                                properties: {
                                    start: { type: "integer", description: "Start line (1-indexed)" },
                                    end: { type: "integer", description: "End line (1-indexed)" }
                                },
                                required: ["start", "end"],
                                additionalProperties: false
                            },
                            lineOperations: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        type: { 
                                            type: "string", 
                                            enum: ["insert", "delete", "replace", "insertAfter", "insertBefore"]
                                        },
                                        line: { type: "integer", description: "1-indexed line number" },
                                        expectedContent: { type: "string", description: "Content expected at line (for validation)" },
                                        newContent: { type: "string", description: "New content to insert/replace" }
                                    },
                                    required: ["type", "line"],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["path", "content"],
                        additionalProperties: false
                    }
                },
                commands: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            command: { type: "string", description: "Terminal command to run" },
                            description: { type: "string", description: "What the command does" }
                        },
                        required: ["command"],
                        additionalProperties: false
                    }
                },
                nextSteps: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            html: { type: "string", description: "Button display text" },
                            inputText: { type: "string", description: "Text to insert when clicked" }
                        },
                        required: ["html", "inputText"],
                        additionalProperties: false
                    }
                }
            },
            required: ["summary"],
            additionalProperties: false
        }
    }
};
