# File Tracking & AI Autonomy Improvements

**Status:** In Progress  
**Priority:** High  
**Created:** 2024-12-28  
**Last Updated:** 2024-12-28

---

## ✅ Completed Improvements

### Improvement #1: Smart File Registry System - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

The file registry provides session-wide tracking of files the AI has "seen", enabling smarter decisions about when to request re-attachments.

#### What Was Built

| Component | Description |
|-----------|-------------|
| `FileRegistryEntry` interface | Stores path, absolutePath, md5, lastSeenTurn, lastModifiedTurn, sizeBytes, language, loadedBy |
| `session.fileRegistry` field | Persistent storage in Couchbase session document |
| `updateFileRegistry()` | Adds/updates files when loaded via agent or user attachment |
| `markFileModified()` | Updates hash and lastModifiedTurn when user applies changes |
| `getFileRegistry()` | Retrieves full registry for a session |
| `buildFileRegistrySummary()` | Generates markdown table for AI context injection |

#### Integration Points

1. **Agent Workflow** (`ChatViewProvider.ts` ~line 2093):
   - After `runAgentWorkflow()` loads files, registry is updated
   - Each file gets: path, absolutePath, md5, sizeBytes, language, loadedBy='auto'

2. **Apply Changes** (`ChatViewProvider.ts` ~line 3188):
   - After `doApplyEdits()` modifies files, `markFileModified()` is called
   - Updates md5 hash and sets lastModifiedTurn

3. **Context Injection** (`ChatViewProvider.ts` ~line 3688):
   - `buildFileRegistrySummary()` called when building system prompt
   - Generates "KNOWN FILES" table showing staleness indicators

4. **System Prompt** (`config/system-prompt.json`):
   - New "FILE REGISTRY (Session Memory)" section
   - Instructions for AI to check registry before modifying files

#### Example AI Context

```markdown
## 📂 KNOWN FILES (Session Registry)
Files you have seen in this conversation. Check "Modified Since" before using cached knowledge.

| File | Last Seen | Modified Since | Hash (first 12) |
|------|-----------|----------------|-----------------|
| src/utils.py | This turn | No | 9a906fd5909d... |
| src/api.py | 2 turn(s) ago | ⚠️ Yes (turn 4) | abc123def456... |
| config/settings.json | 3 turn(s) ago | No | def789ghi012... |

**If "Modified Since" shows ⚠️, request re-attachment before making changes.**
```

#### Files Changed

| File | Changes |
|------|---------|
| `src/storage/chatSessionRepository.ts` | +200 lines: FileRegistryEntry interface, 5 new functions, buildFileRegistrySummary() |
| `src/views/ChatViewProvider.ts` | +30 lines: Import new functions, registry update in agent workflow, markFileModified on apply |
| `config/system-prompt.json` | +15 lines: FILE REGISTRY section with usage instructions |
| `docs/CHAT_DESIGN.md` | +130 lines: New "File Registry (Session Memory)" section with diagrams |

#### Testing Checklist

- [ ] Load files via agent workflow → verify registry populated
- [ ] Apply file change → verify markFileModified called
- [ ] Check AI context includes KNOWN FILES table
- [ ] Verify ⚠️ indicator shows when file modified after last seen
- [ ] Confirm registry persists across session reload

---

## Executive Summary

This document outlines improvements to address file tracking limitations in the Grok AI Coder extension. The current design requires explicit file attachments, leading to friction and AI hallucinations when files aren't available. These improvements aim to:

1. Reduce user friction for file attachments
2. Enable AI to work more autonomously
3. Prevent stale content issues
4. Improve auto-load success rates

---

## Problem Analysis

### Current Pain Points

