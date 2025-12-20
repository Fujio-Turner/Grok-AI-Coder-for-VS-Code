# Grok AI Coder - VS Code Extension

## Project Overview
A VS Code extension that integrates with xAI Grok API for AI-assisted coding, featuring:
- Sidebar chat interface
- Workspace file context
- Code edits/suggestions
- **Couchbase persistence for chat sessions**
- Token usage tracking
- Revert functionality
- Multimodal support (images)
- **Cancel/Stop functionality** - interrupt AI at any time
- **Streaming "thoughts"** - see AI planning in real-time
- **Visual plan execution** - bullet points with strikethrough on completion
- **Diff view for changes** - red (old) / green (new) highlighting

## Tech Stack
- **Language**: TypeScript
- **UI**: VS Code Webview (HTML/CSS/JS)
- **API**: xAI Grok (OpenAI-compatible)
- **Storage**: Couchbase Server

## Couchbase Configuration
```
Host: localhost:8091
Username: Administrator
Password: password
Bucket: grokCoder
Scope: _default
Collection: _default
```

### Document Structure
**Key**: UUID (chat session ID)
**Value**:
```json
{
  "id": "uuid-here",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "pairs": [
    {
      "request": {
        "text": "user message",
        "timestamp": "ISO timestamp",
        "contextFiles": ["file paths"]
      },
      "response": {
        "text": "assistant response",
        "timestamp": "ISO timestamp",
        "status": "pending|success|error",
        "errorMessage": "if error",
        "usage": {
          "promptTokens": 0,
          "completionTokens": 0,
          "totalTokens": 0
        }
      }
    }
  ]
}
```

---

## Implementation Steps (Expanded)

### Step 1: Prepare Development Environment ✅
- [x] Install Node.js LTS
- [x] Install VS Code
- [x] Install Yeoman + generator-code: `npm install -g yo generator-code`
- [x] Install TypeScript globally: `npm install -g typescript`
- [ ] Couchbase: Create bucket `grokCoder` with _default scope/collection

### Step 2: Scaffold the Extension Project
- [ ] Run `yo code` → Choose "New Extension (TypeScript)"
  - Name: `grok-coder`
  - Description: "VS Code AI assistant powered by xAI Grok with Couchbase persistence"
- [ ] Install dependencies:
  ```bash
  npm install couchbase uuid marked highlight.js
  npm install --save-dev @types/uuid
  ```
- [ ] Open project and test with F5

### Step 3: Project Structure
Create these folders/files:
```
src/
├── extension.ts                    # Entry point
├── views/
│   └── ChatViewProvider.ts         # Sidebar webview provider
├── webview/
│   ├── index.html                  # Chat UI
│   └── main.js                     # Webview scripts
├── api/
│   └── grokClient.ts               # Grok API wrapper
├── storage/
│   ├── couchbaseClient.ts          # Couchbase connection
│   └── chatSessionRepository.ts    # Session CRUD
├── context/
│   └── workspaceContext.ts         # File/AGENT.md reading
├── edits/
│   └── codeActions.ts              # Apply/revert edits
└── usage/
    └── tokenTracker.ts             # Token/cost tracking
media/
└── icon.svg                        # Sidebar icon
```

### Step 4: Create AGENT.md for Persistent Context
- [ ] Create `AGENT.md` at workspace root
- [ ] Implement `readAgentContext()` in `workspaceContext.ts`
- [ ] Include AGENT.md content in system prompts

### Step 5: Configure package.json
Add to `contributes`:
```json
{
  "viewsContainers": {
    "activitybar": [{
      "id": "grokChatContainer",
      "title": "Grok AI",
      "icon": "media/icon.svg"
    }]
  },
  "views": {
    "grokChatContainer": [{
      "id": "grokChatView",
      "name": "Chat",
      "type": "webview"
    }]
  },
  "commands": [
    { "command": "grok.setApiKey", "title": "Grok: Set API Key" },
    { "command": "grok.newChatSession", "title": "Grok: New Chat Session" },
    { "command": "grok.retryLastRequest", "title": "Grok: Retry Last Request" }
  ],
  "configuration": {
    "properties": {
      "grok.apiBaseUrl": {
        "type": "string",
        "default": "https://api.x.ai/v1"
      },
      "grok.couchbaseHost": {
        "type": "string",
        "default": "couchbase://localhost"
      }
    }
  }
}
```

### Step 6: Sidebar Webview Chat UI
- [ ] Implement `WebviewViewProvider` in `ChatViewProvider.ts`
- [ ] Create HTML/CSS/JS for chat bubbles, input box
- [ ] Message passing protocol:
  - **Webview → Extension**: `sendMessage`, `retryMessage`, `newSession`, `applyEdits`, `cancelRequest`
  - **Extension → Webview**: `init`, `newMessagePair`, `updateResponseChunk`, `error`, `sessionChanged`, `planUpdate`, `stepCompleted`, `requestComplete`

#### 6.1 Cancel/Stop Functionality
- [ ] Add "Stop" button that appears during active requests
- [ ] Implement `AbortController` for fetch requests to Grok API
- [ ] On cancel: save partial response to Couchbase with `status: 'cancelled'`
- [ ] Allow user to immediately type new/corrected input after stop
- [ ] Webview sends `{ type: 'cancelRequest' }` → Extension aborts API call

#### 6.2 Streaming Thoughts Display
- [ ] Show "Thinking..." indicator with streaming AI reasoning
- [ ] Display AI's analysis/planning as it streams in (before code changes)
- [ ] Use italics or different styling for "thought" content vs final output
- [ ] Update in real-time as tokens arrive from API

