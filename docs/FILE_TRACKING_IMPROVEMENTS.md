# File Tracking & AI Autonomy Improvements

**Status:** In Progress  
**Priority:** High  
**Created:** 2024-12-28  
**Last Updated:** 2024-12-28

---

## 🔧 Batch Processing Fix (2024-12-28)

**Issue:** AI was breaking multi-file tasks into separate steps (e.g., 3 files → 3 TODOs requiring 3 "continue" clicks).

**Root Cause:** 
1. Missing prompt guidance on batch file processing
2. **CRITICAL:** `config/system-prompt.json` was NOT being loaded - `systemPrompt.ts` used hardcoded string!

**Fix Applied:**

| File | Changes |
|------|---------|
| `config/planning-prompt.json` | Added "BATCH PROCESSING" section with glob examples and wrong/correct patterns |
| `config/system-prompt.json` | Added "📦 BATCH FILE CHANGES" section with multi-file response examples |
| `src/prompts/systemPrompt.ts` | **NEW:** Now loads from `config/system-prompt.json` with hardcoded fallback |

**Key Guidance Added:**

**Planning Prompt (Pass 1):**
- Use ONE action with glob `docs/rollback_multi_file/*` to load ALL files
- Don't create separate actions for each file
- Trigger words: "all files in", "every file", directory globs

**System Prompt (Main Response):**
- Include ALL fileChanges in single response array
- Use single TODO for batch operations (all files share `todoIndex: 0`)
- User clicks Apply once, all files updated

**Example - Before (WRONG):**
```json
{
  "todos": [
    {"text": "Update script1.py"},
    {"text": "Update script2.py"},
    {"text": "Update script3.py"}
  ],
  "fileChanges": [{"path": "script1.py", "todoIndex": 0}]
}
```

**Example - After (CORRECT):**
```json
{
  "todos": [{"text": "Update all scripts with third print value"}],
  "fileChanges": [
    {"path": "script1.py", "todoIndex": 0},
    {"path": "script2.py", "todoIndex": 0},
    {"path": "script3.py", "todoIndex": 0}
  ]
}
```

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

### Improvement #2: Fallback Pattern Chains - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

Fallback pattern chains enable the agent to try multiple glob patterns in order, stopping on the first match. This dramatically reduces failed file searches.

#### What Was Built

| Component | Description |
|-----------|-------------|
| `patterns` array in FileAction | Array of glob patterns to try in order |
| `required` flag | Marks if file is essential to the task |
| `fallbackAction` field | What to do if all patterns fail: `ask_user`, `skip`, `create_new` |
| Pattern iteration logic | Tries patterns sequentially, stops on first match |

#### Schema Changes (`config/planning-schema.json`)

```json
{
  "type": "file",
  "patterns": ["src/prompts/responseSchema.ts", "**/responseSchema.ts", "**/*Schema.ts"],
  "reason": "Schema definition",
  "required": true,
  "fallbackAction": "ask_user"
}
```

#### Pattern Strategy (from planning prompt)

Order patterns from most specific to broadest:

1. **EXACT PATH**: `"src/components/Button.tsx"`
2. **FILENAME GLOB**: `"**/Button.tsx"`
3. **DIRECTORY SCOPED**: `"src/components/**/*.tsx"`
4. **PARTIAL NAME**: `"**/*Button*.tsx"`
5. **EXTENSION ONLY** (last resort): `"**/*.tsx"`

#### Integration Points

1. **createPlan()** (`agentOrchestrator.ts` ~line 180):
   - Parses both `patterns` array and legacy `pattern` field
   - Converts single pattern to array for backward compatibility

2. **executeActions()** (`agentOrchestrator.ts` ~line 278):
   - Loops through patterns array
   - Shows progress with pattern count: `🔍 Searching: \`pattern\` (1/3)`
   - Logs when fallback succeeds
   - Shows all tried patterns on failure

3. **runFilesApiWorkflow()** (`agentOrchestrator.ts` ~line 791):
   - Same pattern iteration logic for Files API workflow

#### Example Progress Output

```
🔍 Searching: `src/prompts/responseSchema.ts` (1/3)
🔍 Searching: `**/responseSchema.ts` (2/3)
✅ Found 1 file(s) (150 lines)
   └─ responseSchema.ts
```

