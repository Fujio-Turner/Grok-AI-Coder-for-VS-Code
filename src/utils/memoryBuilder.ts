/**
 * AI Memory Block Builder
 * 
 * Generates a structured "AI Memory" section for injection on "continue" messages.
 * This gives the AI instant context recovery without re-deriving state from conversation history.
 */

import { ChatSessionDocument, TodoItem, FileRegistryEntry } from '../storage/chatSessionRepository';

/**
 * Structured memory state for AI context injection
 */
export interface AIMemory {
    completedTodos: string[];
    pendingTodos: Array<{ text: string; aiText?: string }>;
    modifiedFiles: Array<{
        path: string;
        turn: number;
        hashAfter?: string;
    }>;
    filesNeedingRefresh: string[];
    lastSummary: string;
    workingFiles: string[];
    turnCount: number;
}

/**
 * Checks if a user message indicates a "continue" action
 */
export function isContinueMessage(text: string): boolean {
    const normalized = text.toLowerCase().trim();
    return (
        normalized === 'continue' ||
        normalized === 'go on' ||
        normalized === 'proceed' ||
        normalized === 'next' ||
        normalized === 'keep going' ||
        normalized.startsWith('continue ') ||
        normalized.startsWith('go ahead')
    );
}

/**
 * Builds the AI memory state from session data
 */
export function buildAIMemory(session: ChatSessionDocument, currentTurn: number): AIMemory {
    const memory: AIMemory = {
        completedTodos: [],
        pendingTodos: [],
        modifiedFiles: [],
        filesNeedingRefresh: [],
        lastSummary: '',
        workingFiles: [],
        turnCount: currentTurn
    };

    // Extract todos from session
    if (session.todos && session.todos.length > 0) {
        for (const todo of session.todos) {
            if (todo.completed) {
                memory.completedTodos.push(todo.text);
            } else {
                memory.pendingTodos.push({
                    text: todo.text,
                    aiText: todo.aiText
                });
            }
        }
    }

    // Build modified files list from change history
    if (session.changeHistory?.history) {
        const modifiedFilesMap = new Map<string, { turn: number; hashAfter?: string }>();
        
        for (let i = 0; i < session.changeHistory.history.length; i++) {
            const changeSet = session.changeHistory.history[i];
            if (changeSet.applied) {
                for (const file of changeSet.files) {
                    modifiedFilesMap.set(file.filePath, {
                        turn: i + 1,
                        hashAfter: undefined // Could compute hash if needed
                    });
                }
            }
        }

        for (const [path, info] of modifiedFilesMap) {
            memory.modifiedFiles.push({
                path,
                turn: info.turn,
                hashAfter: info.hashAfter
            });
        }
    }

    // Determine files needing refresh using file registry
    if (session.fileRegistry) {
        for (const [path, entry] of Object.entries(session.fileRegistry)) {
            // If file was modified after it was last seen, it needs refresh
            if (entry.lastModifiedTurn && entry.lastModifiedTurn > entry.lastSeenTurn) {
                memory.filesNeedingRefresh.push(path);
            }
        }
    }

    // Get last AI response summary
    if (session.pairs.length > 0) {
        const lastPair = session.pairs[session.pairs.length - 1];
        if (lastPair.response?.structured?.summary) {
            memory.lastSummary = lastPair.response.structured.summary;
        } else if (lastPair.response?.text) {
            // Try to extract summary from raw text (first sentence or truncated)
            const text = lastPair.response.text;
            const firstSentence = text.split(/[.!?\n]/)[0];
            memory.lastSummary = firstSentence.length > 200 
                ? firstSentence.substring(0, 200) + '...'
                : firstSentence;
        }
    }

    // Build working files list - recently seen files that are still relevant
    if (session.fileRegistry) {
        const recentThreshold = Math.max(1, currentTurn - 3);
        for (const [path, entry] of Object.entries(session.fileRegistry)) {
            if (entry.lastSeenTurn >= recentThreshold) {
                memory.workingFiles.push(path);
            }
        }
    }

    return memory;
}

