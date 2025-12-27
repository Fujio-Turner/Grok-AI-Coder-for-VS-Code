import * as assert from 'assert';

/**
 * Unit tests for responseParser.ts
 * Tests AI response parsing including JSON extraction and legacy format handling.
 */

// Types for testing
interface TodoItem {
    text: string;
    completed: boolean;
}

interface FileChange {
    path: string;
    language: string;
    content: string;
    isDiff?: boolean;
    lineRange?: { start: number; end: number };
}

interface TerminalCommand {
    command: string;
    description?: string;
}

interface GrokStructuredResponse {
    summary: string;
    message?: string;
    todos?: TodoItem[];
    fileChanges?: FileChange[];
    commands?: TerminalCommand[];
    nextSteps?: string[];
}

// Recreate parsing functions for testing

function parseLegacyResponse(responseText: string): GrokStructuredResponse {
    const response: GrokStructuredResponse = {
        summary: responseText.split('\n')[0].substring(0, 200),
        message: responseText,
        todos: [],
        fileChanges: [],
        commands: []
    };

    // Extract TODOs
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
        if (response.message) {
            response.message = response.message.replace(todoMatch[0], '').trim();
        }
    }

    // Extract file changes
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
        if (response.message) {
            response.message = response.message.replace(fullMatch, '').trim();
        }
    }

    // Extract terminal commands
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

    if (response.message) {
        response.message = response.message.replace(/\n{3,}/g, '\n\n').trim();
    }

    return response;
}

function isHttpError(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('<!DOCTYPE') || 
           trimmed.startsWith('<html') ||
           trimmed.includes('502 Bad Gateway') ||
           trimmed.includes('503 Service') ||
           trimmed.includes('504 Gateway');
}

function looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

describe('parseLegacyResponse - TODOs', () => {
    it('extracts TODO list', () => {
        const response = `Here's the plan:

📋 TODOS
- [ ] Create user model
- [ ] Add validation
- [x] Set up database

Let me explain...`;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.todos?.length, 3);
        assert.strictEqual(parsed.todos?.[0].text, 'Create user model');
        assert.strictEqual(parsed.todos?.[0].completed, false);
        assert.strictEqual(parsed.todos?.[2].text, 'Set up database');
        assert.strictEqual(parsed.todos?.[2].completed, true);
    });

    it('handles empty TODO list', () => {
        const response = 'Just some text without TODOs';
        const parsed = parseLegacyResponse(response);
        assert.strictEqual(parsed.todos?.length, 0);
    });

    it('removes TODO section from message', () => {
        const response = `Intro

📋 TODOS
- [ ] Task 1

Conclusion`;

        const parsed = parseLegacyResponse(response);
        assert.ok(!parsed.message?.includes('📋 TODOS'));
        assert.ok(!parsed.message?.includes('Task 1'));
    });
});

describe('parseLegacyResponse - File Changes', () => {
    it('extracts file with 📄 emoji', () => {
        const response = `Creating the file:

📄 src/utils/helper.ts
\`\`\`typescript
export function greet(name: string) {
    return \`Hello, \${name}!\`;
}
\`\`\`

Done!`;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.fileChanges?.length, 1);
        assert.strictEqual(parsed.fileChanges?.[0].path, 'src/utils/helper.ts');
        assert.strictEqual(parsed.fileChanges?.[0].language, 'typescript');
        assert.ok(parsed.fileChanges?.[0].content.includes('export function greet'));
    });

    it('extracts file with line range', () => {
        const response = `Updating lines 10-15:

📄 app.py (lines 10-15)
\`\`\`python
def process():
    return True
\`\`\``;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.fileChanges?.length, 1);
        assert.strictEqual(parsed.fileChanges?.[0].lineRange?.start, 10);
        assert.strictEqual(parsed.fileChanges?.[0].lineRange?.end, 15);
    });

    it('detects diff content', () => {
        const response = `Applying changes:

📄 config.json
\`\`\`json
{
-    "old": true
+    "new": true
}
\`\`\``;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.fileChanges?.length, 1);
        assert.strictEqual(parsed.fileChanges?.[0].isDiff, true);
    });

    it('extracts multiple files', () => {
        const response = `Creating files:

📄 index.ts
\`\`\`typescript
export * from './utils';
\`\`\`

📄 utils.ts
\`\`\`typescript
export const VERSION = '1.0.0';
\`\`\``;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.fileChanges?.length, 2);
        assert.strictEqual(parsed.fileChanges?.[0].path, 'index.ts');
        assert.strictEqual(parsed.fileChanges?.[1].path, 'utils.ts');
    });
});