When all patterns fail:
```
⚠️ No files found matching [src/foo.ts, **/foo.ts, **/*foo*.ts] - tried 3 pattern(s)
```

#### Files Changed

| File | Changes |
|------|---------|
| `config/planning-schema.json` | +20 lines: patterns array, required, fallbackAction fields |
| `config/planning-prompt.json` | +60 lines: Pattern strategy guide, updated examples |
| `src/agent/actionTypes.ts` | +10 lines: Updated FileAction interface with optional fields |
| `src/agent/agentOrchestrator.ts` | +80 lines: Pattern iteration in executeActions and runFilesApiWorkflow |

#### Testing Checklist

- [ ] Single pattern (legacy) still works
- [ ] Multiple patterns tried in order
- [ ] First matching pattern stops iteration
- [ ] Fallback success logged with attempt number
- [ ] All patterns shown in failure message
- [ ] Files API workflow also uses pattern fallbacks

---

### Improvement #3: Directory Listing Tool - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

The directory listing tool enables AI to explore workspace directories when it doesn't know exact file locations, reducing pattern guessing and failed auto-loads.

#### What Was Built

| Component | Description |
|-----------|-------------|
| `DirectoryRequest` interface | Response schema field with path, recursive, filter properties |
| `DirectoryListingResult` type | Stores listing results with entries, error handling |
| `PendingDirectoryResults` type | Session storage for results pending injection |
| `_handleDirectoryRequests()` | Handler in ChatViewProvider that executes listings |
| `_listDirectory()` | Recursive directory walker with filter support |
| `storePendingDirectoryResults()` | Stores results in session for next turn |
| `buildDirectoryListingSummary()` | Generates markdown table for AI context |

#### Integration Points

1. **Response Schema** (`src/prompts/responseSchema.ts` and `config/response-schema.json`):
   - New `directoryRequests` field in `GrokStructuredResponse`
   - Added to `STRUCTURED_OUTPUT_SCHEMA` for API validation
   - Validation in `validateResponse()` function

2. **Session Storage** (`src/storage/chatSessionRepository.ts`):
   - `pendingDirectoryResults` field on `ChatSessionDocument`
   - `storePendingDirectoryResults()` to save results after AI response
   - `clearPendingDirectoryResults()` to clean up after injection
   - `buildDirectoryListingSummary()` to format results as markdown table

3. **Handler** (`src/views/ChatViewProvider.ts` ~line 3627):
   - `_handleDirectoryRequests()` called after AI response processing
   - Security: Blocks `..` traversal, limits recursive depth to 3
   - Glob filter support with simple `*` and `?` patterns
   - Max 100 entries per directory request

4. **Context Injection** (`src/views/ChatViewProvider.ts` ~line 3875):
   - Results injected into system prompt in `_buildMessages()`
   - Cleared after injection to avoid duplicate display

5. **System Prompt** (`config/system-prompt.json`):
   - New "DIRECTORY EXPLORATION" section with usage instructions
   - Example JSON showing directoryRequests usage

#### Example AI Response

```json
{
  "summary": "I need to see what files are in the prompts directory to find the schema.",
  "directoryRequests": [
    {"path": "src/prompts", "recursive": false, "filter": "*.ts"}
  ],
  "nextSteps": [{"html": "After listing, I'll identify the correct file", "inputText": "continue"}]
}
```

#### Example Context Injection (Next Turn)

```markdown
## 📁 DIRECTORY LISTING RESULTS
You requested these directory listings. Use exact paths to request specific files.

### 📂 src/prompts (filter: *.ts)
| Name | Type | Size |
|------|------|------|
| responseSchema.ts | 📄 file | 12.5 KB |
| responseParser.ts | 📄 file | 8.2 KB |
| jsonCleaner.ts | 📄 file | 5.1 KB |

*0 directories, 3 files*
```

#### Files Changed

| File | Changes |
|------|---------|
| `config/response-schema.json` | +3 lines: directoryRequests field example |
| `src/prompts/responseSchema.ts` | +40 lines: DirectoryRequest interface, validation, schema |
| `src/storage/chatSessionRepository.ts` | +120 lines: Types, storage/retrieval functions, summary builder |
| `src/views/ChatViewProvider.ts` | +180 lines: Handler, directory walker, context injection |
| `config/system-prompt.json` | +35 lines: DIRECTORY EXPLORATION section |

#### Security Considerations