| Problem | Impact | Frequency |
|---------|--------|-----------|
| **Stale Content** | AI uses old file versions after modifications, causing hash mismatches | High |
| **Failed Auto-Loads** | Glob patterns like `**/responseSchema.ts` fail, forcing manual attachment | Medium |
| **No Persistence** | AI can't remember files across turns without re-attachment | High |
| **Limited Scope** | AI can't explore directories or list files independently | Medium |
| **Hallucinations** | AI fabricates content when files aren't available | Critical |

### Root Causes

1. **No filesystem access** - AI relies entirely on what's injected into context
2. **Pattern matching fragility** - Glob patterns fail on complex directory structures
3. **No session-level file memory** - Each turn is stateless regarding files
4. **No directory exploration** - AI can't discover file locations

---

## Improvement #1: Smart File Registry System

### Overview
Add a persistent `fileRegistry` to session documents that tracks file metadata across the conversation. AI checks this before requesting attachments.

### Data Structure

Add to `ChatSession` interface in `src/storage/chatSessionRepository.ts`:

```typescript
interface FileRegistryEntry {
    path: string;              // Relative path from workspace root
    absolutePath: string;      // Full filesystem path
    md5: string;               // Last known hash
    lastSeenTurn: number;      // Which pairIndex last had this file
    lastModifiedTurn?: number; // Which pairIndex last modified this file
    sizeBytes: number;         // File size for context budget decisions
    language: string;          // Detected language (for syntax highlighting)
}

interface ChatSession {
    // ... existing fields ...
    fileRegistry: Record<string, FileRegistryEntry>; // keyed by relative path
}
```

### Implementation Steps

1. **Update `chatSessionRepository.ts`**:
   - Add `fileRegistry` to session schema
   - Create `updateFileRegistry(sessionId, entries)` function
   - Create `getFileRegistry(sessionId)` function

2. **Update agent workflow** (`src/agent/agentOrchestrator.ts`):
   - After successful file load, call `updateFileRegistry()`
   - After file modification (apply), update the entry with new hash

3. **Update system prompt** (`config/system-prompt.json`):
   - Add section: "## FILE REGISTRY - Check Before Requesting"
   - Instruct AI to check `fileRegistry` in context before asking for attachment
   - If file exists in registry with recent `lastSeenTurn`, AI can reference known structure

4. **Inject registry into context**:
   - In `buildContextForAI()`, include a `## Known Files` section listing registry entries
   - Show: path, last seen turn, whether modified since

### Example Context Injection

```
## Known Files (from session registry)
| Path | Last Seen | Modified Since | Hash |
|------|-----------|----------------|------|
| src/utils.py | Turn 3 | No | 9a906fd... |
| src/api.py | Turn 2 | Yes (Turn 4) | - needs refresh |
| config/settings.json | Turn 1 | No | abc123... |
```

### Benefits
- AI knows which files it has "seen" even if not in current context
- Clear signal when file needs refresh (modified since last seen)
- Enables smarter decisions about what to request

---

## Improvement #2: Fallback Pattern Chains

### Overview
Modify the planning schema to support multiple fallback patterns per file, tried in order until one succeeds.

### Schema Changes

Update `config/planning-schema.json`:

```json
{
  "type": "object",
  "properties": {
    "filesToLoad": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "description": "Human-readable name for this file"
          },
          "patterns": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Glob patterns to try in order (first match wins)",
            "minItems": 1,
            "maxItems": 5
          },
          "required": {
            "type": "boolean",
            "description": "If true, task cannot proceed without this file"
          },
          "fallbackAction": {
            "type": "string",
            "enum": ["ask_user", "skip", "create_new"],
            "description": "What to do if all patterns fail"
          }
        },
        "required": ["name", "patterns"]
      }
    }
  }
}
```

### Example Plan Output

```json
{
  "filesToLoad": [
    {
      "name": "Response Schema",
      "patterns": [
        "src/prompts/responseSchema.ts",
        "**/responseSchema.ts",
        "src/**/*Schema.ts",
        "**/*response*schema*.ts"
      ],
      "required": true,
      "fallbackAction": "ask_user"
    },
    {
      "name": "Test file",
      "patterns": [
        "src/prompts/responseSchema.test.ts",
        "**/*responseSchema*.test.ts"
      ],
      "required": false,
      "fallbackAction": "skip"
    }
  ]
}
```