/**
 * Formats the AI memory as a markdown block for context injection
 */
export function buildMemoryBlock(session: ChatSessionDocument, currentTurn: number): string {
    const memory = buildAIMemory(session, currentTurn);
    
    // Don't inject if there's nothing useful to show
    if (
        memory.completedTodos.length === 0 &&
        memory.pendingTodos.length === 0 &&
        memory.modifiedFiles.length === 0 &&
        !memory.lastSummary
    ) {
        return '';
    }

    let block = '\n\n## 🧠 AI Memory (Continuation Context)\n\n';
    block += 'This is a continuation. Use this memory to resume efficiently without re-reading full history.\n\n';

    // Show turn info
    block += `**Current Turn:** ${currentTurn}\n\n`;

    // Last response summary
    if (memory.lastSummary) {
        block += `### Last Response Summary\n`;
        block += `> ${memory.lastSummary}\n\n`;
    }

    // Completed todos
    if (memory.completedTodos.length > 0) {
        block += `### ✅ Completed Todos (${memory.completedTodos.length})\n`;
        for (const todo of memory.completedTodos.slice(-5)) { // Show last 5
            block += `- [x] ${todo}\n`;
        }
        if (memory.completedTodos.length > 5) {
            block += `- *(and ${memory.completedTodos.length - 5} more)*\n`;
        }
        block += '\n';
    }

    // Pending todos - this is the critical section
    if (memory.pendingTodos.length > 0) {
        block += `### ⏳ Pending Todos (${memory.pendingTodos.length})\n`;
        block += `**Resume from the first uncompleted item:**\n\n`;
        for (let i = 0; i < memory.pendingTodos.length; i++) {
            const todo = memory.pendingTodos[i];
            block += `${i + 1}. [ ] **${todo.text}**\n`;
            if (todo.aiText) {
                // Include verbose AI instructions so it remembers what to do
                block += `   - *Details:* ${todo.aiText}\n`;
            }
        }
        block += '\n';
    }

    // Files needing refresh - critical for preventing stale content usage
    if (memory.filesNeedingRefresh.length > 0) {
        block += `### ⚠️ Files Needing Refresh\n`;
        block += `These files were modified since you last saw them. Request re-attachment before modifying:\n\n`;
        for (const path of memory.filesNeedingRefresh) {
            block += `- 📄 ${path}\n`;
        }
        block += '\n';
    }

    // Modified files this session
    if (memory.modifiedFiles.length > 0) {
        block += `### 📝 Modified Files This Session\n`;
        block += '| File | Turn Modified |\n';
        block += '|------|---------------|\n';
        for (const file of memory.modifiedFiles.slice(-10)) { // Show last 10
            const relativePath = file.path.split('/').slice(-2).join('/');
            block += `| ${relativePath} | Turn ${file.turn} |\n`;
        }
        if (memory.modifiedFiles.length > 10) {
            block += `| *...and ${memory.modifiedFiles.length - 10} more* | |\n`;
        }
        block += '\n';
    }

    // Working files context
    if (memory.workingFiles.length > 0 && memory.workingFiles.length <= 10) {
        block += `### 📂 Active Working Files\n`;
        block += `Files you've recently worked with (last 3 turns):\n`;
        for (const path of memory.workingFiles) {
            const relativePath = path.split('/').slice(-2).join('/');
            block += `- ${relativePath}\n`;
        }
        block += '\n';
    }

    // Instructions for AI
    block += `### 📋 Resumption Instructions\n`;
    block += `1. Check "Files Needing Refresh" before modifying any files\n`;
    block += `2. Resume from the first pending todo\n`;
    block += `3. Don't repeat completed work\n`;
    block += `4. If needed files aren't attached, ask for them\n\n`;

    return block;
}
