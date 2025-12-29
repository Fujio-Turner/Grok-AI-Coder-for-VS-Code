# Chat Flow Design

## Architecture Diagram

```mermaid
flowchart TD
    subgraph User["👤 User"]
        A[Send Message]
        K[Review & Continue]
        L[Provide Guidance]
    end
    
    subgraph Webview["🖥️ Webview"]
        B[doSend - Post message]
        M[Render Response]
        N[Show TODOs Progress]
        O[Display Next Steps]
    end
    
    subgraph Extension["⚙️ ChatViewProvider"]
        C[Create ChatRequest]
        D[Save to Couchbase - pending]
        E[Agent Workflow - Load files]
        F[Build messages array]
        G[Call Grok API - streaming]
        H[Parse Response]
        I[Save Structured Data]
        J[Apply File Changes]
        P{Complex Task?<br/>3+ steps}
    end
    
    subgraph MultiStep["🔄 Multi-Step Handler"]
        Q[Create TODO list - ALL steps]
        R[Execute 1-2 steps only]
        S[Add 'continue' to nextSteps]
        T[Wait for user]
    end
    
    A --> B --> C --> D --> E --> F --> G --> H --> P
    P -->|No| I --> J --> M
    P -->|Yes| Q --> R --> S --> I --> J --> M --> N --> O --> T
    T --> K --> B
    L -.->|Course correction| B
    
    style MultiStep fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style P fill:#7c3aed,stroke:#fff,color:#fff
```