- Path traversal (`..`) is blocked
- Paths must be relative to workspace root
- Recursive depth limited to 3 levels
- Max 100 entries per request
- Only workspace files are accessible

#### Testing Checklist

- [ ] Request directory listing → verify results stored
- [ ] Next message → verify results appear in AI context
- [ ] Results cleared after injection (don't appear twice)
- [ ] Recursive listing works with depth limit
- [ ] Filter (*.ts) correctly filters files
- [ ] Invalid path (..) returns error
- [ ] Non-existent directory returns error message

---

### Improvement #4: Proactive File Bundling - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

Proactive File Bundling automatically analyzes modified files for imports and related tests, then attaches those files to the next AI turn. This helps the AI maintain context about related code.

#### What Was Built

| Component | Description |
|-----------|-------------|
| `src/utils/importAnalyzer.ts` | New utility file with import parsing for TS/JS/Python |
| `ImportInfo` interface | Tracks import source, resolved path, and locality |
| `BundledFile` interface | Tracks bundled file path, type (import/test), and size |
| `analyzeImports()` | Parses file content for import statements |
| `findRelatedTests()` | Finds test files matching common naming patterns |
| `bundleRelatedFiles()` | Main function combining import analysis + test discovery |
| `BundledFileEntry` type | Session storage type for bundled files |
| `PendingBundledFiles` type | Session field for pending bundle injection |
| `storePendingBundledFiles()` | Stores bundled files after apply |
| `clearPendingBundledFiles()` | Clears after injection |
| `buildBundledFilesSummary()` | Generates markdown summary for AI context |
| `_bundleRelatedFilesForNextTurn()` | Handler in ChatViewProvider |

#### Integration Points

1. **Import Analyzer** (`src/utils/importAnalyzer.ts`):
   - TypeScript/JavaScript: `import ... from`, `require()`, `export ... from`
   - Python: `from ... import`, `import ...`
   - Resolves relative paths to absolute
   - Filters to local project files only

2. **Apply Edits Hook** (`src/views/ChatViewProvider.ts` ~line 3242):
   - `_bundleRelatedFilesForNextTurn()` called after edits applied
   - Analyzes each modified file for imports/tests
   - Stores results in session via `storePendingBundledFiles()`

3. **Context Injection** (`src/views/ChatViewProvider.ts` ~line 3973):
   - Checks for `pendingBundledFiles` in session
   - Injects summary table AND file contents with line numbers
   - Clears after injection

4. **Configuration** (`package.json`):
   - `grok.proactiveBundling`: Master toggle (default: true)
   - `grok.bundleImports`: Include imported files (default: true)
   - `grok.bundleTests`: Include test files (default: true)
   - `grok.maxBundledFiles`: Max files to bundle (default: 5)

#### Example Context Injection

```markdown
## 📦 AUTO-BUNDLED FILES
These files were automatically attached because they are related to files you modified.

### Imported Files
- 📄 src/utils/logger.ts (2.5 KB)
- 📄 src/api/grokClient.ts (8.1 KB)

### Test Files
- 🧪 src/utils/logger.test.ts (1.2 KB)

*Triggered by modifications to: src/views/ChatViewProvider.ts*

## 📦 BUNDLED FILE CONTENTS

### 📄 src/utils/logger.ts (MD5: abc123...)
```
1: export function debug(...args: any[]) {
2:     console.log('[DEBUG]', ...args);
3: }
...
```
```

#### Files Changed

| File | Changes |
|------|---------|
| `src/utils/importAnalyzer.ts` | +320 lines: New file with import parsing and bundling logic |
| `src/storage/chatSessionRepository.ts` | +80 lines: Types and storage functions for bundled files |
| `src/views/ChatViewProvider.ts` | +110 lines: Handler and context injection |
| `package.json` | +24 lines: Configuration settings |

#### Configuration

```json
{
    "grok.proactiveBundling": true,
    "grok.bundleImports": true,
    "grok.bundleTests": true,
    "grok.maxBundledFiles": 5
}
```

#### Testing Checklist

- [ ] Modify TypeScript file → verify imports bundled
- [ ] Modify Python file → verify imports bundled
- [ ] Modify file with tests → verify test files bundled
- [ ] Next message includes bundled file contents
- [ ] Max files limit respected
- [ ] Bundled files cleared after injection
- [ ] Bundling disabled when `proactiveBundling: false`

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

## Improvement #5: Continuation Memory Block - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

The Continuation Memory Block provides instant context recovery when the user says "continue". Instead of the AI re-deriving state from conversation history, a structured summary is injected with completed/pending todos, modified files, and files needing refresh.

### What Was Built

| Component | Description |
|-----------|-------------|
| `src/utils/memoryBuilder.ts` | New utility file for AI memory generation |
| `AIMemory` interface | Structured state: completedTodos, pendingTodos, modifiedFiles, filesNeedingRefresh, lastSummary, workingFiles |
| `isContinueMessage()` | Detects "continue", "proceed", "go on", "next", etc. |
| `buildAIMemory()` | Extracts state from session data |
| `buildMemoryBlock()` | Generates markdown block for context injection |

### Integration Points

1. **Memory Builder** (`src/utils/memoryBuilder.ts`):
   - Extracts completed/pending todos from session.todos
   - Builds modified files list from changeHistory
   - Identifies files needing refresh using fileRegistry
   - Gets last response summary from most recent pair
   - Lists active working files from recent turns

2. **Context Injection** (`src/views/ChatViewProvider.ts` ~line 4006):
   - `isContinueMessage()` detects continuation messages
   - `buildMemoryBlock()` generates context if useful data exists
   - Injected after bundled files, before system message push

3. **System Prompt** (`config/system-prompt.json`):
   - New "🧠 CONTINUATION CONTEXT (AI Memory)" section
   - Instructions on how to use the memory block
   - Example continuation response

### Memory Block Structure

```markdown
## 🧠 AI Memory (Continuation Context)

This is a continuation. Use this memory to resume efficiently without re-reading full history.

**Current Turn:** 5

### Last Response Summary
> Fixed the syntax error and added timeout wrappers.

### ✅ Completed Todos (2)
- [x] Fix syntax error in utils.py (line 45)
- [x] Add timeout wrapper to API calls

### ⏳ Pending Todos (2)
**Resume from the first uncompleted item:**

1. [ ] **Update tests for new timeout behavior**
   - *Details:* In src/tests/test_api.py, add test cases for timeout scenarios...
2. [ ] **Add error handling for timeout exceptions**
   - *Details:* In src/api.py lines 50-60, wrap async calls with try/catch...

### ⚠️ Files Needing Refresh
These files were modified since you last saw them. Request re-attachment before modifying:

- 📄 src/utils.py

### 📝 Modified Files This Session
| File | Turn Modified |
|------|---------------|
| utils.py | Turn 3 |
| api.py | Turn 4 |

### 📂 Active Working Files
Files you've recently worked with (last 3 turns):
- utils.py
- api.py

### 📋 Resumption Instructions
1. Check "Files Needing Refresh" before modifying any files
2. Resume from the first pending todo
3. Don't repeat completed work
4. If needed files aren't attached, ask for them
```

### Continue Message Detection

The following messages trigger memory injection:
- `continue`
- `go on`
- `proceed`
- `next`
- `keep going`
- `continue with...`
- `go ahead...`

### Files Changed

| File | Changes |
|------|---------|
| `src/utils/memoryBuilder.ts` | +210 lines: New file with AIMemory interface, isContinueMessage(), buildAIMemory(), buildMemoryBlock() |
| `src/views/ChatViewProvider.ts` | +12 lines: Import memoryBuilder, inject memory block on continue |
| `config/system-prompt.json` | +30 lines: CONTINUATION CONTEXT section with usage instructions |

### Benefits

- **Zero-cost state recovery**: AI doesn't need to re-parse conversation
- **Clear resumption point**: Pending todos with details show exactly what to do
- **Stale file detection**: Files needing refresh are highlighted
- **Reduced hallucination**: Completed work is explicitly listed
- **Efficient tokens**: Only injected on "continue", not every turn

### Testing Checklist

- [ ] Send "continue" after multi-step task → verify memory block appears
- [ ] Check completed todos are listed correctly
- [ ] Check pending todos include aiText details
- [ ] Verify files needing refresh detection works
- [ ] Test different continue phrases ("proceed", "go on", etc.)
- [ ] Verify memory not injected on first message (pairs.length <= 1)

---

## Improvement #6: Sub-Task Spawning (Phase 2) - IMPLEMENTED ✅

**Date Implemented:** 2024-12-28

Sub-Task Spawning allows the AI to propose independent sub-tasks for complex work, enabling parallel execution with dependency management. This is Phase 2 of the autonomy roadmap.

### What Was Built

| Component | Description |
|-----------|-------------|
| `src/agent/subTaskManager.ts` | New file with SubTask interface, SubTaskManager class |
| `SubTask` interface | Full task data: id, goal, files, dependencies, status, result |
| `SubTaskRequest` interface | AI response format (responseSchema.ts) |
| `SubTaskRegistryData` | Session storage type for sub-task persistence |
| `validateSubTasks()` | Validates subTasks from AI response |
| `SubTaskManager` class | Manages lifecycle: pending → ready → running → completed |
| `storeSubTaskRegistry()` | Persists sub-tasks to Couchbase |
| `updateSubTaskStatus()` | Updates individual task status |
| `buildSubTasksSummary()` | Generates markdown for AI context injection |
| `_handleSubTasks()` | Handler in ChatViewProvider |
| `_executeSubTask()` | Runs a sub-task in current session |
| `_skipSubTask()` | Skips a sub-task (user choice) |

### Integration Points

1. **Response Schema** (`src/prompts/responseSchema.ts`):
   - New `SubTaskRequest` interface
   - Added to `GrokStructuredResponse.subTasks`
   - Added to `STRUCTURED_OUTPUT_SCHEMA` for API validation
   - Validation in `validateResponse()`

2. **Session Storage** (`src/storage/chatSessionRepository.ts`):
   - `SubTaskData` and `SubTaskRegistryData` types
   - `subTaskRegistry` field on `ChatSessionDocument`
   - CRUD functions for sub-task persistence

3. **ChatViewProvider** (`src/views/ChatViewProvider.ts`):
   - `_handleSubTasks()` processes AI proposals
   - `_executeSubTask()` runs tasks
   - `_skipSubTask()` handles user skips
   - Message handlers: `executeSubTask`, `skipSubTask`
   - Context injection in `_buildMessages()`

4. **System Prompt** (`config/system-prompt.json`):
   - New "📋 SUB-TASKS (Parallel Work Decomposition)" section
   - Instructions on when/how to use sub-tasks
   - Example sub-task response

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
| **Phase 2 (Implemented)** | Semi-automated | AI proposes sub-tasks, user approves batch |
| Phase 3 | Fully automated | AI spawns and manages sub-tasks autonomously |

### Files Changed

| File | Changes |
|------|---------|
| `src/agent/subTaskManager.ts` | +330 lines: New file with SubTask interface, SubTaskManager class, validation |
| `src/prompts/responseSchema.ts` | +50 lines: SubTaskRequest interface, validation, STRUCTURED_OUTPUT_SCHEMA |
| `src/storage/chatSessionRepository.ts` | +160 lines: SubTaskData types, registry CRUD functions, buildSubTasksSummary() |
| `src/views/ChatViewProvider.ts` | +210 lines: Imports, handlers, message cases, context injection |
| `config/response-schema.json` | +10 lines: subTasks field example |
| `config/system-prompt.json` | +50 lines: SUB-TASKS section with usage instructions |

### Testing Checklist

- [ ] AI proposes sub-tasks in response → verify stored in session
- [ ] Tasks with no dependencies start as "ready"
- [ ] Tasks with dependencies start as "pending"
- [ ] UI receives subTasksUpdate message
- [ ] Execute sub-task → task runs and status updates
- [ ] Skip sub-task → status changes to "skipped"
- [ ] Dependent tasks become ready when deps complete
- [ ] Sub-task summary injected into AI context
- [ ] Session reload preserves sub-task registry

---

## Implementation Priority

| # | Improvement | Effort | Impact | Priority | Status |
|---|-------------|--------|--------|----------|--------|
| 1 | File Registry System | Medium | High | **P0** | ✅ Done |
| 2 | Fallback Pattern Chains | Low | Medium | **P1** | ✅ Done |
| 3 | Directory Listing Tool | Low | Medium | **P1** | ✅ Done |
| 4 | Proactive File Bundling | Medium | Medium | **P2** | ✅ Done |
| 5 | Continuation Memory Block | Low | High | **P0** | ✅ Done |
| 6 | Sub-Task Spawning | High | High | **P2** | ✅ Done |

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
