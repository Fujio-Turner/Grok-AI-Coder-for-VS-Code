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

### 3. **Agent Workflow** (if no images)
- Analyzes request for file/URL references
- Loads matching files into context
- Shows progress: "🔍 Analyzing..." → "📂 Loaded X files"

### 4. **Main API Call**
- Builds messages array (system prompt + history + user message)
- Calls `sendChatCompletion()` with streaming
- Each chunk → `updateResponseChunk` → webview shows partial text

### 5. **SAVE EARLY** (new!)
- Immediately saves raw response text to Couchbase
- Prevents data loss if parsing crashes

### 6. **Parse Response**
- Tries `parseResponse()` (regex-based JSON repair)
- If fails + cleanup enabled → `cleanJsonWithModel()` (AI fixes JSON)
- Extracts: `summary`, `sections`, `todos`, `fileChanges`, `commands`, `nextSteps`

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
  - Next Steps buttons
  - "What was done" summary
  - Done bar with action buttons + token count
- Caches HTML in webview state
- Scrolls to bottom

---

## Multi-Step Task Handling

### Problem: Response Truncation

Complex tasks that require 3+ file changes or span multiple concerns (frontend, backend, config, docs) can cause the AI to generate massive responses that get truncated mid-output. This results in:
- Incomplete JSON that fails to parse
- Partial file changes that corrupt files
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
4. **Continuation**: Adds `nextSteps: ["Say 'continue' to proceed"]`
5. **Iteration**: On "continue", marks steps complete, executes next batch

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
  "nextSteps": ["Say 'continue' to proceed with Mac deployment"]
}
```

**User**: "continue"

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
  "nextSteps": ["Say 'continue' to proceed with Windows deployment"]
}
```

### Bug Reporting for Truncation

When truncation is detected (incomplete JSON with recoverable file changes):
1. Warning shown to user: "Response was truncated!"
2. Automatic bug report created with `type: 'Other'`, `by: 'script'`
3. Bug stored in session's `bugs[]` array in Couchbase

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