#### 6.3 Visual Plan Execution
- [ ] AI presents numbered bullet-point plan before executing
- [ ] Each step shown as: `• Step description`
- [ ] User can review plan and click "Stop" to cancel before execution
- [ ] As each step completes: apply ~~strikethrough~~ styling
- [ ] Show checkmark (✓) or green indicator for completed steps
- [ ] Current step highlighted (bold or different color)

#### 6.4 Diff View for Code Changes
- [ ] For each file change, show side-by-side or inline diff:
  - **Red background/highlight**: deleted/old lines
  - **Green background/highlight**: added/new lines
- [ ] Display: `📄 filename.ts (lines 45-67)`
- [ ] Collapsible sections for each file modified
- [ ] "Apply" / "Reject" buttons per file or per change

#### 6.5 Completion Notification
- [ ] Visual "Done!" indicator when all steps complete
- [ ] Summary: files changed, lines modified, tokens used
- [ ] VS Code notification: "Grok completed: 3 files modified"
- [ ] Sound/bell option (configurable)

### Step 7: API Key Storage
- [ ] Use `context.secrets` API for secure storage
- [ ] Register `grok.setApiKey` command
- [ ] Prompt for key on first use
- [ ] Link to https://x.ai/api for key generation

### Step 8: Grok API + Couchbase Integration

#### 8.1 Grok Client (`grokClient.ts`)
- [ ] Define types: `GrokMessage`, `GrokUsage`, `GrokResponse`
- [ ] Implement `sendChatCompletion()` with fetch
- [ ] Handle streaming responses (optional)
- [ ] Error handling: rate limits, invalid key, network errors

#### 8.2 Couchbase Client (`couchbaseClient.ts`)
- [ ] Create singleton connection
- [ ] `getChatCollection()` → returns Collection
- [ ] `shutdownCouchbase()` → cleanup on deactivate

#### 8.3 Chat Session Repository (`chatSessionRepository.ts`)
- [ ] Types: `ChatRequest`, `ChatResponse`, `ChatPair`, `ChatSessionDocument`
- [ ] `createSession()` → new UUID, empty pairs
- [ ] `getSession(id)` → fetch by key
- [ ] `appendPair(sessionId, pair)` → add to pairs array
- [ ] `updateLastPairResponse(sessionId, response)` → update last pair

#### 8.4 Chat Flow Integration
1. On message: create pair with `response.status = 'pending'`
2. Save to Couchbase immediately
3. Call Grok API
4. Update response in Couchbase (success or error)
5. Support retry by re-fetching pair from Couchbase

### Step 9: Workspace Context
- [ ] `findFiles(glob)` using `vscode.workspace.findFiles`
- [ ] `readFile(uri)` using `vscode.workspace.fs.readFile`
- [ ] Include context in prompts
- [ ] Record `contextFiles` in `ChatRequest`

### Step 10: Apply Code Edits ✅
- [x] Parse Grok responses for code blocks (📄 filename pattern)
- [x] Use `vscode.workspace.applyEdit` with `WorkspaceEdit`
- [x] Create new files with `workspace.fs.writeFile`
- [x] UI "Apply" button triggers edit application

### Step 11: Revert and Change Tracking ✅
- [x] Snapshot files before edits (in-memory)
- [x] "Revert All" command restores snapshots (`grok.revertLastEdits`)
- [ ] Optional: Git integration

### Step 12: Token Usage Tracking ✅
- [x] Track per session: promptTokens, completionTokens, cost
- [x] Parse usage from Grok API response
- [x] Display in status bar (click to see details)
- [x] Persist usage in `ChatResponse.usage`
- [x] Cost calculation based on model (grok-3-mini, grok-4)

### Step 13: Model Selection ✅
- [x] Config: `grok.modelFast`, `grok.modelReasoning`, `grok.modelVision`
- [x] Auto-select based on prompt complexity (detectModelType in logger.ts)
- [x] Record model in request/response (ChatRequest.model field)

### Step 14: Multimodal (Images) ✅
- [x] "Attach Image" button in webview (📎 button)
- [x] Read image as base64 (FileReader in webview)
- [x] Send to Grok vision endpoint (createVisionMessage helper)
- [x] Store image reference in `ChatRequest.images`

### Step 15: Commands and Inline Features ✅
- [x] `grok.explainSelection` - explain selected code
- [x] `grok.fixSelection` - fix selected code
- [x] Keyboard shortcuts (Ctrl+Shift+G E/F)
- [x] Editor context menu items (right-click menu)

### Step 16: UI/UX Enhancements
- [ ] Loading spinners for pending responses
- [ ] Markdown rendering with `marked`
- [ ] Code highlighting with `highlight.js`
- [ ] Retry button for failed requests
- [ ] Session list (N1QL query)

### Step 17: Testing and Debugging
- [ ] F5 Extension Development Host testing
- [ ] Unit tests for Couchbase repository
- [ ] Mock Grok API for testing
- [ ] Output channel logging

### Step 18: Packaging and Publishing
- [ ] `npm install -g @vscode/vsce`
- [ ] `vsce package` → .vsix
- [ ] README, CHANGELOG, icons
- [ ] Marketplace publishing

---

## Commands
```bash
# Build
npm run compile

# Watch
npm run watch

# Test
npm test

# Package
vsce package
```

## Notes
- API calls can be slow; Couchbase persistence allows retry without data loss
- Always save to Couchbase BEFORE making API call
- Store `status: 'pending'` to track in-flight requests
