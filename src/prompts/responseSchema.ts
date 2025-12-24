/**
 * Structured response schema for Grok AI responses.
 * This defines the JSON format the AI returns, making parsing reliable
 * and project-agnostic.
 */

export interface TodoItem {
    text: string;
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
    nextSteps?: string[];
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
  "fileChanges": [
    { "path": "src/file.py", "language": "python", "content": "-old line\\n+new line", "isDiff": true, "lineRange": { "start": 10, "end": 15 } }
  ],
  "commands": [
    { "command": "npm test", "description": "Run tests" }
  ],
  "nextSteps": ["First action", "Second action"]
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

    // Validate optional nextSteps
    if (obj.nextSteps !== undefined) {
        if (!Array.isArray(obj.nextSteps)) {
            return null;
        }
        response.nextSteps = obj.nextSteps.filter((s): s is string => typeof s === 'string');
    }

    return response;
}
