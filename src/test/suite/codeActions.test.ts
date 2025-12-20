import * as assert from 'assert';

suite('Code Actions - parseCodeBlocksFromResponse', () => {
    
    // We need to test the parsing logic without vscode.workspace dependency
    // So we'll test the regex pattern directly
    // Using unicode flag for surrogate pairs
    const filePattern = /[\u{1F4C4}\u{1F5CE}]\s*([^\s\n(]+)\s*(?:\(lines?\s*(\d+)(?:-(\d+))?\))?[\s\n]*```(\w+)?\n([\s\S]*?)```/gu;

    function parseCodeBlocks(responseText: string): Array<{filePath: string, code: string, language?: string}> {
        const edits: Array<{filePath: string, code: string, language?: string}> = [];
        let match;
        
        while ((match = filePattern.exec(responseText)) !== null) {
            const [, filePath, , , language, code] = match;
            edits.push({
                filePath,
                code: code.trim(),
                language
            });
        }
        
        // Reset regex lastIndex for reuse
        filePattern.lastIndex = 0;
        return edits;
    }

    test('parses single file with 📄 emoji', () => {
        const response = `Here's the code:

📄 src/utils/helper.ts
\`\`\`typescript
export function greet(name: string): string {
    return \`Hello, \${name}!\`;
}
\`\`\`

That should work!`;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].filePath, 'src/utils/helper.ts');
        assert.strictEqual(edits[0].language, 'typescript');
        assert.ok(edits[0].code.includes('export function greet'));
    });

    test('parses multiple files', () => {
        const response = `Creating two files:

📄 src/index.ts
\`\`\`typescript
import { helper } from './helper';
console.log(helper());
\`\`\`

📄 src/helper.ts
\`\`\`typescript
export function helper() {
    return 'Hello';
}
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 2);
        assert.strictEqual(edits[0].filePath, 'src/index.ts');
        assert.strictEqual(edits[1].filePath, 'src/helper.ts');
    });

    test('parses file with line range', () => {
        const response = `Updating lines 10-20:

📄 src/app.ts (lines 10-20)
\`\`\`typescript
// Updated code here
const x = 1;
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].filePath, 'src/app.ts');
    });

    test('handles different languages', () => {
        const response = `
📄 script.py
\`\`\`python
def main():
    print("Hello")
\`\`\`

📄 styles.css
\`\`\`css
.container { margin: 0; }
\`\`\`

📄 config.json
\`\`\`json
{"key": "value"}
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 3);
        assert.strictEqual(edits[0].language, 'python');
        assert.strictEqual(edits[1].language, 'css');
        assert.strictEqual(edits[2].language, 'json');
    });

    test('returns empty array for no code blocks', () => {
        const response = `Just some text without any code blocks or file references.`;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 0);
    });

    test('ignores code blocks without 📄 prefix', () => {
        const response = `Here's some code:

\`\`\`typescript
// This should NOT be parsed
const x = 1;
\`\`\`

But this should be parsed:

📄 real-file.ts
\`\`\`typescript
// This SHOULD be parsed
const y = 2;
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].filePath, 'real-file.ts');
        assert.ok(edits[0].code.includes('const y = 2'));
    });

    test('handles nested directory paths', () => {
        const response = `
📄 src/components/auth/LoginForm.tsx
\`\`\`tsx
export const LoginForm = () => <div>Login</div>;
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].filePath, 'src/components/auth/LoginForm.tsx');
    });

    test('handles file without extension', () => {
        const response = `
📄 Dockerfile
\`\`\`dockerfile
FROM node:18
WORKDIR /app
\`\`\``;

        const edits = parseCodeBlocks(response);
        
        assert.strictEqual(edits.length, 1);
        assert.strictEqual(edits[0].filePath, 'Dockerfile');
    });
});

suite('Code Actions - Terminal Command Parsing', () => {
    
    const terminalPattern = /🖥️\s*`([^`]+)`/g;

    function parseTerminalCommands(responseText: string): string[] {
        const commands: string[] = [];
        let match;
        
        while ((match = terminalPattern.exec(responseText)) !== null) {
            commands.push(match[1]);
        }
        
        terminalPattern.lastIndex = 0;
        return commands;
    }

    test('parses single terminal command', () => {
        const response = `Run this command:

🖥️ \`npm run test\``;

        const commands = parseTerminalCommands(response);
        
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0], 'npm run test');
    });

    test('parses multiple terminal commands', () => {
        const response = `First install:
🖥️ \`npm install\`

Then build:
🖥️ \`npm run build\`

Finally test:
🖥️ \`npm test\``;

        const commands = parseTerminalCommands(response);
        
        assert.strictEqual(commands.length, 3);
        assert.strictEqual(commands[0], 'npm install');
        assert.strictEqual(commands[1], 'npm run build');
        assert.strictEqual(commands[2], 'npm test');
    });

    test('handles complex commands with flags', () => {
        const response = `🖥️ \`grep -r "TODO" src/ --include="*.ts"\``;

        const commands = parseTerminalCommands(response);
        
        assert.strictEqual(commands.length, 1);
        assert.ok(commands[0].includes('grep'));
        assert.ok(commands[0].includes('--include'));
    });

    test('returns empty for no commands', () => {
        const response = `Just some text without terminal commands.`;

        const commands = parseTerminalCommands(response);
        
        assert.strictEqual(commands.length, 0);
    });
});

suite('Code Actions - TODO Parsing', () => {
    
    const todoPattern = /📋\s*TODOS?\s*\n((?:- \[[ x]\] .+\n?)+)/gi;
    const todoItemPattern = /- \[([ x])\] (.+)/g;

    function parseTodos(responseText: string): Array<{text: string, completed: boolean}> {
        const todos: Array<{text: string, completed: boolean}> = [];
        
        const todoMatch = todoPattern.exec(responseText);
        if (todoMatch) {
            const todoSection = todoMatch[1];
            let itemMatch;
            
            while ((itemMatch = todoItemPattern.exec(todoSection)) !== null) {
                todos.push({
                    text: itemMatch[2].trim(),
                    completed: itemMatch[1] === 'x'
                });
            }
        }
        
        todoPattern.lastIndex = 0;
        todoItemPattern.lastIndex = 0;
        return todos;
    }

    test('parses TODO list', () => {
        const response = `📋 TODOS
- [ ] Create user model
- [ ] Add validation
- [ ] Write tests`;

        const todos = parseTodos(response);
        
        assert.strictEqual(todos.length, 3);
        assert.strictEqual(todos[0].text, 'Create user model');
        assert.strictEqual(todos[0].completed, false);
    });

    test('handles completed items', () => {
        const response = `📋 TODOS
- [x] First step done
- [ ] Second step pending
- [x] Third step done`;

        const todos = parseTodos(response);
        
        assert.strictEqual(todos.length, 3);
        assert.strictEqual(todos[0].completed, true);
        assert.strictEqual(todos[1].completed, false);
        assert.strictEqual(todos[2].completed, true);
    });

    test('returns empty for no TODO section', () => {
        const response = `Just some regular text.`;

        const todos = parseTodos(response);
        
        assert.strictEqual(todos.length, 0);
    });
});