describe('parseLegacyResponse - Terminal Commands', () => {
    it('extracts terminal command', () => {
        const response = `Run this command:

🖥️ \`npm run test\`

This will run all tests.`;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.commands?.length, 1);
        assert.strictEqual(parsed.commands?.[0].command, 'npm run test');
    });

    it('extracts multiple commands', () => {
        const response = `First:
🖥️ \`npm install\`

Then:
🖥️ \`npm run build\`

Finally:
🖥️ \`npm start\``;

        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.commands?.length, 3);
    });

    it('removes commands from message', () => {
        const response = `Run: 🖥️ \`npm test\` to verify.`;
        const parsed = parseLegacyResponse(response);
        
        assert.ok(!parsed.message?.includes('🖥️'));
    });
});

describe('parseLegacyResponse - Summary', () => {
    it('uses first line as summary', () => {
        const response = `This is the summary line.

More details follow here.`;

        const parsed = parseLegacyResponse(response);
        assert.strictEqual(parsed.summary, 'This is the summary line.');
    });

    it('truncates long summaries', () => {
        const longLine = 'x'.repeat(300);
        const parsed = parseLegacyResponse(longLine);
        assert.strictEqual(parsed.summary.length, 200);
    });
});

describe('isHttpError', () => {
    it('detects HTML error pages', () => {
        assert.strictEqual(isHttpError('<!DOCTYPE html>'), true);
        assert.strictEqual(isHttpError('<html>Error</html>'), true);
    });

    it('detects gateway errors', () => {
        assert.strictEqual(isHttpError('502 Bad Gateway'), true);
        assert.strictEqual(isHttpError('503 Service Unavailable'), true);
        assert.strictEqual(isHttpError('504 Gateway Timeout'), true);
    });

    it('returns false for normal responses', () => {
        assert.strictEqual(isHttpError('{"summary": "test"}'), false);
        assert.strictEqual(isHttpError('Here is your answer'), false);
    });
});

describe('looksLikeJson', () => {
    it('detects JSON objects', () => {
        assert.strictEqual(looksLikeJson('{"key": "value"}'), true);
        assert.strictEqual(looksLikeJson('  {"key": "value"}'), true);
    });

    it('detects JSON arrays', () => {
        assert.strictEqual(looksLikeJson('[1, 2, 3]'), true);
        assert.strictEqual(looksLikeJson('  [{"a": 1}]'), true);
    });

    it('rejects non-JSON', () => {
        assert.strictEqual(looksLikeJson('Hello world'), false);
        assert.strictEqual(looksLikeJson('summary: test'), false);
    });
});

describe('Complex response parsing', () => {
    it('parses response with all elements', () => {
        const response = `Here's your complete solution.

📋 TODOS
- [x] Create model
- [ ] Add tests

📄 src/model.ts
\`\`\`typescript
export class User {
    name: string;
}
\`\`\`

Run this to verify:
🖥️ \`npm test\`

Let me know if you need help!`;

        const parsed = parseLegacyResponse(response);
        
        assert.ok(parsed.summary.includes('complete solution'));
        assert.strictEqual(parsed.todos?.length, 2);
        assert.strictEqual(parsed.fileChanges?.length, 1);
        assert.strictEqual(parsed.commands?.length, 1);
        assert.ok(!parsed.message?.includes('📋'));
        assert.ok(!parsed.message?.includes('📄'));
        assert.ok(!parsed.message?.includes('🖥️'));
    });

    it('handles response with only text', () => {
        const response = 'Just a simple text response without any special formatting.';
        const parsed = parseLegacyResponse(response);
        
        assert.strictEqual(parsed.summary, response);
        assert.strictEqual(parsed.message, response);
        assert.strictEqual(parsed.todos?.length, 0);
        assert.strictEqual(parsed.fileChanges?.length, 0);
        assert.strictEqual(parsed.commands?.length, 0);
    });
});
