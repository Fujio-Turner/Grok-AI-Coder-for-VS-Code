# Agent Step Integration Design

**Status:** Draft  
**Created:** 2024-12-29  
**Author:** AI-assisted design  

## Overview

This document describes how to add **step-based grouping** on top of the existing hash-based change tracking system. This enables multi-step agent workflows where each "step" represents a logical unit of work that can be rolled back atomically.

### Goals

1. **Keep existing system** - MD5 verification, line-level tracking, Couchbase persistence all remain
2. **Add step semantics** - Group ChangeSets into logical "agent steps" 
3. **Dependency tracking** - Know which steps depend on which
4. **Cascading rollback** - "Undo step 3" automatically handles steps 4, 5, ...
5. **Execution result capture** - Store command outputs for feedback loops

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          NEW: AgentStepTracker                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │  Step 1     │──│  Step 2     │──│  Step 3     │──│  Step 4     │    │
│  │  (depends:-)│  │ (depends:1) │  │ (depends:2) │  │ (depends:3) │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │           │
│         ▼                ▼                ▼                ▼           │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    EXISTING: ChangeTracker                        │  │
│  │  ChangeSet[] ─ each has oldContent/newContent per file           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│         │                                                              │
│         ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                 EXISTING: Couchbase Persistence                   │  │
│  │  FileRevisionDocument, FileBackupDocument, FileRevisionIndex     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## New Interfaces

### File: `src/agent/agentStepTracker.ts` (NEW)

```typescript
/**
 * Represents a single step in a multi-step agent workflow.
 * Each step can contain multiple file changes (ChangeSets) and 
 * tracks dependencies on previous steps.
 */
export interface AgentStep {
    id: string;                      // Unique step ID: "step-{timestamp}-{random}"
    stepNumber: number;              // Sequential: 1, 2, 3...
    sessionId: string;               // Links to ChatSession
    
    // What this step does
    description: string;             // AI's description of the step
    intent: string;                  // User's original request that led to this step
    
    // Dependencies
    dependsOn: string[];             // Step IDs this depends on (usually just previous)
    dependents: string[];            // Steps that depend on this one (populated as steps are added)
    
    // Links to existing ChangeTracker
    changeSetIds: string[];          // ChangeSet IDs from changeTracker.ts
    
    // Execution context (for agent loop feedback)
    execution?: {
        commands: AgentCommand[];    // Commands executed in this step
        success: boolean;            // Overall step success
        error?: string;              // Error if failed
    };
    
    // State
    status: 'pending' | 'applied' | 'reverted' | 'failed';
    createdAt: string;
    appliedAt?: string;
    revertedAt?: string;
}

/**
 * A command executed as part of an agent step
 */
export interface AgentCommand {
    id: string;
    command: string;                 // The actual command string
    cwd: string;                     // Working directory
    exitCode?: number;
    stdout?: string;                 // First 2000 chars
    stderr?: string;                 // First 2000 chars
    durationMs: number;
    success: boolean;
}

/**
 * Workflow containing all steps for a multi-step task
 */
export interface AgentWorkflow {
    id: string;                      // "workflow-{timestamp}-{random}"
    sessionId: string;
    userRequest: string;             // Original user request that started the workflow
    steps: AgentStep[];
    currentStepIndex: number;        // Which step we're on (-1 = not started)
    status: 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
    createdAt: string;
    completedAt?: string;
}
```

---

## Implementation Steps

### Phase 1: Core Infrastructure (Est. 2-3 hours)

#### Step 1.1: Create AgentStepTracker class

**File:** `src/agent/agentStepTracker.ts`