### Implementation Steps

1. **Update `config/planning-schema.json`** with new structure
2. **Update `config/planning-prompt.json`** to instruct fast model on pattern strategy:
   - First pattern: exact known path (if available)
   - Second pattern: simple glob with filename
   - Third pattern: broader search with partial name
   - Fourth pattern: wildcard with file type
3. **Update `agentOrchestrator.ts`**:
   - Loop through patterns array for each file
   - Stop on first successful match
   - Track which pattern succeeded (for analytics)
   - Execute `fallbackAction` if all patterns fail
4. **Add analytics** to bug tracking:
   - Log pattern success/failure rates
   - Identify patterns that frequently fail

### Pattern Strategy Guide (for planning prompt)

```
PATTERN STRATEGY - Order patterns from specific to broad:

1. EXACT PATH (if you know it):
   "src/components/Button.tsx"

2. FILENAME GLOB (most reliable):
   "**/Button.tsx"

3. DIRECTORY SCOPED:
   "src/components/**/*.tsx"

4. PARTIAL NAME:
   "**/*Button*.tsx"

5. EXTENSION ONLY (last resort):
   "**/*.tsx"

AVOID:
- Starting with "**/*" (too broad, slow)
- Multiple wildcards in filename ("**/*But*ton*.tsx")
```

---

## Improvement #3: Directory Listing Tool

### Overview
Add an AI-requestable action that lists directory contents. AI can then request exact file paths instead of guessing patterns.

### New Action Type

Add to response schema (`config/response-schema.json`):

```json
{
  "directoryRequests": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "Directory path relative to workspace root"
        },
        "recursive": {
          "type": "boolean",
          "default": false,
          "description": "Include subdirectories"
        },
        "filter": {
          "type": "string",
          "description": "Optional glob filter (e.g., '*.ts')"
        }
      },
      "required": ["path"]
    }
  }
}
```

### Example AI Response

```json
{
  "summary": "I need to see what files are in the prompts directory to find the schema.",
  "directoryRequests": [
    {"path": "src/prompts", "recursive": false, "filter": "*.ts"}
  ],
  "nextSteps": [
    {"html": "After listing, I'll identify the correct file", "inputText": "continue"}
  ]
}
```

### Implementation Steps

1. **Update response schema** with `directoryRequests` field
2. **Create handler in `ChatViewProvider.ts`**:
   ```typescript
   async function handleDirectoryRequest(request: DirectoryRequest): Promise<string[]> {
       const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
       const fullPath = path.join(workspaceRoot, request.path);
       
       if (!fs.existsSync(fullPath)) {
           return [`⚠️ Directory not found: ${request.path}`];
       }
       
       let entries = fs.readdirSync(fullPath, { withFileTypes: true });
       
       if (request.filter) {
           const glob = new Minimatch(request.filter);
           entries = entries.filter(e => glob.match(e.name));
       }
       
       return entries.map(e => e.isDirectory() ? `${e.name}/` : e.name);
   }
   ```
3. **Inject results into next turn**:
   - Add a `## Directory Listing Results` section to context
   - Format as table: name, type (file/dir), size
4. **Update system prompt** to explain usage:
   ```
   ## DIRECTORY EXPLORATION
   
   If you don't know exact file locations, use directoryRequests:
   {"directoryRequests": [{"path": "src/prompts", "filter": "*.ts"}]}
   
   Results will appear in the next turn. Then request specific files.
   ```

### Security Considerations
- Restrict to workspace root (no `..` traversal)
- Limit depth for recursive requests
- Rate limit to prevent abuse

---

## Improvement #4: Proactive File Bundling