[View/Edit on Mermaid Live](https://mermaid.live)

---

## Complete Flow

### 1. **Webview (User Click)**
- `doSend()` gets text from textarea, clears input
- Posts `{type:'sendMessage', text, images}` to extension

### 2. **ChatViewProvider.sendMessage()**
- Creates `ChatRequest` with timestamp
- **Saves to Couchbase** with `status: 'pending'`
- Sends `newMessagePair` → webview renders user bubble + spinner

### 3. **Agent Workflow - Three-Pass System** (if no images)

The agent uses a three-pass workflow to intelligently load files before the main API call:

**Pass 1: Planning** (`createPlan`)
- Fast model (`grok-3-mini`) analyzes the request
- Creates a plan with TODOs and actions (file patterns, URLs)
- Example: User says "review email.py" → Plan includes `{"type": "file", "pattern": "**/email*.py"}`

**Pass 2: Execution** (`executeActions`)
- Runs `vscode.workspace.findFiles()` for each file pattern
- Reads file contents via `vscode.workspace.openTextDocument()`
- **Computes MD5 hash** for each file (for verification later)
- Fetches any URLs mentioned in the plan
- Reports failed searches explicitly (so AI doesn't hallucinate)

**Pass 3: Augmented Message** (`buildAugmentedMessage`)
- Combines original message + loaded files + plan
- Each file includes its MD5 hash: `### file.py [MD5: 9a906fd...]`
- Failed searches are noted: `⚠️ FILE SEARCH FAILED - DO NOT PRETEND YOU HAVE ACCESS`
- This augmented message is sent to Pass 4

Shows progress: "🧠 Planning..." → "🔍 Searching..." → "✅ Loaded X files"

### 4. **Main API Call**
- Builds messages array (system prompt + history + user message)
- Calls `sendChatCompletion()` with streaming
- Each chunk → `updateResponseChunk` → webview shows partial text
- **If `useStructuredOutputs` enabled**: API guarantees valid JSON response (no parsing errors possible)

### 5. **SAVE EARLY** (new!)
- Immediately saves raw response text to Couchbase
- Prevents data loss if parsing crashes

### 6. **Parse Response**
- **If Structured Outputs enabled**: Response is already guaranteed valid JSON - direct parse
- Otherwise: Tries `parseResponse()` (regex-based JSON repair)
- If fails + cleanup enabled → `cleanJsonWithModel()` (AI fixes JSON)
- Extracts: `summary`, `sections`, `todos`, `fileChanges`, `commands`, `nextSteps`
- **If parsing fails with partial recovery** → Shows Recovery Banner with Retry/Continue buttons

### 7. **Save Structured Response**
- Updates Couchbase with full `structured` data
- Records usage (tokens, cost)

### 8. **File Changes** (if any)
- Resolves paths, validates changes
- Calculates diff stats (+added/-removed)
- If `autoApply` → writes files immediately

### 9. **Render Final Output**
- Sends `requestComplete` with `structured` + `diffPreview`
- Webview calls `fmtFinalStructured()` to build HTML:
  - Summary paragraph
  - Sections with headings
  - Code blocks with syntax highlighting
  - File changes with Apply buttons
  - Commands with Run buttons
  - Next Steps buttons (structured format: `{html, inputText}`)
  - "What was done" summary
  - Status bar with action buttons + token count:
    - **✓ Done** (green) - All actions complete
    - **⏳ Pending** (amber) - File changes or CLI commands still need action
- Caches HTML in webview state
- Scrolls to bottom
- **Activates Sticky Summary Bar** if summary/nextSteps scroll out of view

---

## TODO Tracking & Completion

### Overview

TODOs are tracked server-side in Couchbase and linked to file changes via `todoIndex`. When a file change is applied, the linked TODO is automatically marked complete - eliminating the previous mis-sync between UI and actual work done.

### Architecture

```mermaid
flowchart TD
    subgraph AIResponse["🤖 AI Response"]
        A[AI generates todos array] --> B[AI generates fileChanges]
        B --> C[Each fileChange includes<br/>todoIndex: N]
    end
    
    subgraph Apply["⚡ Apply Changes"]
        D[User clicks Apply] --> E[ChatViewProvider.applyEdits]
        E --> F[Extract todoIndex from<br/>each fileChange]
        F --> G[Apply file changes to disk]
    end
    
    subgraph Persist["💾 Couchbase Update"]
        G --> H{File apply<br/>successful?}
        H -->|Yes| I[markTodoCompleted<br/>Sub-doc API]
        I --> J[Update todos N .completed = true]
        J --> K[Collect completedTodoIndexes]
    end
    
    subgraph Webview["🖥️ UI Update"]
        K --> L[Post editsApplied message<br/>with completedTodoIndexes]
        L --> M[Webview marks specific<br/>TODOs as complete]
        M --> N[renderTodos updates UI<br/>with correct count]
    end
    
    style AIResponse fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Apply fill:#2a2a1a,stroke:#dcdcaa,color:#fff
    style Persist fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Webview fill:#2a1a3a,stroke:#c94eb0,color:#fff
```

### Schema Changes

**FileChange interface** (`src/prompts/responseSchema.ts`):
```typescript
export interface FileChange {
    path: string;
    language: string;
    content: string;
    lineRange?: { start: number; end: number };
    isDiff?: boolean;
    lineOperations?: LineOperation[];
    todoIndex?: number;  // 0-indexed link to todos array
}
```

**AI Response Example**:
```json
{
  "todos": [
    { "text": "Update greet function", "completed": false },
    { "text": "Update add function", "completed": false },
    { "text": "Run tests", "completed": false }
  ],
  "fileChanges": [
    {
      "path": "src/utils.py",
      "content": "...",
      "todoIndex": 0
    }
  ]
}
```

### Sub-Document API for TODO Updates

To efficiently update a single TODO without fetching the entire document (which can grow to 15MB+), we use the Couchbase sub-document API:

```typescript
// chatSessionRepository.ts
export async function markTodoCompleted(
    sessionId: string, 
    todoIndex: number
): Promise<boolean> {
    const client = getCouchbaseClient();
    
    const ops: SubdocOp[] = [
        { type: 'upsert', path: `todos[${todoIndex}].completed`, value: true },
        { type: 'upsert', path: 'updatedAt', value: new Date().toISOString() }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    return result.success;
}
```

**Benefits**:
- Only 2 sub-doc operations (within 16 element limit)
- No full document fetch/replace cycle
- Atomic update at specific array index

### Message Flow

| Step | Component | Action |
|------|-----------|--------|
| 1 | AI | Returns `fileChanges` with `todoIndex` linking to `todos` array |
| 2 | ChatViewProvider | Extracts `todoIndex` from each fileChange during apply |
| 3 | ChatViewProvider | After successful apply, calls `markTodoCompleted(sessionId, todoIndex)` |
| 4 | Couchbase | Sub-doc API updates `todos[N].completed = true` |
| 5 | ChatViewProvider | Posts `editsApplied` with `completedTodoIndexes: [0, 1, ...]` |
| 6 | Webview | Receives message, marks those specific TODOs complete in `currentTodos` |
| 7 | Webview | Calls `renderTodos()` to update UI with correct count |

### System Prompt Instructions

The AI is instructed (in `config/system-prompt.json`):

```
**LINK fileChanges to todos using todoIndex.**

- Each fileChange SHOULD include a `todoIndex` field (0-indexed) pointing to the todo it completes
- When a file change is applied, the linked todo will automatically be marked complete
- Example: `{"path": "src/foo.py", "content": "...", "todoIndex": 0}` links to todos[0]
- Do NOT set `completed: true` on todos - the UI marks them complete when the change is applied
- If a fileChange doesn't relate to a specific todo, omit todoIndex
```

### Before vs After

| Aspect | Before | After |
|--------|--------|-------|
| TODO tracking | Webview only (client-side) | Couchbase + Webview (server-side) |
| Completion logic | Mark "next uncompleted" TODO | Mark specific TODO by `todoIndex` |
| Sync accuracy | Often mis-synced | Always accurate |
| Persistence | Lost on refresh | Persisted in session document |

---

## Sticky Summary Bar

When AI responses are long and the user scrolls down, the summary and next-step buttons can scroll out of view. The **Sticky Summary Bar** ensures users always know what happened and can take action.

### How It Works

```mermaid
flowchart TD
    subgraph Detection["🔍 Visibility Detection"]
        A[Response Complete] --> B[Store summary + nextSteps]
        B --> C[User Scrolls]
        C --> D{Summary visible<br/>in viewport?}
    end
    
    subgraph Sticky["📌 Sticky Bar"]
        D -->|No| E[Show sticky bar at bottom]
        D -->|Yes| F[Hide sticky bar]
        E --> G[Truncated summary text]
        E --> H[Next step buttons - max 3]
        E --> I[See details ↑ button]
        E --> J[Dismiss ✕ button]
    end
    
    subgraph Actions["⚡ User Actions"]
        H --> K[Click next step → fills input]
        I --> L[Scrolls to response]
        J --> M[Hides bar permanently]
    end
    
    style Detection fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Sticky fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Actions fill:#2a1a3a,stroke:#c94eb0,color:#fff
```

### UI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                         Chat Messages                           │
│                              ...                                │
│                    (summary scrolled away)                      │
├─────────────────────────────────────────────────────────────────┤
│  ✓ Added type hints to fibonacci function...  [See details ↑] ✕│
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  Continue... │  │  Run tests   │  │  Apply fix   │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
│                        Input Area                               │
└─────────────────────────────────────────────────────────────────┘
```

### Behavior

| Trigger | Result |
|---------|--------|
| Response completes | Summary + nextSteps stored |
| User scrolls summary out of view | Sticky bar appears with slide-up animation |
| User scrolls summary back into view | Sticky bar hides |
| Click next step button | Fills input with `inputText`, hides bar |
| Click "See details ↑" | Smooth scrolls to response, hides bar |
| Click dismiss (✕) | Hides bar permanently for this response |
| New message sent | Clears sticky state |
| Session change | Clears sticky state |

---

## Auto CLI Execution

### Overview

The extension supports automatic execution of CLI commands with a whitelist-based safety system. This enables iterative workflows where the AI can run commands, analyze output, and fix issues automatically.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.autoApply` | `true` | Master toggle for auto-apply (A=Auto) |
| `grok.autoApplyFiles` | `true` | Auto-apply file changes (CRUD) when Auto mode enabled |
| `grok.autoApplyCli` | `false` | Auto-execute CLI commands when Auto mode enabled |
| `grok.cliWhitelist` | ~40 commands | Allowed command prefixes for auto-execution |

### How It Works

```mermaid
flowchart TD
    subgraph Detection["🔍 Command Detection"]
        A[AI Response contains<br/>🖥️ command] --> B{Auto mode<br/>enabled?}
        B -->|No| C[Show Run button only]
        B -->|Yes| D{autoApplyCli<br/>enabled?}
        D -->|No| C
        D -->|Yes| E{Command<br/>whitelisted?}
    end
    
    subgraph Execution["⚡ Auto Execution"]
        E -->|Yes| F[Execute command<br/>automatically]
        E -->|No| G[Prompt user:<br/>Run Once / Add & Run / Skip]
        G -->|Run Once| F
        G -->|Add & Run| H[Add to whitelist]
        H --> F
        G -->|Skip| I[Do nothing]
    end
    
    subgraph Feedback["🔄 Feedback Loop"]
        F --> J[Capture stdout/stderr]
        J --> K[Display output in chat]
        J --> L[Send output to AI<br/>for analysis]
        L --> M[AI can fix issues<br/>or continue workflow]
    end
    
    style Detection fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Execution fill:#2a1a3a,stroke:#c94eb0,color:#fff
    style Feedback fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

### Whitelist System

Commands are matched by **prefix**. A command like `npm run build` is allowed if `npm run` is in the whitelist.

**Default Whitelist:**
```
npm install, npm run, npm test, yarn install, yarn add, yarn test, yarn build,
pnpm install, pnpm run, git status, git diff, git log, git branch,
ls, pwd, cat, head, tail, grep, find, mkdir, touch, echo,
curl, wget, cp, mv,
tsc, tsc --noEmit, python, python3, pip install, pip3 install,
cargo build, cargo run, cargo test, cargo check, go build, go run, go test
```

**Dangerous commands excluded**: `rm` is intentionally NOT whitelisted. Users will be prompted before any delete operations.

### Run All Commands Button (AI-in-the-Loop)

When a response contains multiple CLI commands, the status bar shows a **"Run X cmds"** button:

```
┌─────────────────────────────────────────────────────────────────┐
│  ⏳ Pending    ✓ 1 applied    [Run 11 cmds]       38,016 tokens │
└─────────────────────────────────────────────────────────────────┘
```

Clicking this button starts **sequential AI-supervised execution**:

```mermaid
flowchart TD
    subgraph Loop["🔄 Command Loop"]
        A[Run Command 1] --> B[Show Output + Summary]
        B --> C[Send to AI for Analysis]
        C --> D{AI Response}
        D -->|"continue"| E[Run Next Command]
        D -->|"stop/error"| F[Pause Execution]
        D -->|New Command| G[Run AI's Command Instead]
        E --> B
        G --> B
    end
    
    subgraph Summary["📊 Progress Tracking"]
        H[Command X/Y ✓ or ✗]
        I[Output preview]
        J[✓ N succeeded, ✗ M failed]
        K[Remaining commands list]
    end
    
    style Loop fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Summary fill:#2a2a1a,stroke:#dcdcaa,color:#fff
```

**How it works:**
1. First command runs, output displayed with progress summary
2. Summary sent to AI with remaining commands list
3. AI analyzes and responds:
   - Says **"continue"** → next command runs automatically
   - Says **"stop"** or mentions error → execution pauses
   - Suggests different command → AI's command runs instead
4. Loop continues until all done or AI stops it

**Example flow:**
```
Command 1/5 ✓
`mkdir -p app/assets`
Output: (no output)
Progress: ✓ 1 succeeded, ✗ 0 failed
Remaining: curl..., curl..., curl...

→ AI: "Directory created. Continue."
→ [Auto-runs next command]

Command 2/5 ✗
`curl -o file.png https://invalid-url`
Output: curl: (6) Could not resolve host
Progress: ✓ 1 succeeded, ✗ 1 failed

→ AI: "The URL is invalid. Let me fix it..."
→ AI suggests: `curl -o file.png https://correct-url`
→ [Runs AI's corrected command]
```

This enables intelligent error recovery - if `mkdir` fails, AI can check `pwd`, fix the path, and retry.

### Feedback Loop

When a command executes, the output is automatically sent back to the AI:

```
I ran the command: `npm run build`

Output:
```
src/utils.ts(15,10): error TS2322: Type 'string' is not assignable to type 'number'.
```

Please analyze this output.
```

This enables workflows like:
1. User: "Fix the TypeScript errors"
2. AI: Suggests fix + includes `🖥️ tsc --noEmit` command
3. Command auto-executes → output shows remaining errors
4. AI: Analyzes output, suggests next fix
5. Repeat until build passes

### CLI Summary Panel

A sticky panel appears at the bottom during batch command execution:

```
┌─────────────────────────────────────────────────────────────────┐
│  🖥️ CLI Execution           ✓ 3  ✗ 1    4/8           [✕]     │
├─────────────────────────────────────────────────────────────────┤
│  ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (50%)             │
├─────────────────────────────────────────────────────────────────┤
│  ✓ mkdir -p app/assets/css                                     │
│  ✓ curl -o file.png https://...         HTTP 200 OK            │
│  ✓ curl -o logo.svg https://...         HTTP 200 OK            │
│  ✗ curl -o missing.png https://...      404 Not Found          │
├─────────────────────────────────────────────────────────────────┤
│  Next: `python app.py`, `npm run build`                        │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Progress bar fills as commands complete
- Turns red if any command fails
- Shows each command with ✓/✗ status and output preview
- Shows remaining commands queue
- Closeable when done - no scrolling needed

### Security Considerations

- **Whitelist-only by default**: `autoApplyCli` is `false` by default
- **Prefix matching**: Only commands starting with whitelisted prefixes execute
- **User prompt for unknowns**: Non-whitelisted commands require explicit user action
- **Timeout protection**: Commands timeout after 30 seconds
- **Output truncation**: Output capped at 3KB for AI feedback, 5KB for display
- **Dangerous commands excluded**: `rm` is NOT in the default whitelist

---

## File Change Safety & Rollback

### MD5 Hash Verification (File Integrity)

The AI **cannot read files from disk**. It only sees files that are:
1. Attached to the conversation by the user
2. Loaded by the agent workflow (Pass 2)

To prevent the AI from hallucinating file content, we use **MD5 hash verification**:

```mermaid
flowchart TD
    subgraph Pass2["⚙️ Pass 2: File Loading"]
        A[findAndReadFiles pattern] --> B{Files found?}
        B -->|Yes| C[Read file content]
        C --> D[Compute MD5 hash]
        D --> E[Store content + hash]
    end
    
    subgraph Augment["📝 Augmented Message"]
        E --> F["Include hash in message:<br/>### file.py [MD5: 9a906fd...]"]
        F --> G[Tell AI: 'Include this hash<br/>in fileHashes when modifying']
    end
    
    subgraph Pass3["🤖 Pass 3: AI Response"]
        G --> H[AI includes fileHashes:<br/>{'file.py': '9a906fd...'}]
    end
    
    subgraph Verify["✓ Verification"]
        H --> I[Extension reads current file]
        I --> J[Compute current MD5]
        J --> K{Hashes match?}
        K -->|Yes| L[Apply lineOperations]
        K -->|No| M[BLOCK - file changed<br/>or AI hallucinated]
    end
    
    subgraph Failed["🚫 Failed Search"]
        B -->|No| N["Add to augmented message:<br/>⚠️ FILE SEARCH FAILED"]
        N --> O[AI told: 'Do NOT pretend<br/>you have access']
    end
    
    style Pass2 fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Verify fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Failed fill:#3a1a1a,stroke:#c44,color:#fff
```

**How it works:**

| Step | Location | Action |
|------|----------|--------|
| 1. File Read | `workspaceFiles.ts` | Compute MD5 when reading file |
| 2. Augment | `agentOrchestrator.ts` | Include `[MD5: hash]` with each file |
| 3. AI Response | AI returns | Echo hash in `fileHashes` field |
| 4. Verify | `ChatViewProvider.ts` | Compare provided hash with current file |
| 5. Apply/Block | `ChatViewProvider.ts` | Apply if match, BLOCK if mismatch |

**Error scenarios:**

| Scenario | Result |
|----------|--------|
| AI provides correct hash | ✅ Operations applied |
| AI provides wrong hash | ❌ BLOCKED - "Hash mismatch" |
| AI provides no hash | ❌ BLOCKED - "No hash provided" |
| File changed after AI read it | ❌ BLOCKED - "Hash mismatch" |
| File search returned no results | AI told to ask user to attach file |

**Response schema includes `fileHashes`:**
```json
{
  "summary": "Modified the greeting function.",
  "fileHashes": {
    "docs/rollback_test.py": "9a906fd5909d29c5f1d228db1eaa90c4"
  },
  "fileChanges": [{
    "path": "docs/rollback_test.py",
    "lineOperations": [...]
  }]
}
```

### Pair File History (Multi-Turn File Tracking)

When the AI modifies a file and the user says "continue", the AI often uses **stale content from earlier in the conversation**, causing hash mismatches. The **Pair File History** system tracks all file operations per conversation turn so the AI knows when to re-read files.

```mermaid
flowchart TD
    subgraph Turn1["🔵 Turn 1: First Read"]
        A[User: 'modify utils.py'] --> B[Auto-attach file]
        B --> C[Compute MD5: abc123]
        C --> D[Track: READ utils.py abc123]
        D --> E[AI provides lineOperations]
        E --> F[User clicks Apply]
        F --> G[File changes on disk]
        G --> H[Track: UPDATE utils.py def456]
    end
    
    subgraph Turn2["🟡 Turn 2: Continue"]
        I[User: 'continue'] --> J[Load pairFileHistory]
        J --> K{Was file modified<br/>in previous turn?}
        K -->|Yes| L[Auto-attach with NEW MD5]
        K -->|No| M[Use cached content]
        L --> N[Track: READ utils.py def456]
        N --> O[AI uses correct content]
    end
    
    subgraph Problem["❌ Without Tracking"]
        P[User: 'continue'] --> Q[AI uses OLD content<br/>from Turn 1]
        Q --> R[AI provides hash abc123]
        R --> S[Actual file hash: def456]
        S --> T[HASH MISMATCH - BLOCKED]
    end
    
    style Turn1 fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Turn2 fill:#3a3a1a,stroke:#dea54e,color:#fff
    style Problem fill:#3a1a1a,stroke:#c44,color:#fff
```

**Couchbase Storage:**

```json
{
  "pairFileHistory": [
    [
      {"file": "/path/utils.py", "md5": "abc123", "op": "read", "dt": 1703123456789, "size": 2500}
    ],
    [
      {"file": "/path/utils.py", "md5": "abc123", "op": "update", "dt": 1703123500000, "size": 2800}
    ],
    [
      {"file": "/path/utils.py", "md5": "def456", "op": "read", "dt": 1703123600000, "size": 2800}
    ]
  ]
}
```

**Operation Types:**

| Operation | When Tracked | Purpose |
|-----------|--------------|---------|
| `read` | Auto-attach reads file | AI saw this content |
| `update` | User applies file changes | File is now different |
| `create` | User applies new file | File now exists |
| `delete` | User deletes file | File no longer exists |

**System Prompt Injection:**

The file history is summarized and injected into the system prompt:

```
## FILE OPERATION HISTORY (Recent)
These are files you have read or modified. Re-read files before modifying to get current MD5.

Turn 0:
  📖 read: /path/utils.py (md5: abc123...)
Turn 1:
  ✏️ update: /path/utils.py (md5: def456...)
Turn 2:
  📖 read: /path/utils.py (md5: def456...)
```

**AI Instruction Added:**

The system prompt now includes a critical section instructing the AI:

> **CRITICAL: ALWAYS RE-READ FILES BEFORE MODIFYING**
> 
> File content changes between conversation turns. When you previously modified a file and the user says "continue":
> 1. DO NOT use cached/remembered file content from earlier
> 2. DO NOT compute MD5 from old content - the file has been updated!
> 3. ASK for the file to be re-attached so you can see its CURRENT state
> 4. Check the FILE OPERATION HISTORY section

### Truncation Protection

The extension **blocks ALL file changes** from truncated responses to prevent file corruption:

```mermaid
flowchart TD
    subgraph Detection["🔍 Truncation Detection"]
        A[AI Response] --> B{Response complete?}
        B -->|Yes| C[Parse & Validate]
        B -->|No| D[Truncation Detected]
    end
    
    subgraph Blocking["🚫 Protection"]
        D --> E[Block ALL file changes]
        E --> F[Show error message]
        F --> G[Log to Couchbase]
        G --> H[User must retry]
    end
    
    subgraph Apply["✓ Safe to Apply"]
        C --> I{Valid changes?}
        I -->|Yes| J[Apply with rollback backup]
        I -->|No| K[Block suspicious changes]
    end
    
    style Detection fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Blocking fill:#3a1a1a,stroke:#c44,color:#fff
    style Apply fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

**Truncation is detected when:**
- Summary contains "truncated"
- Response text < 200 chars but has file changes
- Response doesn't end with `}` (incomplete JSON)

**When detected:**
```
🚫 BLOCKED: 3 file change(s) from truncated response.
The response was cut off mid-stream. NO changes have been applied.
```

### Rollback System

Every file change is tracked with full content snapshots for reliable rollback:

```
┌─────────────────────────────────────────────────────────────────┐
│  Change History                                    [◀ Rewind]   │
├─────────────────────────────────────────────────────────────────┤
│  ● Change #3 - 2 files (+45 -12) - $0.02 - 3s ago              │
│  ○ Change #2 - 1 file (+10 -3) - $0.01 - 5m ago                │
│  ○ Change #1 - 3 files (+120 -0) - $0.03 - 10m ago             │
└─────────────────────────────────────────────────────────────────┘
```

**Two-tier rollback:**
1. **Primary (fast)**: In-memory snapshots during session
2. **Fallback (persistent)**: Stored `oldContent` in Couchbase

The fallback ensures rollback works even after:
- Extension reload
- VS Code restart
- Session switch

**Rollback error handling:**

When rollback is attempted, the system detects if changes were never actually applied:

| Scenario | Behavior |
|----------|----------|
| `oldContent === newContent` | Change was never applied (lineOperations failed) |
| `applied: false` | Nothing to revert |
| Hash mismatch blocked the change | Nothing to revert |

If rollback encounters failed changes, the user sees:
```
⚠️ 2 change(s) failed to apply originally (AI hallucinated file content). 
These cannot be rolled back.
```

This prevents confusion when users try to rollback changes that were blocked by validation.

### Change History Data (Couchbase)

```json
{
  "changeHistory": {
    "history": [
      {
        "id": "cs-1703123456789",
        "sessionId": "session-uuid",
        "timestamp": "2025-12-25T08:00:00.000Z",
        "files": [
          {
            "filePath": "/path/to/file.ts",
            "fileName": "file.ts",
            "oldContent": "// original content...",
            "newContent": "// modified content...",
            "stats": { "added": 10, "removed": 3, "modified": 2 },
            "isNewFile": false
          }
        ],
        "totalStats": { "added": 10, "removed": 3, "modified": 2 },
        "applied": true
      }
    ],
    "position": 0
  }
}
```

---

## xAI Files API Integration (Experimental)

### Overview

The xAI Files API enables uploading files to xAI's servers, where the AI uses a server-side `document_search` tool to intelligently search and reason over file contents. This is an alternative to embedding file content directly in prompts.

### Comparison: Embedded vs Files API

| Aspect | Current (Embedded) | Files API |
|--------|-------------------|-----------|
| **Hallucination** | MD5 hash verification needed | Server-side search - AI reads *actual* content |
| **Token Usage** | Full file in prompt | Efficient server-side processing |
| **Large Files** | Truncation risk | 48MB limit, handled efficiently |
| **Multi-turn** | Re-attach each turn | Files persist across conversation |
| **Search** | AI sees all or nothing | AI can search multiple times |
| **Cost** | Tokens only | Tokens + $10/1K document_search calls |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.useFilesApi` | `false` | Enable Files API (experimental) |
| `grok.autoUploadFiles` | `true` | Auto-upload files from agent workflow |
| `grok.maxUploadSize` | 10MB | Maximum file size to upload |
| `grok.cleanupFilesOnSessionEnd` | `true` | Enable cleanup logic when session ends |
| `grok.fileTtlHours` | 24 | Hours to keep files before cleanup |

### File Lifecycle & TTL

Files uploaded to xAI persist indefinitely until explicitly deleted. The extension provides TTL-based cleanup:

```mermaid
flowchart TD
    subgraph Upload["📤 File Upload"]
        A[Agent workflow identifies files] --> B[Upload to xAI Files API]
        B --> C[Get file_id]
        C --> D[Store record in session]
    end
    
    subgraph Chat["💬 Chat with Files"]
        D --> E[Include file_id in message]
        E --> F[AI uses document_search tool]
        F --> G[Server-side file access]
    end
    
    subgraph Cleanup["🧹 TTL Cleanup"]
        H[Session switch] --> I{fileTtlHours?}
        I -->|0| J[Delete immediately]
        I -->|>0| K[Set expiresAt timestamp]
        I -->|-1| L[Never auto-delete]
        K --> M[Global cleanup on next session load]
        M --> N[Delete expired files from xAI]
    end
    
    subgraph Rehydrate["♻️ Rehydration"]
        O[Return to old session] --> P{File expired?}
        P -->|Yes| Q[Re-upload from local path]
        P -->|No| R[Use existing file_id]
    end
    
    style Upload fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Chat fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Cleanup fill:#3a1a1a,stroke:#c44,color:#fff
    style Rehydrate fill:#2a2a1a,stroke:#dcdcaa,color:#fff
```

### TTL Behavior

| `fileTtlHours` | Behavior |
|----------------|----------|
| `0` | Delete immediately on session switch (legacy) |
| `24` (default) | Mark with 24h expiration, cleanup on next session load |
| `-1` | Never auto-delete (manual cleanup only) |

### Uploaded File Record (Couchbase)

```json
{
  "uploadedFiles": [
    {
      "fileId": "file-abc123",
      "localPath": "/path/to/file.ts",
      "filename": "file.ts",
      "size": 2048,
      "uploadedAt": "2025-12-26T10:00:00.000Z",
      "hash": "9a906fd5909d29c5f1d228db1eaa90c4",
      "expiresAt": "2025-12-27T10:00:00.000Z"
    }
  ]
}
```

### API Functions

| Function | Location | Purpose |
|----------|----------|---------|
| `uploadFile()` | fileUploader.ts | Upload file to xAI |
| `deleteFile()` | fileUploader.ts | Delete file from xAI |
| `rehydrateFile()` | fileUploader.ts | Re-upload if file expired |
| `fileExists()` | fileUploader.ts | Check if file_id still valid |
| `setFileTtl()` | chatSessionRepository.ts | Set expiration time |
| `getExpiredFilesGlobal()` | chatSessionRepository.ts | Query all sessions for expired files |
| `needsRehydration()` | chatSessionRepository.ts | Check if file needs re-upload |

### Model Requirements

Files API requires **agentic-capable models**:
- ✅ `grok-4`
- ✅ `grok-4-fast`
- ❌ `grok-3-mini` (doesn't support agentic tools)

---

## Structured Outputs (Guaranteed JSON)

### The Problem: Malformed JSON

AI responses are requested as JSON, but sometimes the AI returns malformed JSON:
- Missing quotes, brackets, or commas
- Truncated responses
- Concatenated fields
- Invalid escape sequences

This requires complex parsing, AI-based cleanup, and causes bugs.

### The Solution: xAI Structured Outputs API

The [xAI Structured Outputs API](https://docs.x.ai/docs/guides/structured-outputs) uses the `response_format` parameter to **guarantee** responses match a JSON schema. The API enforces the schema server-side.

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.useStructuredOutputs` | `false` | Enable API-enforced JSON schema (recommended) |

### How It Works

```mermaid
flowchart LR
    subgraph Current["Current Flow"]
        A1[AI generates text] --> B1[Hope it's valid JSON]
        B1 --> C1{Parse OK?}
        C1 -->|No| D1[Regex repair]
        D1 --> E1{Still fails?}
        E1 -->|Yes| F1[AI cleanup call]
    end
    
    subgraph Structured["Structured Outputs"]
        A2[API receives schema] --> B2[AI constrained to schema]
        B2 --> C2[Response GUARANTEED valid]
        C2 --> D2[Direct JSON.parse - always works]
    end
    
    style Current fill:#3a1a1a,stroke:#c44,color:#fff
    style Structured fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

### Benefits

| Aspect | Without Structured Outputs | With Structured Outputs |
|--------|---------------------------|------------------------|
| **Parse failures** | Common - requires repair | Impossible - guaranteed valid |
| **AI cleanup calls** | Needed on ~5% of responses | Never needed |
| **Response latency** | Variable (cleanup adds time) | Consistent |
| **Truncation handling** | Complex detection needed | API handles it |
| **Token cost** | Higher (cleanup uses tokens) | Lower |

### Schema Definition

The schema is defined in `src/prompts/responseSchema.ts` as `STRUCTURED_OUTPUT_SCHEMA`:

```typescript
{
    type: "json_schema",
    json_schema: {
        name: "grok_response",
        strict: true,
        schema: {
            type: "object",
            properties: {
                summary: { type: "string" },
                sections: { type: "array", items: {...} },
                todos: { type: "array", items: {...} },
                fileChanges: { type: "array", items: {...} },
                commands: { type: "array", items: {...} },
                nextSteps: { type: "array", items: {...} },
                fileHashes: { type: "object", additionalProperties: {...} }
            },
            required: ["summary"],
            additionalProperties: false
        }
    }
}
```

### Model Requirements

Structured Outputs requires models **grok-2-1212 or later**:
- ✅ `grok-4`, `grok-4-fast`
- ✅ `grok-3`, `grok-3-mini`
- ❌ `grok-2` (older than 1212)

---

## Session Handoff

When a session approaches context or storage limits, users can **handoff** to a new session. The handoff preserves critical context and enables rollback continuity.

### Handoff Flow

```mermaid
flowchart TD
    subgraph Trigger["⚠️ Limit Detection"]
        A[Session approaches 85%<br/>context or storage limit] --> B[Show handoff popup]
        B --> C{User choice}
    end
    
    subgraph Options["📋 User Options"]
        C -->|Handoff| D[Create child session]
        C -->|Extend| E[Create extension document]
        C -->|Cancel| F[Continue in current session]
    end
    
    subgraph Handoff["🔄 Handoff Process"]
        D --> G[Generate handoff context]
        G --> H[Transfer change history]
        H --> I[Create new session with parent reference]
        I --> J[Prefill input with pending tasks]
    end
    
    subgraph Context["📄 Handoff Context Includes"]
        K[Files modified with +/- stats]
        L[Files referenced as context]
        M[Recent conversation - last 3 pairs]
        N[Recent errors/bugs]
        O[Failed CLI commands]
        P[Pending TODOs - priority ordered]
        Q[Actual file contents - auto-loaded]
    end
    
    G --> K
    G --> L
    G --> M
    G --> N
    G --> O
    G --> P
    
    style Trigger fill:#3a2a1a,stroke:#dcdcaa,color:#fff
    style Options fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Handoff fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Context fill:#2a1a3a,stroke:#c94eb0,color:#fff
```

### Change History Transfer

**Critical Feature**: When handing off to a child session, the change history is transferred so rollback works across sessions.

```mermaid
flowchart LR
    subgraph Parent["Parent Session"]
        A[changeHistory with 5 change sets]
    end
    
    subgraph Transfer["Transfer Process"]
        B[Copy all change sets]
        C[Update sessionId references]
        D[Preserve parentChangeSetId]
        E[Restore in-memory tracker]
        F[Persist to Couchbase]
    end
    
    subgraph Child["Child Session"]
        G[changeHistory with 5 inherited sets]
        H[Can revert parent's changes]
        I[New changes append to history]
    end
    
    A --> B --> C --> D --> E --> F --> G
    G --> H
    G --> I
    
    style Parent fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Transfer fill:#2a2a1a,stroke:#dcdcaa,color:#fff
    style Child fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

### Handoff Context Format

The handoff message sent to the new session includes:

```markdown
## HANDOFF CONTEXT

**Parent Session:** {sessionId}
**Project:** {projectName}
**Total Exchanges:** {pairCount}
**Tokens Used:** {tokensIn} in / {tokensOut} out

### SESSION SUMMARY
{summary from parent session}

### FILES MODIFIED (X files)
- `src/utils.ts` (+45/-12)
- `src/config.json` (+10/-0)

### FILES REFERENCED (context attached during session)
- `README.md`
- `package.json`

### CURRENT TASKS (continue these - priority order)
1. [ ] Add type hints to fibonacci
2. [ ] Add type hints to reverse_string
3. [ ] Run final tests

### COMPLETED TASKS
- [x] Add type hints to calculate_area
- [x] Add type hints to is_prime

### RECENT CONVERSATION
User: Add type hints to all functions
AI: Added type hints to calculate_area, continuing with is_prime...

### RECENT ERRORS/ISSUES
- JSON: Auto-detected: Response required JSON cleanup

### FAILED CLI COMMANDS
- `python test.py`: pyenv: python: command not found

### INSTRUCTIONS
1. Continue working on CURRENT TASKS in priority order
2. Read the FILES MODIFIED if you need context on what was changed
3. Read the FILES REFERENCED if you need the source content
4. Check RECENT ERRORS if there are issues to address
5. IMPORTANT: When outputting fileChanges, use the EXACT file paths listed above
```

### Auto-Loading File Contents

When the first message is sent in a handoff child session, the system automatically:

1. **Loads modified files** from the parent session's change history
2. **Includes actual content** in the system prompt (up to 5 files, 8KB each)
3. **AI sees current file state** without requiring manual attachment

This ensures the AI can make precise edits without asking "please attach the file".

```mermaid
flowchart LR
    subgraph Parent["Parent Session"]
        A[changeHistory.files]
    end
    
    subgraph Load["Auto-Load on First Message"]
        B[Extract unique file paths]
        C[Read current file content]
        D[Truncate if > 8KB]
    end
    
    subgraph Child["Child Session System Prompt"]
        E[Handoff context text]
        F[+ Current file contents]
    end
    
    A --> B --> C --> D --> F
    E --> F
    
    style Parent fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Load fill:#2a2a1a,stroke:#dcdcaa,color:#fff
    style Child fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

### Session Document Schema (with handoff)

```json
{
  "id": "child-session-uuid",
  "docType": "chat",
  "parentSessionId": "parent-session-uuid",
  "changeHistory": {
    "history": [
      {
        "id": "cs-123",
        "sessionId": "child-session-uuid",
        "parentChangeSetId": "cs-123",
        "files": [...],
        "applied": true
      }
    ],
    "position": 4
  }
}
```

### Handoff vs Extend

| Feature | Handoff | Extend |
|---------|---------|--------|
| **New session created** | ✓ Yes | ✗ No |
| **Context preserved** | Summary only | Full history |
| **Change history** | Transferred | Stays in place |
| **Rollback works** | ✓ Full continuity | ✓ Full continuity |
| **Response speed** | Faster (smaller context) | May slow as history grows |
| **Storage** | New document | Extension documents |
| **When to use** | Long-running tasks, fresh start | Need complete history |

---

## Multi-Step Task Handling

### Problem: Response Truncation

Complex tasks that require 3+ file changes or span multiple concerns (frontend, backend, config, docs) can cause the AI to generate massive responses that get truncated mid-output. This results in:
- Incomplete JSON that fails to parse
- Partial file changes that corrupt files (now blocked!)
- Lost work that must be regenerated

### Solution: Incremental Execution

The system prompt now instructs the AI to execute complex tasks **one step at a time**:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  User Request   │────▶│  First Response │────▶│  User: continue │
│  (complex task) │     │  (1-2 steps)    │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
         ┌───────────────────────────────────────────────┘
         ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Next Response  │────▶│  User: continue │────▶│  Final Response │
│  (1-2 steps)    │     │                 │     │  (remaining)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### How It Works

1. **Detection**: AI recognizes tasks with 3+ steps, 3+ files, or multiple concerns
2. **Planning**: Creates TODO list with ALL steps upfront
3. **Execution**: Completes only first 1-2 steps per response
4. **Continuation**: Adds structured nextSteps: `[{"html": "Continue to next step", "inputText": "continue"}]`
5. **Iteration**: On "continue", marks steps complete, executes next batch

### nextSteps Format (Structured)

The `nextSteps` field uses a structured format for better UX:

```json
"nextSteps": [
  {"html": "Continue to next step", "inputText": "continue"},
  {"html": "Run tests to verify", "inputText": "run tests"},
  {"html": "Apply fix to line 45", "inputText": "apply"}
]
```

| Field | Purpose |
|-------|---------|
| `html` | Display text shown on the button (can include emoji) |
| `inputText` | Text inserted into input when clicked |

**Benefits**:
- Clear separation between display and action
- Buttons can show friendly text ("Continue to next step")
- Input receives concise action ("continue")
- Legacy string format still supported but triggers bug report

### Why This Matters: Course Correction

This incremental approach is valuable beyond just preventing truncation:

- **Mistakes are recoverable**: If the AI makes a wrong decision in step 2, the user can correct it before step 3 builds on that mistake
- **User guidance**: The user can redirect the approach ("actually, use library X instead") without starting over
- **Objective alignment**: The ultimate goal of the task is best understood by the user - they can steer the AI toward their vision
- **Learning opportunity**: AI can ask clarifying questions between steps if something is ambiguous
- **Checkpoint saves**: Each step is saved to Couchbase, so work is never lost even if the session is interrupted

### Example Flow

**User**: "Set up deployment for Mac, Windows, and Docker"

**Response 1**:
```json
{
  "summary": "Created config.sample.json for deployment configuration.",
  "todos": [
    {"text": "Create config.sample.json", "completed": true},
    {"text": "Update Mac deployment docs", "completed": false},
    {"text": "Update Windows deployment docs", "completed": false},
    {"text": "Update Docker configuration", "completed": false}
  ],
  "fileChanges": [{"path": "app/config.sample.json", ...}],
  "nextSteps": [{"html": "Continue to Mac deployment", "inputText": "continue"}]
}
```

**User**: clicks "Continue to Mac deployment" button → input receives "continue"

**Response 2**:
```json
{
  "summary": "Updated Mac deployment configuration.",
  "todos": [
    {"text": "Create config.sample.json", "completed": true},
    {"text": "Update Mac deployment docs", "completed": true},
    {"text": "Update Windows deployment docs", "completed": false},
    {"text": "Update Docker configuration", "completed": false}
  ],
  "fileChanges": [{"path": "docs/mac-deploy.md", ...}],
  "nextSteps": [{"html": "Continue to Windows deployment", "inputText": "continue"}]
}
```

### Bug Reporting for Truncation

When truncation is detected (incomplete JSON with recoverable file changes):
1. Warning shown to user: "Response was truncated!"
2. Automatic bug report created with `type: 'Other'`, `by: 'script'`
3. Bug stored in session's `bugs[]` array in Couchbase

---

## Response Recovery Flow

When an AI response has errors (truncation, malformed JSON, or parsing failures), the system attempts recovery and presents users with clear action options.

### Recovery Banner

```mermaid
flowchart TD
    subgraph Detection["🔍 Error Detection"]
        A[AI Response] --> B{Parse succeeded?}
        B -->|Yes| C[Normal rendering]
        B -->|No| D[Attempt recovery]
    end
    
    subgraph Recovery["🔧 Recovery Process"]
        D --> E[Extract valid fields]
        E --> F{Any content<br/>recovered?}
        F -->|Yes| G[Show Recovery Banner]
        F -->|No| H[Show Error Message]
    end
    
    subgraph UserAction["⚡ User Actions"]
        G --> I[🔄 Retry Button]
        G --> J[✓ Continue Button]
        I --> K[Reprocess original request]
        J --> L[Accept recovered content]
        H --> M[Retry button only]
    end
    
    style Detection fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Recovery fill:#3a2a1a,stroke:#ffb400,color:#fff
    style UserAction fill:#1a3a1a,stroke:#4ec9b0,color:#fff
```

### UI Layout

When recovery succeeds, users see:

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠️ AI response had errors - Recovery succeeded!                 │
│                                                                 │
│ Recovered: 8 todo(s), 1 next step(s), 1 command(s).            │
│ The content below may be incomplete.                            │
│                                                                 │
│ ┌──────────────┐  ┌──────────────┐                              │
│ │  🔄 Retry    │  │  ✓ Continue  │                              │
│ └──────────────┘  └──────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
│                                                                 │
│ Added type hints docstring to factorial function...             │
│                                                                 │
│ $ python docs/handoff_test.py                     [▶ Run]       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Action Buttons

| Button | Action | When to Use |
|--------|--------|-------------|
| **🔄 Retry** | Reprocesses the original request | When you need a complete response (file changes were corrupted) |
| **✓ Continue** | Dismisses the warning, accepts recovered content | When the recovered summary/TODOs/commands are sufficient |

### What Gets Recovered

The recovery system attempts to extract:

| Field | Recovery Method |
|-------|-----------------|
| `summary` | Regex extraction from JSON fragments |
| `todos` | Pattern matching for TODO arrays |
| `fileChanges` | Complete file change objects before truncation point |
| `commands` | CLI command arrays |
| `nextSteps` | Next step button arrays |
| `sections` | Content sections with headings |

### Malformed Diff Detection

When file changes have malformed diffs (e.g., from mid-response truncation):

```mermaid
flowchart TD
    A[Apply Diff] --> B{Diff produced<br/>actual changes?}
    B -->|Yes| C[Apply changes normally]
    B -->|No| D{Diff looks<br/>malformed?}
    D -->|Yes| E[Block change]
    D -->|No| F[Skip - no changes needed]
    E --> G[Show warning]
    E --> H[Auto-report bug]
    
    style D fill:#7c3aed,stroke:#fff,color:#fff
    style E fill:#3a1a1a,stroke:#c44,color:#fff
```

**Malformed diffs are detected when:**
- Lines contain both `-` and `+` concatenated together (e.g., `-old line+new line`)
- Diff application produces no changes but diff content exists
- Lines don't follow proper unified diff format

**Example of corrupted diff (from truncation):**
```diff
# BAD - lines merged together
-def fibonacci(nn+def fibonacci(n: int) -> int:

# GOOD - proper format
-def fibonacci(n):
+def fibonacci(n: int) -> int:
```

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.maxOutputTokens` | `16384` | Maximum output tokens (higher = less truncation) |
| `grok.apiTimeout` | `300` | Request timeout in seconds |

Increasing `maxOutputTokens` reduces truncation frequency for complex responses.

---

## Future: Sub-Task Architecture & Concurrent Operations

### Vision

Break complex tasks into independent sub-operations that can be executed in parallel by separate AI requests, then merged back together. This would dramatically improve:
- **Speed**: Parallel execution instead of sequential
- **Reliability**: Smaller responses = less truncation risk
- **Cost efficiency**: Use cheaper/faster models for simple sub-tasks

### Proposed Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR                              │
│  - Receives user request                                         │
│  - Analyzes task complexity                                      │
│  - Creates sub-task plan                                         │
│  - Dispatches to workers                                         │
│  - Merges results                                                │
└──────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   SUB-TASK A    │  │   SUB-TASK B    │  │   SUB-TASK C    │
│  (grok-3-mini)  │  │  (grok-3-mini)  │  │  (grok-3-mini)  │
│                 │  │                 │  │                 │
│  "Create the    │  │  "Update the    │  │  "Write the     │
│   config file"  │  │   Mac docs"     │  │   Dockerfile"   │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              ▼
                    ┌─────────────────┐
                    │     MERGER      │
                    │  - Collects all │
                    │    fileChanges  │
                    │  - Validates    │
                    │  - Presents UI  │
                    └─────────────────┘
```

### Sub-Task Document Schema (Couchbase)

```json
{
  "docType": "subtask",
  "parentSessionId": "session-uuid",
  "subtaskId": "subtask-uuid",
  "status": "pending | running | completed | failed",
  "priority": 1,
  "dependencies": ["subtask-uuid-1"],
  "input": {
    "instruction": "Create config.sample.json with placeholder credentials",
    "contextFiles": ["app/config.json"],
    "constraints": ["Use JSON format", "Include comments"]
  },
  "output": {
    "fileChanges": [...],
    "summary": "...",
    "tokensUsed": 500
  },
  "model": "grok-3-mini",
  "createdAt": "...",
  "completedAt": "..."
}
```

### Orchestration Strategies

#### 1. **Dependency Graph Execution**
- Build DAG of sub-tasks
- Execute independent tasks in parallel
- Wait for dependencies before dependent tasks

```
Example: "Add authentication to the app"

Sub-tasks with dependencies:
1. Create auth config         ──┐
2. Create JWT utilities       ──┼──▶ 4. Create auth middleware ──▶ 5. Update routes
3. Create user model          ──┘
```

#### 2. **Map-Reduce Pattern**
- Split large operations across files
- Each worker handles one file
- Merge all changes at end

```
Example: "Add error handling to all API endpoints"

Map: [route1.ts, route2.ts, route3.ts, route4.ts]
     Each gets own AI call with specific file context
Reduce: Collect all fileChanges, present unified diff
```

#### 3. **Specialist Models**
- Route sub-tasks to appropriate model size
- Simple tasks → grok-3-mini (fast, cheap)
- Complex reasoning → grok-4 (slow, expensive)
- Code review → grok-4 with specific prompts

### Implementation Phases

#### Phase 1: Manual Sub-Tasks (Current)
- AI suggests breaking into steps
- User manually says "continue"
- State tracked in TODO list

#### Phase 2: Semi-Automated (Near Future)
- "Auto-continue" toggle in UI
- System automatically sends "continue" after each step
- User can pause/resume

#### Phase 3: Parallel Execution (Future)
- Orchestrator analyzes request complexity
- Creates sub-task documents in Couchbase
- Spawns parallel API calls
- Merges results with conflict detection
- Presents unified output

### Concurrency Considerations

| Concern | Solution |
|---------|----------|
| **File conflicts** | Lock files during sub-task execution; detect overlapping edits |
| **Context limits** | Each sub-task gets minimal context (only files it needs) |
| **Error handling** | Failed sub-task → retry or escalate to user |
| **Cost tracking** | Aggregate token usage across all sub-tasks |
| **Rate limits** | Queue system with configurable parallelism |

### API Design Sketch

```typescript
interface SubTaskPlan {
  tasks: SubTask[];
  executionOrder: 'sequential' | 'parallel' | 'dependency-graph';
  estimatedCost: number;
  estimatedTimeMs: number;
}

interface SubTask {
  id: string;
  instruction: string;
  contextFiles: string[];
  model: 'grok-3-mini' | 'grok-4';
  dependsOn: string[];
  priority: number;
}

// Orchestrator methods
async function planSubTasks(request: string): Promise<SubTaskPlan>;
async function executeSubTasks(plan: SubTaskPlan): Promise<MergedResult>;
async function mergeResults(results: SubTaskResult[]): Promise<FileChange[]>;
```

### Benefits of This Architecture

1. **Eliminates truncation**: Each sub-task produces small, focused output
2. **Faster completion**: Parallel execution of independent tasks
3. **Lower costs**: Use cheaper models for simple sub-tasks
4. **Better reliability**: Retry individual failures without losing progress
5. **Transparent progress**: Show real-time status of each sub-task
6. **Resumable**: Sub-task state persisted in Couchbase

### Design Decisions

#### Q: How to handle sub-tasks that need to reference each other's output?

**Solution**: Use Couchbase to store shared/intermediate data. Each sub-task can read from and write to a shared context document:

```json
{
  "docType": "subtask-context",
  "parentSessionId": "session-uuid",
  "sharedData": {
    "authConfig": { "jwtSecret": "..." },
    "createdFiles": ["src/auth/config.ts", "src/auth/jwt.ts"]
  },
  "stepOutputs": {
    "subtask-1": { "exportedTypes": ["User", "AuthToken"] },
    "subtask-2": { "middlewareName": "authMiddleware" }
  }
}
```

Dependent sub-tasks wait for their dependencies to complete and read from `stepOutputs`.

---

#### Q: Should users be able to edit/reorder the sub-task plan before execution?

**Solution**: Present execution strategy options to the user upfront with recommendations:

```
┌─────────────────────────────────────────────────────────────────┐
│  📋 Execution Plan: "Add authentication to the app"            │
├─────────────────────────────────────────────────────────────────┤
│  Found 5 sub-tasks. Choose execution strategy:                 │
│                                                                 │
│  ○ A) Parallel (Recommended)                                   │
│      Speed: ⚡⚡⚡  Cost: $0.04  Risk: Medium                   │
│      4 tasks run simultaneously, 1 waits for dependencies      │
│                                                                 │
│  ○ B) Sequential                                                │
│      Speed: ⚡     Cost: $0.03  Risk: Low                       │
│      Safest option, but takes longer                           │
│                                                                 │
│  ○ C) Fast & Loose                                              │
│      Speed: ⚡⚡⚡⚡ Cost: $0.05  Risk: High                     │
│      All parallel, may need conflict resolution                │
│                                                                 │
│  [Edit Plan]  [Start A]  [Start B]  [Start C]                  │
└─────────────────────────────────────────────────────────────────┘
```

User can also click "Edit Plan" to reorder, remove, or modify sub-tasks before execution.

---

#### Q: How to present parallel progress in the UI?

**Solution**: Stacked progress bars, one per sub-task:

```
┌─────────────────────────────────────────────────────────────────┐
│  🔄 Running 3 sub-tasks in parallel...                         │
├─────────────────────────────────────────────────────────────────┤
│  1. Create auth config      ████████████████████░░░░  80%      │
│  2. Create JWT utilities    ██████████████████████░░  90%  ✓   │
│  3. Create user model       ████████░░░░░░░░░░░░░░░░  35%      │
├─────────────────────────────────────────────────────────────────┤
│  ⏳ Waiting: 4. Create auth middleware (depends on 1, 2, 3)    │
│  ⏳ Waiting: 5. Update routes (depends on 4)                   │
└─────────────────────────────────────────────────────────────────┘
```

Each bar shows:
- Sub-task name
- Visual progress
- Percentage
- Checkmark when complete
- "Waiting" status for dependent tasks

---

#### Q: What's the optimal sub-task granularity?

**Solution**: Let the AI suggest options and ask user to choose:

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 Task Breakdown Options                                      │
├─────────────────────────────────────────────────────────────────┤
│  Your request can be broken down in different ways:            │
│                                                                 │
│  A) Fine-grained (Recommended)                                  │
│     12 sub-tasks, ~200 tokens each                             │
│     ✓ Lowest truncation risk                                   │
│     ✓ Best parallelism                                         │
│     ✗ More API overhead                                        │
│                                                                 │
│  B) Medium                                                      │
│     5 sub-tasks, ~800 tokens each                              │
│     ✓ Good balance                                             │
│     ~ Moderate risk                                            │
│                                                                 │
│  C) Coarse                                                      │
│     2 sub-tasks, ~2000 tokens each                             │
│     ✓ Fewer API calls                                          │
│     ✗ Higher truncation risk                                   │
│                                                                 │
│  [Use A]  [Use B]  [Use C]  [Let AI decide]                    │
└─────────────────────────────────────────────────────────────────┘
```

Default to "Let AI decide" which uses heuristics based on:
- Task complexity
- Number of files involved
- Historical truncation rates for similar tasks

---

## Image Generation Workflow

### Overview

The extension supports AI-powered image generation using the `grok-2-image` model. Unlike chat/vision models that take images as input, the image generation model:
- Takes **text only** as input
- Produces **images** as output
- Uses a separate endpoint: `/v1/images/generations`

### Model Configuration

| Setting | Model | Purpose |
|---------|-------|---------|
| `grok.modelVision` | grok-4 | **Understanding** images (input: image → output: text) |
| `grok.modelImageCreate` | grok-2-image | **Creating** images (input: text → output: image) |

### Image Generation Flow

```mermaid
flowchart TD
    subgraph Detection["🔍 Request Analysis"]
        A[User message] --> B{Contains image<br/>generation keywords?}
        B -->|No| C[Normal chat flow]
        B -->|Yes| D{Multiple images<br/>requested?}
    end
    
    subgraph SingleImage["🎨 Single Image"]
        E[Call /images/generations<br/>with prompt]
        F[Display image with controls]
    end
    
    subgraph MultiImage["🎨 Multiple Images"]
        G[Generate N prompts<br/>using grok-3-mini]
        H[Parallel API calls<br/>to /images/generations]
        I[Display thumbnail gallery]
    end
    
    subgraph Gallery["🖼️ Image Gallery UI"]
        J[Thumbnail grid view]
        K[Hover/click to enlarge]
        L[Selection checkboxes]
        M[Per-image regenerate button]
        N[Download selected button]
    end
    
    subgraph Regenerate["🔄 Regeneration Flow"]
        O[Click regenerate ↺]
        P[Popup with editable prompt]
        Q[Prepopulate original prompt]
        R[User modifies/appends]
        S[New API call]
        T[Replace image in gallery]
    end
    
    subgraph Save["💾 Save Flow"]
        U[Select images via checkbox]
        V[Click download/save]
        W[User picks destination folder]
        X[Save selected images to project]
    end
    
    D -->|Single| E --> F
    D -->|Multiple| G --> H --> I
    F --> J
    I --> J
    J --> K
    J --> L
    J --> M
    L --> N --> U --> V --> W --> X
    M --> O --> P --> Q --> R --> S --> T
    
    style Detection fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Gallery fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Regenerate fill:#3a1a3a,stroke:#c94eb0,color:#fff
    style Save fill:#2a2a1a,stroke:#dcdcaa,color:#fff
```

### API Details

#### Endpoint
```
POST https://api.x.ai/v1/images/generations
```

#### Request Body
```json
{
  "model": "grok-2-image",
  "prompt": "A cat sitting on a rainbow bridge in space",
  "n": 4,
  "response_format": "url"
}
```

#### Response
```json
{
  "data": [
    {
      "url": "https://..../image1.jpg",
      "revised_prompt": "A detailed 3D render of a fluffy orange cat..."
    },
    {
      "url": "https://..../image2.jpg",
      "revised_prompt": "..."
    }
  ]
}
```

### Detection Keywords

The system detects image generation requests by looking for phrases like:
- "create an image", "generate an image", "make an image"
- "draw", "create a picture", "generate a picture"
- "create icon(s)", "generate icon(s)", "create logo"
- "create illustration", "generate artwork"
- "design an image", "produce an image"

Count detection via patterns like "4 icons", "3 images", "5 logo ideas".

### Multi-Image Generation Example

**User**: "Create 4 icon ideas for my mobile app logo based on the README of the project"

**Flow**:
1. Detect image generation request with count=4
2. Load README content as context
3. Use `grok-3-mini` to generate 4 distinct prompts:
   ```json
   [
     "A minimalist mobile app icon featuring a stylized chat bubble with a gear inside...",
     "A modern gradient app icon showing interconnected nodes representing AI...",
     "A bold circular icon with a lightning bolt and code brackets...",
     "A friendly mascot-style icon featuring a robot assistant..."
   ]
   ```
4. Make 4 parallel calls to `/images/generations`
5. Display 4 thumbnails in a grid

### Image Gallery UI

```
┌─────────────────────────────────────────────────────────────────┐
│  🎨 Generated Images (4)                    [💾 Save Selected]  │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ [☐]      │  │ [☑]      │  │ [☐]      │  │ [☑]      │        │
│  │          │  │          │  │          │  │          │        │
│  │  img 1   │  │  img 2   │  │  img 3   │  │  img 4   │        │
│  │          │  │          │  │          │  │          │        │
│  │   [↺]    │  │   [↺]    │  │   [↺]    │  │   [↺]    │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                 │
│  Hover to enlarge • Click to view full size                    │
└─────────────────────────────────────────────────────────────────┘
```

**Controls**:
- `[☐/☑]` - Checkbox to select for download
- `[↺]` - Regenerate button (opens prompt editor)
- `[💾 Save Selected]` - Download selected images

### Regeneration Popup

When clicking the regenerate button [↺]:

```
┌─────────────────────────────────────────────────────────────────┐
│  🔄 Regenerate Image                                      [✕]  │
├─────────────────────────────────────────────────────────────────┤
│  Original Prompt:                                               │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ A minimalist mobile app icon featuring a stylized chat  │   │
│  │ bubble with a gear inside, using blue and white colors, │   │
│  │ clean lines, modern design aesthetic                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  💡 Edit the prompt above or add to it below:                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ make it darker, add a gradient, more 3D look            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                          [Cancel]  [🎨 Regenerate]              │
└─────────────────────────────────────────────────────────────────┘
```

**Behavior**:
1. Shows original prompt (prepopulated, editable)
2. Optional "add refinement" field that appends to prompt
3. On regenerate: combines prompt + refinements, makes new API call
4. New image replaces original in gallery position

### Save/Download Flow

1. User selects images via checkboxes
2. Clicks "Save Selected" button
3. VS Code file picker opens
4. User selects destination folder
5. Images saved as `image-001.jpg`, `image-002.jpg`, etc.
6. Confirmation message shown

### Data Schema (Couchbase)

Generated images are stored in the chat pair's response:

```json
{
  "docType": "chat-pair",
  "structured": {
    "generatedImages": [
      {
        "id": "img-1703123456789-abc123",
        "originalPrompt": "Create a minimalist app icon...",
        "revisedPrompt": "A 3D rendered minimalist...",
        "url": "https://..../image.jpg",
        "timestamp": 1703123456789,
        "selected": false
      }
    ]
  }
}
```

### Cost Tracking

Image generation uses a flat per-image pricing model:
- ~$0.07 per image (as of 2024)
- Displayed in the token/cost bar after generation

---

## File Registry (Session Memory)

### Overview

The **File Registry** is a persistent metadata store that tracks all files the AI has "seen" across a conversation. Unlike `pairFileHistory` which tracks per-turn operations, the registry provides a session-wide view of file states.

### Purpose

| Problem | Solution |
|---------|----------|
| AI forgets which files it has seen | Registry persists file metadata across turns |
| AI uses stale file content | `lastModifiedTurn` flags when file changed after last seen |
| AI hallucinates file content | Registry shows what's in context vs what needs re-attachment |
| Context explosion | Registry tracks sizeBytes for budget decisions |

### Data Structure

```typescript
interface FileRegistryEntry {
    path: string;              // Relative path from workspace root
    absolutePath: string;      // Full filesystem path
    md5: string;               // Last known hash
    lastSeenTurn: number;      // Which pairIndex last had this file attached
    lastModifiedTurn?: number; // Which pairIndex last modified this file
    sizeBytes: number;         // File size for context budget decisions
    language: string;          // Detected language
    loadedBy: 'user' | 'auto' | 'ai-adhoc';  // How file was loaded
}

// Stored in session document
interface ChatSessionDocument {
    // ... existing fields ...
    fileRegistry?: Record<string, FileRegistryEntry>;
}
```

### How It Works

```mermaid
flowchart TD
    subgraph Load["📂 File Load"]
        A[Agent loads files] --> B[Update fileRegistry]
        C[User attaches file] --> B
        B --> D[Set lastSeenTurn = current]
    end
    
    subgraph Modify["✏️ File Modify"]
        E[User applies change] --> F[markFileModified]
        F --> G[Set lastModifiedTurn = current]
        F --> H[Update md5 hash]
    end
    
    subgraph Context["🤖 AI Context"]
        I[Build system prompt] --> J{Registry has entries?}
        J -->|Yes| K[Inject KNOWN FILES table]
        J -->|No| L[Skip registry section]
        K --> M[AI sees file states]
    end
    
    subgraph AIAction["🎯 AI Decision"]
        M --> N{File in registry?}
        N -->|No| O[Request attachment]
        N -->|Yes| P{Modified since seen?}
        P -->|Yes| Q[⚠️ Request re-attachment]
        P -->|No| R[Can reference structure]
    end
    
    style Load fill:#1a3a1a,stroke:#4ec9b0,color:#fff
    style Modify fill:#2a2a1a,stroke:#dcdcaa,color:#fff
    style Context fill:#1a2a3a,stroke:#4ea5c9,color:#fff
    style AIAction fill:#2a1a3a,stroke:#c94eb0,color:#fff
```

### AI Context Injection

The registry is injected into the system prompt as a markdown table:

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

### Registry Functions

| Function | Purpose |
|----------|---------|
| `updateFileRegistry(sessionId, entries, currentTurn)` | Add/update files when loaded |
| `markFileModified(sessionId, path, newMd5, modifiedTurn)` | Mark file as modified after apply |
| `getFileRegistry(sessionId)` | Get full registry |
| `getFileFromRegistry(sessionId, path)` | Get single file entry |
| `buildFileRegistrySummary(registry, currentTurn, maxFiles)` | Generate markdown table for context |

### System Prompt Instructions

The AI is instructed to use the registry:

```
## 📂 FILE REGISTRY (Session Memory)

The context may include a **KNOWN FILES** section showing files you've seen:
- **Last Seen**: Which turn you last had the file content
- **Modified Since**: ⚠️ means file changed AFTER you last saw it - request re-attachment!
- **Hash**: Use this to verify you have the latest version

**Using the registry:**
1. Before modifying a file, check if it appears in KNOWN FILES
2. If "Modified Since" shows ⚠️, the file changed - ask for re-attachment
3. If file was seen recently and not modified, you can reference its structure
4. The registry helps you know WHAT files exist, not their current content
```

### Comparison with pairFileHistory

| Aspect | pairFileHistory | fileRegistry |
|--------|-----------------|--------------|
| Scope | Per-turn operations | Session-wide file states |
| Purpose | Track read/update/create ops | Track what AI has "seen" |
| Granularity | Every operation logged | Latest state per file |
| AI Use | Check recent modifications | Know available files |
| Staleness Detection | Check `by: user` updates | Check `lastModifiedTurn > lastSeenTurn` |

Both are injected into AI context and serve complementary purposes.

---

## Debugging & Audit Features

### Audit Generation (Debug Full AI Responses)

When debugging hash mismatches or AI behavior issues, it's helpful to see the **complete, unprocessed AI generation**. The Audit Generation feature saves every AI response to a separate Couchbase document for analysis.

```mermaid
flowchart TD
    subgraph Config["⚙️ Configuration"]
        A[grok.auditGeneration = true] --> B[Enable audit mode]
    end
    
    subgraph Capture["📝 Capture Flow"]
        C[AI Response Complete] --> D{Audit enabled?}
        D -->|No| E[Normal flow only]
        D -->|Yes| F[Save to debug:sessionId]
        F --> G[Store full generation text]
        G --> H[Store system prompt preview]
        H --> I[Store model + finishReason]
    end
    
    subgraph Storage["💾 Storage"]
        J[Main session: sessionId<br/>Parsed response]
        K[Audit doc: debug:sessionId<br/>Raw generation text]
    end
    
    subgraph Dashboard["🔍 Error Dashboard"]
        L[Open session] --> M[Click 'Audit' tab]
        M --> N[View full AI generation]
        N --> O[Compare to parsed response]
        O --> P[Find parsing issues]
    end
    
    F --> K
    style Config fill:#1a2a3a,stroke:#4ec9b0,color:#fff
    style Capture fill:#2a2a1a,stroke:#dea54e,color:#fff
    style Dashboard fill:#1a3a3a,stroke:#4ea5c9,color:#fff
```

**Configuration:**

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.auditGeneration` | `false` | Save full AI generations to separate debug document |

**Couchbase Document Structure:**

Main session document (key: `{sessionId}`):
```json
{
  "id": "abc-123",
  "docType": "chat",
  "auditGenerating": true,
  "pairs": [...]
}
```

Audit document (key: `debug:{sessionId}`):
```json
{
  "id": "debug:abc-123",
  "docType": "chatAudit",
  "sessionId": "abc-123",
  "projectId": "project-uuid",
  "createdAt": "2025-12-27T10:00:00.000Z",
  "updatedAt": "2025-12-27T10:05:00.000Z",
  "pairs": [
    {
      "pairIndex": 0,
      "timestamp": "2025-12-27T10:01:00.000Z",
      "userMessage": "modify the greet function to return Bonjour...",
      "fullGeneration": "{\"summary\":\"Applying the change...\",\"fileHashes\":{...}...}",
      "systemPromptPreview": "You are Grok, an AI coding assistant...",
      "model": "grok-4",
      "finishReason": "stop",
      "tokensIn": 6704,
      "tokensOut": 287
    },
    {
      "pairIndex": 1,
      "timestamp": "2025-12-27T10:03:00.000Z",
      "userMessage": "continue",
      "fullGeneration": "{\"summary\":\"Applying the second change...\",\"fileHashes\":{...}...}",
      "systemPromptPreview": "You are Grok...\n## FILE OPERATION HISTORY...",
      "model": "grok-4",
      "finishReason": "stop",
      "tokensIn": 6785,
      "tokensOut": 296
    }
  ]
}
```

**Error Dashboard - Audit Tab:**

When viewing a session in the Error Dashboard, the new "🔍 Audit" tab shows:

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍 Generation Audit                                            │
├─────────────────────────────────────────────────────────────────┤
│  Full AI generations captured for debugging.                    │
│  Document: debug:abc-123                                        │
│  Entries: 2 | Created: 2025-12-27                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Pair #1 👈 This pair | grok-4 | stop                    │   │
│  │ 6785 in / 296 out                                       │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │ User Message                                             │   │
│  │ ┌───────────────────────────────────────────────────┐   │   │
│  │ │ continue                                           │   │   │
│  │ └───────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │ Full AI Generation                                      │   │
│  │ ┌───────────────────────────────────────────────────┐   │   │
│  │ │ {"summary":"Applying the second change...","file   │   │   │
│  │ │ Hashes":{"docs/rollback_test.py":"a8827c08d889... │   │   │
│  │ └───────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Pair #0 | grok-4 | stop                                 │   │
│  │ ...                                                      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**When Audit is NOT Enabled:**

```
┌─────────────────────────────────────────────────────────────────┐
│  🔍 Generation Audit                                            │
├─────────────────────────────────────────────────────────────────┤
│  ❌ No audit document found.                                    │
│                                                                 │
│  To enable audit generation:                                    │
│  1. Open VS Code settings                                       │
│  2. Search for "grok.auditGeneration"                           │
│  3. Enable the checkbox                                         │
│                                                                 │
│  Future generations will be saved to debug:abc-123              │
└─────────────────────────────────────────────────────────────────┘
```

**Use Cases:**

| Scenario | What Audit Reveals |
|----------|-------------------|
| Hash mismatch error | See exact `fileHashes` AI provided vs what was expected |
| JSON parsing failed | See raw unprocessed text before cleanup attempted |
| Wrong line numbers | Check if AI had correct file content (systemPromptPreview) |
| Truncation suspected | Check `finishReason` - "length" = truncated |
| AI hallucinated content | Compare `fullGeneration` to what files were actually attached |

**Size Management:**

Audit documents are limited to ~18MB. When approaching the limit:
1. Oldest entries are trimmed automatically
2. A log message indicates trimming occurred
3. Most recent entries are always preserved