```typescript
import { changeTracker, ChangeSet } from '../edits/changeTracker';

class AgentStepTracker {
    private workflows: Map<string, AgentWorkflow> = new Map();
    private currentWorkflowId: string | null = null;
    
    /**
     * Start a new multi-step workflow
     */
    startWorkflow(sessionId: string, userRequest: string): AgentWorkflow {
        const workflow: AgentWorkflow = {
            id: `workflow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            sessionId,
            userRequest,
            steps: [],
            currentStepIndex: -1,
            status: 'planning',
            createdAt: new Date().toISOString()
        };
        this.workflows.set(workflow.id, workflow);
        this.currentWorkflowId = workflow.id;
        return workflow;
    }
    
    /**
     * Add a step to the current workflow
     */
    addStep(description: string, dependsOn: string[] = []): AgentStep {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) throw new Error('No active workflow');
        
        const stepNumber = workflow.steps.length + 1;
        const step: AgentStep = {
            id: `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            stepNumber,
            sessionId: workflow.sessionId,
            description,
            intent: workflow.userRequest,
            dependsOn: dependsOn.length > 0 ? dependsOn : 
                       stepNumber > 1 ? [workflow.steps[stepNumber - 2].id] : [],
            dependents: [],
            changeSetIds: [],
            status: 'pending',
            createdAt: new Date().toISOString()
        };
        
        // Update dependents of previous steps
        for (const depId of step.dependsOn) {
            const depStep = workflow.steps.find(s => s.id === depId);
            if (depStep) {
                depStep.dependents.push(step.id);
            }
        }
        
        workflow.steps.push(step);
        return step;
    }
    
    /**
     * Link a ChangeSet to the current step
     */
    linkChangeSet(changeSetId: string): void {
        const step = this.getCurrentStep();
        if (step) {
            step.changeSetIds.push(changeSetId);
        }
    }
    
    /**
     * Mark current step as applied
     */
    markStepApplied(execution?: AgentStep['execution']): void {
        const step = this.getCurrentStep();
        if (step) {
            step.status = 'applied';
            step.appliedAt = new Date().toISOString();
            if (execution) {
                step.execution = execution;
            }
        }
        const workflow = this.getCurrentWorkflow();
        if (workflow) {
            workflow.currentStepIndex++;
        }
    }
    
    /**
     * Revert a step and all its dependents (cascading rollback)
     */
    async revertStep(stepId: string): Promise<{
        revertedSteps: string[];
        revertedChangeSets: string[];
    }> {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) throw new Error('No active workflow');
        
        const step = workflow.steps.find(s => s.id === stepId);
        if (!step) throw new Error(`Step ${stepId} not found`);
        
        // Find all dependents (recursively)
        const stepsToRevert = this.getDependentChain(workflow, stepId);
        stepsToRevert.unshift(stepId); // Include the step itself
        
        // Revert in reverse order (newest first)
        const revertedChangeSets: string[] = [];
        for (const sid of stepsToRevert.reverse()) {
            const s = workflow.steps.find(x => x.id === sid);
            if (s && s.status === 'applied') {
                // Revert each ChangeSet in this step
                for (const csId of s.changeSetIds) {
                    // Use existing revert logic from codeActions
                    // This is where we integrate with your existing system
                    revertedChangeSets.push(csId);
                }
                s.status = 'reverted';
                s.revertedAt = new Date().toISOString();
            }
        }
        
        return {
            revertedSteps: stepsToRevert,
            revertedChangeSets
        };
    }
    
    /**
     * Get all steps that depend on a given step (recursively)
     */
    private getDependentChain(workflow: AgentWorkflow, stepId: string): string[] {
        const step = workflow.steps.find(s => s.id === stepId);
        if (!step) return [];
        
        const result: string[] = [];
        for (const depId of step.dependents) {
            result.push(depId);
            result.push(...this.getDependentChain(workflow, depId));
        }
        return result;
    }
    
    getCurrentWorkflow(): AgentWorkflow | null {
        return this.currentWorkflowId ? this.workflows.get(this.currentWorkflowId) || null : null;
    }
    
    getCurrentStep(): AgentStep | null {
        const workflow = this.getCurrentWorkflow();
        if (!workflow || workflow.currentStepIndex < 0) return null;
        return workflow.steps[workflow.currentStepIndex] || null;
    }
}

export const agentStepTracker = new AgentStepTracker();
```

#### Step 1.2: Add Couchbase persistence for workflows

**File:** `src/storage/chatSessionRepository.ts` (MODIFY)

Add new document types:

```typescript
// Add after line ~228 (after FileRevisionIndex)

/**
 * Persisted agent workflow document
 */
export interface AgentWorkflowDocument {
    id: string;                      // Document key: agent-workflow::{workflowId}
    docType: 'agent-workflow';
    sessionId: string;
    userRequest: string;
    steps: AgentStep[];              // Embedded for simplicity
    currentStepIndex: number;
    status: 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
    createdAt: string;
    completedAt?: string;
}

// Add CRUD functions:

export async function saveAgentWorkflow(workflow: AgentWorkflow): Promise<void> {
    const collection = await getCollection();
    if (!collection) return;
    
    const doc: AgentWorkflowDocument = {
        id: `agent-workflow::${workflow.id}`,
        docType: 'agent-workflow',
        ...workflow
    };
    
    await collection.upsert(doc.id, doc);
}

export async function getAgentWorkflow(workflowId: string): Promise<AgentWorkflow | null> {
    const collection = await getCollection();
    if (!collection) return null;
    
    try {
        const result = await collection.get(`agent-workflow::${workflowId}`);
        return result.content as AgentWorkflow;
    } catch {
        return null;
    }
}

export async function getSessionWorkflows(sessionId: string): Promise<AgentWorkflow[]> {
    // Use N1QL query to find all workflows for a session
    const cluster = await getCluster();
    if (!cluster) return [];
    
    const query = `
        SELECT META().id, * 
        FROM \`${BUCKET_NAME}\`.\`${SCOPE_NAME}\`.\`${COLLECTION_NAME}\`
        WHERE docType = 'agent-workflow' AND sessionId = $sessionId
        ORDER BY createdAt DESC
    `;
    
    const result = await cluster.query(query, { parameters: { sessionId } });
    return result.rows.map(row => row as AgentWorkflow);
}
```

---

### Phase 2: Integration with Existing Systems (Est. 3-4 hours)

#### Step 2.1: Modify ChangeTracker to emit events

**File:** `src/edits/changeTracker.ts` (MODIFY)

```typescript
// Add after line 35 (after onChangeCallback)