### Overview
When AI modifies a file, automatically analyze its imports and attach related files in the next turn.

### Implementation Approach

1. **Parse imports after file change**:
   - Use simple regex for common patterns:
     - TypeScript/JavaScript: `import .* from ['"](.+)['"]`
     - Python: `from ([\w.]+) import` or `import ([\w.]+)`
   - Resolve relative paths to absolute

2. **Create `importAnalyzer.ts`**:
   ```typescript
   interface ImportInfo {
       source: string;        // The import path as written
       resolvedPath: string;  // Absolute path (if local file)
       isLocal: boolean;      // true if it's a project file, not node_module
   }
   
   function analyzeImports(filePath: string, content: string): ImportInfo[] {
       const imports: ImportInfo[] = [];
       const ext = path.extname(filePath);
       
       if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
           // TypeScript/JavaScript import patterns
           const patterns = [
               /import\s+.*\s+from\s+['"]([^'"]+)['"]/g,
               /import\s+['"]([^'"]+)['"]/g,
               /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
           ];
           // ... extract and resolve
       } else if (ext === '.py') {
           // Python import patterns
           const patterns = [
               /from\s+([\w.]+)\s+import/g,
               /import\s+([\w.]+)/g
           ];
           // ... extract and resolve
       }
       
       return imports.filter(i => i.isLocal);
   }
   ```

3. **Auto-attach logic in `agentOrchestrator.ts`**:
   ```typescript
   async function bundleRelatedFiles(changedFile: string): Promise<string[]> {
       const content = await fs.promises.readFile(changedFile, 'utf-8');
       const imports = analyzeImports(changedFile, content);
       
       // Also check for test files
       const testPatterns = [
           changedFile.replace('.ts', '.test.ts'),
           changedFile.replace('.ts', '.spec.ts'),
           changedFile.replace('src/', 'tests/')
       ];
       
       const relatedFiles = [
           ...imports.map(i => i.resolvedPath),
           ...testPatterns.filter(p => fs.existsSync(p))
       ];
       
       // Limit to prevent context explosion
       return relatedFiles.slice(0, 5);
   }
   ```

4. **Inject on "continue"**:
   - When user says "continue" after applying changes
   - Auto-load bundled files into context
   - Show AI which files were auto-bundled

### Configuration

Add to VS Code settings:
```json
{
    "grok.proactiveBundling": true,
    "grok.bundleImports": true,
    "grok.bundleTests": true,
    "grok.maxBundledFiles": 5
}
```

---

## Improvement #5: Continuation Memory Block

### Overview
Inject a structured "AI Memory" section on "continue" that summarizes state, eliminating need for AI to re-derive context.

### Memory Block Structure

```markdown
## 🧠 AI Memory (Injected on Continue)

### Completed Todos
- [x] Fix syntax error in utils.py (line 45)
- [x] Add timeout wrapper to API calls

### Pending Todos
- [ ] Update tests for new timeout behavior
- [ ] Add error handling for timeout exceptions

### Modified Files This Session
| File | Hash Before | Hash After | Turn Modified |
|------|-------------|------------|---------------|
| src/utils.py | 9a906fd5... | b2c4e8a1... | 3 |
| src/api.py | abc123... | def456... | 4 |

### Files Needing Refresh
- src/utils.py (modified in turn 4, you last saw turn 3)

### Last AI Response Summary
"Fixed the syntax error and added timeout wrappers. Two todos remaining."

### Current Working Files (Auto-Attached)
📄 src/utils.py (fresh - attached this turn)
📄 src/tests/test_api.py (from registry, unchanged)
```

### Implementation Steps

