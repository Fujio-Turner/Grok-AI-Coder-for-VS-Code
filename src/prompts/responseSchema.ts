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
    line: number;              // 1-indexed line number (start of range)
    endLine?: number;          // 1-indexed end line (inclusive) for range operations
    expectedContent?: string;  // For delete/replace: what we expect to find (validation)
                               // For ranges: expected content of FIRST line (or all lines joined with \n)
    newContent?: string;       // For insert/replace: what to add (use \n for multiple lines)
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
    // Links this file change to a TODO item (0-indexed into todos array)
    todoIndex?: number;
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

export interface DirectoryRequest {
    path: string;        // Directory path relative to workspace root
    recursive?: boolean; // Include subdirectories (default: false)
    filter?: string;     // Optional glob filter (e.g., '*.ts')
}

export interface FileSearchRequest {
    pattern: string;     // Glob pattern (e.g., '**/config.json') or filename (e.g., 'app.js')
    reason: string;      // Why the AI needs this file - shown to user if not found
    maxResults?: number; // Max files to return (default: 5)
    autoAttach?: boolean; // If true, automatically attach found files (default: true)
}

export interface SubTaskRequest {
    id: string;              // Unique ID for tracking
    goal: string;            // Clear description of what to accomplish
    files?: string[];        // Files to attach to sub-task context
    dependencies?: string[]; // IDs of sub-tasks that must complete first
    autoExecute?: boolean;   // If true, execute without user confirmation
}

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
    // Directory exploration - AI can request directory listings
    directoryRequests?: DirectoryRequest[];
    // File search - AI can search for files by pattern before asking user
    fileSearchRequests?: FileSearchRequest[];
    // Sub-tasks for parallel/sequential work decomposition
    subTasks?: SubTaskRequest[];
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
  ],
  "directoryRequests": [
    { "path": "src/prompts", "recursive": false, "filter": "*.ts" }
  ],
  "fileSearchRequests": [
    { "pattern": "**/config.json", "reason": "Need cluster configuration", "autoAttach": true }
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

    // Validate optional directoryRequests
    if (obj.directoryRequests !== undefined) {
        if (!Array.isArray(obj.directoryRequests)) {
            return null;
        }
        response.directoryRequests = obj.directoryRequests.filter((d): d is DirectoryRequest =>
            typeof d === 'object' && d !== null &&
            typeof (d as DirectoryRequest).path === 'string' &&
            (d as DirectoryRequest).path.trim().length > 0
        ).map(d => ({
            path: d.path.trim(),
            recursive: typeof d.recursive === 'boolean' ? d.recursive : false,
            filter: typeof d.filter === 'string' ? d.filter.trim() : undefined
        }));
    }

    // Validate optional fileSearchRequests
    if (obj.fileSearchRequests !== undefined) {
        if (!Array.isArray(obj.fileSearchRequests)) {
            return null;
        }
        response.fileSearchRequests = obj.fileSearchRequests.filter((f): f is FileSearchRequest =>
            typeof f === 'object' && f !== null &&
            typeof (f as FileSearchRequest).pattern === 'string' &&
            (f as FileSearchRequest).pattern.trim().length > 0 &&
            typeof (f as FileSearchRequest).reason === 'string'
        ).map(f => ({
            pattern: f.pattern.trim(),
            reason: f.reason.trim(),
            maxResults: typeof f.maxResults === 'number' ? f.maxResults : 5,
            autoAttach: typeof f.autoAttach === 'boolean' ? f.autoAttach : true
        }));
    }

    // Validate optional subTasks
    if (obj.subTasks !== undefined) {
        if (!Array.isArray(obj.subTasks)) {
            return null;
        }
        response.subTasks = obj.subTasks.filter((s): s is SubTaskRequest =>
            typeof s === 'object' && s !== null &&
            typeof (s as SubTaskRequest).id === 'string' &&
            (s as SubTaskRequest).id.trim().length > 0 &&
            typeof (s as SubTaskRequest).goal === 'string' &&
            (s as SubTaskRequest).goal.trim().length > 0
        ).map(s => ({
            id: s.id.trim(),
            goal: s.goal.trim(),
            files: Array.isArray(s.files) 
                ? s.files.filter((f): f is string => typeof f === 'string').map(f => f.trim())
                : undefined,
            dependencies: Array.isArray(s.dependencies)
                ? s.dependencies.filter((d): d is string => typeof d === 'string').map(d => d.trim())
                : undefined,
            autoExecute: typeof s.autoExecute === 'boolean' ? s.autoExecute : false
        }));
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
                                        line: { type: "integer", description: "1-indexed line number (start of range)" },
                                        endLine: { type: "integer", description: "1-indexed end line (inclusive) for range ops" },
                                        expectedContent: { type: "string", description: "Content expected at first line (for validation)" },
                                        newContent: { type: "string", description: "New content (use \\n for multi-line)" }
                                    },
                                    required: ["type", "line"],
                                    additionalProperties: false
                                }
                            },
                            todoIndex: { type: "integer", description: "0-indexed reference to todos array item this change completes" }
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
                },
                directoryRequests: {
                    type: "array",
                    description: "Request directory listings to explore file structure",
                    items: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Directory path relative to workspace root" },
                            recursive: { type: "boolean", description: "Include subdirectories (default: false)" },
                            filter: { type: "string", description: "Optional glob filter (e.g., '*.ts')" }
                        },
                        required: ["path"],
                        additionalProperties: false
                    }
                },
                fileSearchRequests: {
                    type: "array",
                    description: "Search for files by pattern - use BEFORE asking user to attach files",
                    items: {
                        type: "object",
                        properties: {
                            pattern: { type: "string", description: "Glob pattern (e.g., '**/config.json') or filename" },
                            reason: { type: "string", description: "Why this file is needed (shown if not found)" },
                            maxResults: { type: "integer", description: "Max files to return (default: 5)" },
                            autoAttach: { type: "boolean", description: "Auto-attach found files (default: true)" }
                        },
                        required: ["pattern", "reason"],
                        additionalProperties: false
                    }
                },
                subTasks: {
                    type: "array",
                    description: "Sub-tasks for parallel or sequential work decomposition",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string", description: "Unique ID for tracking (e.g., 'api', 'frontend', 'tests')" },
                            goal: { type: "string", description: "Clear description of what to accomplish" },
                            files: { 
                                type: "array", 
                                items: { type: "string" },
                                description: "Files to attach to sub-task context"
                            },
                            dependencies: {
                                type: "array",
                                items: { type: "string" },
                                description: "IDs of sub-tasks that must complete first"
                            },
                            autoExecute: { 
                                type: "boolean", 
                                description: "If true, execute without user confirmation (default: false)"
                            }
                        },
                        required: ["id", "goal"],
                        additionalProperties: false
                    }
                }
            },
            required: ["summary"],
            additionalProperties: false
        }
    }
};