private onChangeSetAddedCallback?: (changeSet: ChangeSet) => void;

// Add method after onChange():
onChangeSetAdded(callback: (changeSet: ChangeSet) => void): void {
    this.onChangeSetAddedCallback = callback;
}

// Modify addChangeSet() to emit event (around line 140):
// After: this.changeHistory.push(changeSet);
// Add:
if (this.onChangeSetAddedCallback) {
    this.onChangeSetAddedCallback(changeSet);
}
```

#### Step 2.2: Wire up AgentStepTracker to ChangeTracker

**File:** `src/agent/agentStepTracker.ts` (MODIFY)

```typescript
// Add initialization function:

export function initializeStepTracking(): void {
    changeTracker.onChangeSetAdded((changeSet) => {
        // Automatically link new ChangeSets to current step
        agentStepTracker.linkChangeSet(changeSet.id);
    });
}
```

#### Step 2.3: Modify agentOrchestrator to use steps

**File:** `src/agent/agentOrchestrator.ts` (MODIFY)

The orchestrator needs to:
1. Detect when a multi-step workflow is needed (AI returns `todos`)
2. Create steps for each todo item
3. Execute steps sequentially with feedback

```typescript
// In the main orchestration loop, wrap each "turn" in a step:

async function executeAgentTurn(
    sessionId: string, 
    userMessage: string,
    context: AgentContext
): Promise<AgentResponse> {
    // Check if this is part of a multi-step workflow
    const workflow = agentStepTracker.getCurrentWorkflow();
    
    if (workflow && workflow.status === 'executing') {
        // We're in a workflow - this is the next step
        const step = agentStepTracker.addStep(
            `Executing: ${userMessage.slice(0, 50)}...`
        );
        
        try {
            const response = await callGrokAPI(/* ... */);
            
            // Apply changes (existing logic)
            // ChangeSets will auto-link via the callback
            
            // Capture execution results
            agentStepTracker.markStepApplied({
                commands: executedCommands,
                success: true
            });
            
            return response;
        } catch (error) {
            step.status = 'failed';
            step.execution = { commands: [], success: false, error: String(error) };
            throw error;
        }
    }
    
    // Not in a workflow - check if response starts one
    const response = await callGrokAPI(/* ... */);
    
    if (response.todos && response.todos.length > 1) {
        // AI returned multiple TODOs - start a workflow
        const workflow = agentStepTracker.startWorkflow(sessionId, userMessage);
        
        // Create steps for each TODO
        for (const todo of response.todos) {
            agentStepTracker.addStep(todo.text);
        }
        
        workflow.status = 'executing';
    }
    
    return response;
}
```

---

### Phase 3: UI Integration (Est. 2-3 hours)

#### Step 3.1: Add workflow status to webview

**File:** `src/views/ChatViewProvider.ts` (MODIFY)

Add message handlers for:
- `getWorkflowStatus` - Return current workflow and steps
- `revertToStep` - Cascading revert to a specific step
- `cancelWorkflow` - Stop execution

#### Step 3.2: Add step timeline UI component

**File:** `media/main.js` (MODIFY)

Add a visual timeline showing:
```
Step 1 ──✓── Step 2 ──✓── Step 3 ──●── Step 4 ──○── Step 5
 Edit auth    Add tests   [current]   Run tests   Deploy