1. **Create `memoryBuilder.ts`**:
   ```typescript
   interface AIMemory {
       completedTodos: string[];
       pendingTodos: Array<{text: string, aiText: string}>;
       modifiedFiles: Array<{path: string, hashBefore: string, hashAfter: string, turn: number}>;
       filesNeedingRefresh: string[];
       lastSummary: string;
       workingFiles: string[];
   }
   
   function buildMemoryBlock(session: ChatSession, currentTurn: number): string {
       const memory: AIMemory = {
           completedTodos: session.pairs
               .flatMap(p => p.response?.todos ?? [])
               .filter(t => t.completed)
               .map(t => t.text),
           // ... build other fields from session state
       };
       
       return formatAsMarkdown(memory);
   }
   ```

2. **Inject in `buildContextForAI()`**:
   ```typescript
   if (userMessage.toLowerCase().includes('continue')) {
       const memory = buildMemoryBlock(session, currentPairIndex);
       contextParts.push(memory);
   }
   ```

3. **Update system prompt**:
   ```
   ## CONTINUATION CONTEXT
   
   When you see "## 🧠 AI Memory", this contains your state from previous turns:
   - Check "Files Needing Refresh" before making changes
   - Resume from "Pending Todos"
   - Don't repeat completed work
   ```

### Benefits
- Zero-cost state recovery for AI
- Clear signal on what needs refresh
- Reduces hallucination of completed work

---

## Improvement #6: Sub-Task Spawning (Phase 2)

### Overview
Allow AI to spawn child tasks that run semi-autonomously, enabling parallel work and complex multi-step operations.

### New Response Field

Add to `config/response-schema.json`:

```json
{
  "subTasks": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Unique ID for tracking"
        },
        "goal": {
          "type": "string",
          "description": "Clear description of what this sub-task should accomplish"
        },
        "files": {
          "type": "array",
          "items": {"type": "string"},
          "description": "Files to attach to the sub-task context"
        },
        "dependencies": {
          "type": "array",
          "items": {"type": "string"},
          "description": "IDs of sub-tasks that must complete first"
        },
        "autoExecute": {
          "type": "boolean",
          "default": false,
          "description": "If true, execute without user confirmation"
        }
      },
      "required": ["id", "goal"]
    }
  }
}
```

### Example AI Response

```json
{
  "summary": "I'll implement this feature in 3 parallel sub-tasks.",
  "todos": [
    {"text": "Create API endpoint", "aiText": "..."},
    {"text": "Add frontend component", "aiText": "..."},
    {"text": "Write tests", "aiText": "..."}
  ],
  "subTasks": [
    {
      "id": "api",
      "goal": "Create POST /api/users endpoint with validation. Return 201 on success, 400 on validation error.",
      "files": ["src/api/routes.ts", "src/api/validation.ts"],
      "autoExecute": false
    },
    {
      "id": "frontend",
      "goal": "Create UserForm component with name, email fields. Use existing Button and Input components.",
      "files": ["src/components/UserForm.tsx"],
      "dependencies": [],
      "autoExecute": false
    },
    {
      "id": "tests",
      "goal": "Write unit tests for UserForm and API endpoint.",
      "files": ["src/tests/UserForm.test.tsx", "src/tests/api.test.ts"],
      "dependencies": ["api", "frontend"],
      "autoExecute": false
    }
  ]
}
```

### Implementation Steps

1. **Create `subTaskManager.ts`**:
   ```typescript
   interface SubTask {
       id: string;
       goal: string;
       files: string[];
       dependencies: string[];
       autoExecute: boolean;
       status: 'pending' | 'running' | 'completed' | 'failed';
       sessionId?: string;  // Child session ID
       result?: string;     // Summary from child
   }
   
   class SubTaskManager {
       private tasks: Map<string, SubTask> = new Map();
       
       async execute(task: SubTask): Promise<string> {
           // 1. Create child session with handoff context
           // 2. Attach specified files
           // 3. Send goal as initial message
           // 4. Wait for completion or user intervention
           // 5. Return summary
       }
       
       getReadyTasks(): SubTask[] {
           // Return tasks whose dependencies are all completed
       }
   }
   ```

2. **UI for sub-task management**:
   - Show sub-task cards in chat view
   - Status indicators (pending/running/done/failed)
   - "Run" button for manual execution
   - Dependency graph visualization

3. **Handoff context for child sessions**:
   - Include parent session summary
   - Attach specified files
   - Set scope limits (only work on stated goal)

4. **Result aggregation**:
   - When all sub-tasks complete, summarize in parent
   - Show files changed by each sub-task
   - Merge todos from children into parent

### Phases

| Phase | Description | User Interaction |
|-------|-------------|------------------|
| Phase 1 (Current) | Manual multi-step | User clicks "continue" repeatedly |
| **Phase 2** | Semi-automated | AI proposes sub-tasks, user approves batch |
| Phase 3 | Fully automated | AI spawns and manages sub-tasks autonomously |

---

## Implementation Priority

| # | Improvement | Effort | Impact | Priority | Status |
|---|-------------|--------|--------|----------|--------|
| 1 | File Registry System | Medium | High | **P0** | ✅ Done |
| 2 | Fallback Pattern Chains | Low | Medium | **P1** | Pending |
| 3 | Directory Listing Tool | Low | Medium | **P1** | Pending |
| 4 | Proactive File Bundling | Medium | Medium | **P2** | Pending |
| 5 | Continuation Memory Block | Low | High | **P0** | Pending |
| 6 | Sub-Task Spawning | High | High | **P2** | Pending |

### Recommended Order

1. **Week 1**: Continuation Memory Block (#5) + File Registry (#1)
2. **Week 2**: Fallback Patterns (#2) + Directory Listing (#3)
3. **Week 3**: Proactive Bundling (#4)
4. **Week 4+**: Sub-Task Spawning (#6)

---

## Files to Modify

### Core Files
- `src/storage/chatSessionRepository.ts` - Add fileRegistry, update session schema
- `src/agent/agentOrchestrator.ts` - Pattern fallbacks, bundling, memory injection
- `src/views/ChatViewProvider.ts` - Directory listing handler, sub-task UI

### Config Files
- `config/planning-schema.json` - Fallback patterns structure
- `config/response-schema.json` - directoryRequests, subTasks fields
- `config/system-prompt.json` - New sections for registry, directory, memory

### New Files to Create
- `src/utils/importAnalyzer.ts` - Parse file imports
- `src/utils/memoryBuilder.ts` - Build continuation memory block
- `src/agent/subTaskManager.ts` - Sub-task execution engine

---

## Testing Strategy

### Unit Tests
- `importAnalyzer.test.ts` - Test import parsing for TS, JS, Python
- `memoryBuilder.test.ts` - Test memory block generation
- `patternMatcher.test.ts` - Test fallback pattern resolution

### Integration Tests
- File registry persistence across session reload
- Directory listing with various filters
- Sub-task dependency resolution

### Manual Test Scenarios
1. Start task, apply change, say "continue" → verify memory block appears
2. Request file with bad pattern → verify fallback patterns tried
3. Ask to list directory → verify results injected
4. Modify file with imports → verify related files bundled

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| File attachment requests per session | ~5 | <2 |
| Failed auto-load rate | ~30% | <10% |
| Hash mismatch errors | ~15% | <5% |
| Turns to complete 3-file task | ~8 | ~4 |

---

## Open Questions

1. **File registry size limit?** - How many entries before we prune old ones?
2. **Pattern timeout?** - How long to try patterns before giving up?
3. **Sub-task isolation?** - Should child sessions share parent's file registry?
4. **Auto-bundling depth?** - Follow imports of imports?

---

## References

- [CHAT_DESIGN.md](./CHAT_DESIGN.md) - Current architecture
- [FILES_API_INTEGRATION.md](./FILES_API_INTEGRATION.md) - xAI Files API usage
- [System Prompt](../config/system-prompt.json) - Current AI instructions