```

#### Step 3.3: Add step revert buttons

Each step in the timeline should have a "Revert to here" button that:
1. Shows warning if dependent steps exist
2. Calls `revertToStep` with confirmation

---

### Phase 4: Persistence & Recovery (Est. 2 hours)

#### Step 4.1: Auto-save workflow state

After each step completion, save to Couchbase:

```typescript
agentStepTracker.markStepApplied(execution);
await saveAgentWorkflow(agentStepTracker.getCurrentWorkflow()!);
```

#### Step 4.2: Restore workflow on session load

When loading a chat session, also load its active workflow:

```typescript
// In ChatViewProvider.restoreSession():
const workflows = await getSessionWorkflows(sessionId);
const activeWorkflow = workflows.find(w => w.status === 'executing');
if (activeWorkflow) {
    agentStepTracker.restoreWorkflow(activeWorkflow);
}
```

---

## File Changes Summary

| File | Action | Changes |
|------|--------|---------|
| `src/agent/agentStepTracker.ts` | **CREATE** | New file with AgentStepTracker class |
| `src/storage/chatSessionRepository.ts` | MODIFY | Add AgentWorkflowDocument type + CRUD functions |
| `src/edits/changeTracker.ts` | MODIFY | Add `onChangeSetAdded` callback hook |
| `src/agent/agentOrchestrator.ts` | MODIFY | Wrap turns in steps, detect multi-step workflows |
| `src/views/ChatViewProvider.ts` | MODIFY | Add workflow message handlers |
| `media/main.js` | MODIFY | Add step timeline UI |
| `src/extension.ts` | MODIFY | Call `initializeStepTracking()` on activate |

---

## Migration Considerations

### Backward Compatibility

- Existing sessions without workflows continue to work (single-step mode)
- ChangeSets created outside a workflow are still tracked by ChangeTracker
- No database migration needed - new document types are additive

### Testing Strategy

1. **Unit tests** for AgentStepTracker (step creation, dependency tracking, cascade revert)
2. **Integration tests** for ChangeTracker ↔ AgentStepTracker linkage
3. **E2E tests** for multi-step workflow execution and rollback

---

## Example Workflow

### User Request
> "Add authentication to my Express app with JWT tokens"

### AI Plans Steps
```
📋 TODOS
- [ ] Install jsonwebtoken and bcrypt packages
- [ ] Create auth middleware
- [ ] Add login/register routes
- [ ] Protect existing routes
- [ ] Add tests
```

### Execution Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ Workflow: "Add authentication to my Express app with JWT tokens" │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: Install packages                                        │
│  ├── Command: npm install jsonwebtoken bcrypt                    │
│  ├── Result: ✓ Success (exit 0)                                  │
│  └── ChangeSets: [cs-001] (package.json, package-lock.json)      │
│                    │                                             │
│                    ▼                                             │
│  Step 2: Create auth middleware                                  │
│  ├── ChangeSets: [cs-002] (src/middleware/auth.ts)               │
│  └── Status: ✓ Applied                                           │
│                    │                                             │
│                    ▼                                             │
│  Step 3: Add login/register routes  ◄── YOU ARE HERE             │
│  ├── ChangeSets: [cs-003, cs-004]                                │
│  └── Status: ● In Progress                                       │
│                    │                                             │
│                    ▼                                             │
│  Step 4: Protect existing routes                                 │
│  └── Status: ○ Pending                                           │
│                    │                                             │
│                    ▼                                             │
│  Step 5: Add tests                                               │
│  └── Status: ○ Pending                                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Rollback Scenario

User clicks "Revert to Step 1":

```
⚠️ Warning: This will also revert:
  - Step 2: Create auth middleware
  - Step 3: Add login/register routes (in progress)

Files that will be restored:
  - src/middleware/auth.ts (deleted)
  - src/routes/auth.ts (deleted)
  - src/routes/users.ts (restored to original)

[Cancel] [Revert All]
```

---

## Open Questions

1. **Parallel steps?** - Should we support steps that don't depend on each other running in parallel?
2. **Step editing?** - Can users modify a step's code after it's applied but before moving to next step?
3. **Branch workflows?** - What if user wants to try a different approach at step 3?
4. **Storage limits?** - Should we limit workflow history per session?

---

## Implementation Status

### Completed ✅

1. [x] Created `src/agent/agentStepTracker.ts` with core interfaces
2. [x] Added Couchbase document types (`AgentWorkflowDocument`, `PersistedAgentStep`)
3. [x] Wired up ChangeTracker callback (`onChangeSetAdded`)
4. [x] Added workflow creation from TODOs in ChatViewProvider
5. [x] Added UI components (workflow timeline bar with step nodes)
6. [x] Added step revert functionality with cascade preview
7. [x] Added message handlers for workflow operations

### Files Changed

| File | Changes |
|------|---------|
| `src/agent/agentStepTracker.ts` | **NEW** - Core step tracking logic |
| `src/edits/changeTracker.ts` | Added `onChangeSetAdded` callback |
| `src/edits/codeActions.ts` | Added step revert functions |
| `src/storage/chatSessionRepository.ts` | Added workflow document types + CRUD |
| `src/extension.ts` | Initialize step tracking on activation |
| `src/views/ChatViewProvider.ts` | Added workflow UI + message handlers |

### Remaining Work

1. [ ] Write unit tests for AgentStepTracker
2. [ ] Add workflow persistence to Couchbase on step changes
3. [ ] Restore workflow on session load
4. [ ] Document in README

---

## Related Documents

- [CHAT_DESIGN.md](./CHAT_DESIGN.md) - Overall chat architecture
- [FILE_TRACKING_IMPROVEMENTS.md](./FILE_TRACKING_IMPROVEMENTS.md) - Line-level tracking design
- [rollback_test_prompts.md](./rollback_test_prompts.md) - Testing rollback scenarios
