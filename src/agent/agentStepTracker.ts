/**
 * Agent Step Tracker - Manages multi-step agent workflows
 * 
 * This module provides step-based grouping on top of the existing ChangeTracker.
 * It enables:
 * - Grouping ChangeSets into logical "steps"
 * - Dependency tracking between steps
 * - Cascading rollback (revert step 3 → also reverts steps 4, 5, ...)
 * - Execution result capture for agent loop feedback
 */

import { changeTracker, ChangeSet } from '../edits/changeTracker';
import { revertToChangeSet } from '../edits/codeActions';
import { debug, info, error as logError } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * A command executed as part of an agent step
 */
export interface AgentCommand {
    id: string;
    command: string;
    cwd: string;
    exitCode?: number;
    stdout?: string;      // First 2000 chars
    stderr?: string;      // First 2000 chars
    durationMs: number;
    success: boolean;
}

/**
 * Represents a single step in a multi-step agent workflow.
 * Each step can contain multiple file changes (ChangeSets) and 
 * tracks dependencies on previous steps.
 */
export interface AgentStep {
    id: string;
    stepNumber: number;
    sessionId: string;
    
    // What this step does
    description: string;
    intent: string;               // User's original request
    
    // Dependencies
    dependsOn: string[];          // Step IDs this depends on
    dependents: string[];         // Steps that depend on this one
    
    // Links to existing ChangeTracker
    changeSetIds: string[];
    
    // Execution context (for agent loop feedback)
    execution?: {
        commands: AgentCommand[];
        success: boolean;
        error?: string;
    };
    
    // State
    status: 'pending' | 'in-progress' | 'applied' | 'reverted' | 'failed';
    createdAt: string;
    appliedAt?: string;
    revertedAt?: string;
}

/**
 * Workflow containing all steps for a multi-step task
 */
export interface AgentWorkflow {
    id: string;
    sessionId: string;
    userRequest: string;
    steps: AgentStep[];
    currentStepIndex: number;     // Which step we're on (-1 = not started)
    status: 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
    createdAt: string;
    completedAt?: string;
}

/**
 * Result of a step revert operation
 */
export interface StepRevertResult {
    success: boolean;
    revertedSteps: string[];
    revertedChangeSets: string[];
    errors: string[];
}

// ============================================================================
// AgentStepTracker Class
// ============================================================================

class AgentStepTracker {
    private workflows: Map<string, AgentWorkflow> = new Map();
    private currentWorkflowId: string | null = null;
    private onWorkflowChangeCallback?: (workflow: AgentWorkflow | null) => void;
    private onStepChangeCallback?: (step: AgentStep | null, workflow: AgentWorkflow | null) => void;

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
        
        info(`[AgentStep] Started workflow ${workflow.id}: "${userRequest.slice(0, 50)}..."`);
        this.notifyWorkflowChange();
        
        return workflow;
    }

    /**
     * Add a step to the current workflow
     * @param description What this step does
     * @param dependsOn Step IDs this depends on (defaults to previous step)
     */
    addStep(description: string, dependsOn: string[] = []): AgentStep {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) {
            throw new Error('No active workflow - call startWorkflow() first');
        }

        const stepNumber = workflow.steps.length + 1;
        const step: AgentStep = {
            id: `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            stepNumber,
            sessionId: workflow.sessionId,
            description,
            intent: workflow.userRequest,
            dependsOn: dependsOn.length > 0 
                ? dependsOn 
                : stepNumber > 1 
                    ? [workflow.steps[stepNumber - 2].id] 
                    : [],
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
        
        debug(`[AgentStep] Added step ${stepNumber}: "${description}"`);
        this.notifyWorkflowChange();
        
        return step;
    }

    /**
     * Start executing a step (marks it as in-progress)
     */
    startStep(stepId?: string): AgentStep | null {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) return null;

        let step: AgentStep | undefined;
        
        if (stepId) {
            step = workflow.steps.find(s => s.id === stepId);
        } else {
            // Find next pending step
            step = workflow.steps.find(s => s.status === 'pending');
        }

        if (step) {
            step.status = 'in-progress';
            workflow.currentStepIndex = workflow.steps.indexOf(step);
            workflow.status = 'executing';
            
            debug(`[AgentStep] Started step ${step.stepNumber}: "${step.description}"`);
            this.notifyStepChange(step);
        }

        return step || null;
    }

    /**
     * Link a ChangeSet to the current step
     */
    linkChangeSet(changeSetId: string): void {
        const step = this.getCurrentStep();
        if (step && step.status === 'in-progress') {
            step.changeSetIds.push(changeSetId);
            debug(`[AgentStep] Linked ChangeSet ${changeSetId} to step ${step.stepNumber}`);
        }
    }

    /**
     * Mark current step as applied/completed
     */
    markStepApplied(execution?: AgentStep['execution']): void {
        const step = this.getCurrentStep();
        if (step) {
            step.status = 'applied';
            step.appliedAt = new Date().toISOString();
            if (execution) {
                step.execution = execution;
            }
            
            info(`[AgentStep] Step ${step.stepNumber} applied with ${step.changeSetIds.length} ChangeSets`);
            this.notifyStepChange(step);
        }
        
        // Check if workflow is complete
        const workflow = this.getCurrentWorkflow();
        if (workflow) {
            const allApplied = workflow.steps.every(s => s.status === 'applied');
            if (allApplied) {
                workflow.status = 'completed';
                workflow.completedAt = new Date().toISOString();
                info(`[AgentStep] Workflow ${workflow.id} completed`);
                this.notifyWorkflowChange();
            }
        }
    }

    /**
     * Mark current step as failed
     */
    markStepFailed(error: string): void {
        const step = this.getCurrentStep();
        if (step) {
            step.status = 'failed';
            step.execution = {
                commands: step.execution?.commands || [],
                success: false,
                error
            };
            
            logError(`[AgentStep] Step ${step.stepNumber} failed: ${error}`);
            this.notifyStepChange(step);
        }

        const workflow = this.getCurrentWorkflow();
        if (workflow) {
            workflow.status = 'failed';
            this.notifyWorkflowChange();
        }
    }

    /**
     * Add a command execution result to the current step
     */
    addCommandResult(command: AgentCommand): void {
        const step = this.getCurrentStep();
        if (step) {
            if (!step.execution) {
                step.execution = { commands: [], success: true };
            }
            step.execution.commands.push(command);
            
            // If command failed, mark execution as failed
            if (!command.success) {
                step.execution.success = false;
            }
        }
    }

    /**
     * Revert a step and all its dependents (cascading rollback)
     * @param stepId The step to revert
     * @param dryRun If true, only return what would be reverted without doing it
     */
    async revertStep(stepId: string, dryRun: boolean = false): Promise<StepRevertResult> {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) {
            return { success: false, revertedSteps: [], revertedChangeSets: [], errors: ['No active workflow'] };
        }

        const step = workflow.steps.find(s => s.id === stepId);
        if (!step) {
            return { success: false, revertedSteps: [], revertedChangeSets: [], errors: [`Step ${stepId} not found`] };
        }

        // Find all dependents (recursively)
        const stepsToRevert = this.getDependentChain(workflow, stepId);
        stepsToRevert.unshift(stepId); // Include the step itself

        // Get unique step IDs in reverse order (newest first)
        const uniqueSteps = [...new Set(stepsToRevert)].reverse();
        
        const result: StepRevertResult = {
            success: true,
            revertedSteps: [],
            revertedChangeSets: [],
            errors: []
        };

        if (dryRun) {
            // Just return what would be reverted
            for (const sid of uniqueSteps) {
                const s = workflow.steps.find(x => x.id === sid);
                if (s && (s.status === 'applied' || s.status === 'in-progress')) {
                    result.revertedSteps.push(sid);
                    result.revertedChangeSets.push(...s.changeSetIds);
                }
            }
            return result;
        }

        // Actually revert (in reverse order - newest first)
        info(`[AgentStep] Reverting ${uniqueSteps.length} steps starting from step ${step.stepNumber}`);
        
        for (const sid of uniqueSteps) {
            const s = workflow.steps.find(x => x.id === sid);
            if (s && (s.status === 'applied' || s.status === 'in-progress')) {
                // Revert each ChangeSet in this step (in reverse order)
                for (const csId of [...s.changeSetIds].reverse()) {
                    try {
                        await revertToChangeSet(csId);
                        result.revertedChangeSets.push(csId);
                        debug(`[AgentStep] Reverted ChangeSet ${csId}`);
                    } catch (err: any) {
                        result.errors.push(`Failed to revert ChangeSet ${csId}: ${err.message}`);
                        result.success = false;
                    }
                }
                
                s.status = 'reverted';
                s.revertedAt = new Date().toISOString();
                result.revertedSteps.push(sid);
            }
        }

        // Update workflow status
        workflow.currentStepIndex = workflow.steps.findIndex(s => s.status === 'applied');
        if (workflow.currentStepIndex === -1) {
            workflow.status = 'cancelled';
        }

        this.notifyWorkflowChange();
        
        info(`[AgentStep] Reverted ${result.revertedSteps.length} steps, ${result.revertedChangeSets.length} ChangeSets`);
        
        return result;
    }

    /**
     * Revert to a specific step (revert everything after it)
     */
    async revertToStep(stepNumber: number): Promise<StepRevertResult> {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) {
            return { success: false, revertedSteps: [], revertedChangeSets: [], errors: ['No active workflow'] };
        }

        // Find all steps after the target
        const stepsToRevert = workflow.steps
            .filter(s => s.stepNumber > stepNumber && s.status === 'applied')
            .map(s => s.id);

        if (stepsToRevert.length === 0) {
            return { success: true, revertedSteps: [], revertedChangeSets: [], errors: [] };
        }

        // Revert from the last step backward
        const result: StepRevertResult = {
            success: true,
            revertedSteps: [],
            revertedChangeSets: [],
            errors: []
        };

        for (const stepId of stepsToRevert.reverse()) {
            const stepResult = await this.revertStep(stepId);
            result.revertedSteps.push(...stepResult.revertedSteps);
            result.revertedChangeSets.push(...stepResult.revertedChangeSets);
            result.errors.push(...stepResult.errors);
            if (!stepResult.success) {
                result.success = false;
            }
        }

        return result;
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

    /**
     * Get the current workflow
     */
    getCurrentWorkflow(): AgentWorkflow | null {
        return this.currentWorkflowId 
            ? this.workflows.get(this.currentWorkflowId) || null 
            : null;
    }

    /**
     * Get the current step (the one being executed)
     */
    getCurrentStep(): AgentStep | null {
        const workflow = this.getCurrentWorkflow();
        if (!workflow || workflow.currentStepIndex < 0) return null;
        return workflow.steps[workflow.currentStepIndex] || null;
    }

    /**
     * Get a specific workflow by ID
     */
    getWorkflow(workflowId: string): AgentWorkflow | null {
        return this.workflows.get(workflowId) || null;
    }

    /**
     * Get all workflows for a session
     */
    getSessionWorkflows(sessionId: string): AgentWorkflow[] {
        return Array.from(this.workflows.values())
            .filter(w => w.sessionId === sessionId)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    /**
     * Set the current workflow (for restoring from persistence)
     */
    setCurrentWorkflow(workflowId: string): void {
        if (this.workflows.has(workflowId)) {
            this.currentWorkflowId = workflowId;
            this.notifyWorkflowChange();
        }
    }

    /**
     * Restore a workflow from persistence
     */
    restoreWorkflow(workflow: AgentWorkflow): void {
        this.workflows.set(workflow.id, workflow);
        if (workflow.status === 'executing') {
            this.currentWorkflowId = workflow.id;
        }
        debug(`[AgentStep] Restored workflow ${workflow.id} with ${workflow.steps.length} steps`);
    }

    /**
     * Cancel the current workflow
     */
    cancelWorkflow(): void {
        const workflow = this.getCurrentWorkflow();
        if (workflow) {
            workflow.status = 'cancelled';
            workflow.completedAt = new Date().toISOString();
            info(`[AgentStep] Cancelled workflow ${workflow.id}`);
            this.notifyWorkflowChange();
        }
        this.currentWorkflowId = null;
    }

    /**
     * Clear all workflows (for testing or reset)
     */
    clear(): void {
        this.workflows.clear();
        this.currentWorkflowId = null;
        this.notifyWorkflowChange();
    }

    /**
     * Clear workflows for a specific session
     */
    clearSession(sessionId: string): void {
        for (const [id, workflow] of this.workflows.entries()) {
            if (workflow.sessionId === sessionId) {
                this.workflows.delete(id);
            }
        }
        if (this.currentWorkflowId && !this.workflows.has(this.currentWorkflowId)) {
            this.currentWorkflowId = null;
        }
        this.notifyWorkflowChange();
    }

    /**
     * Register callback for workflow changes
     */
    onWorkflowChange(callback: (workflow: AgentWorkflow | null) => void): void {
        this.onWorkflowChangeCallback = callback;
    }

    /**
     * Register callback for step changes
     */
    onStepChange(callback: (step: AgentStep | null, workflow: AgentWorkflow | null) => void): void {
        this.onStepChangeCallback = callback;
    }

    private notifyWorkflowChange(): void {
        if (this.onWorkflowChangeCallback) {
            this.onWorkflowChangeCallback(this.getCurrentWorkflow());
        }
    }

    private notifyStepChange(step: AgentStep | null): void {
        if (this.onStepChangeCallback) {
            this.onStepChangeCallback(step, this.getCurrentWorkflow());
        }
    }

    /**
     * Serialize for persistence
     */
    toSerializable(): { workflows: AgentWorkflow[]; currentWorkflowId: string | null } {
        return {
            workflows: Array.from(this.workflows.values()),
            currentWorkflowId: this.currentWorkflowId
        };
    }

    /**
     * Restore from serialized data
     */
    fromSerializable(data: { workflows: AgentWorkflow[]; currentWorkflowId: string | null }): void {
        this.workflows.clear();
        for (const workflow of data.workflows) {
            this.workflows.set(workflow.id, workflow);
        }
        this.currentWorkflowId = data.currentWorkflowId;
        this.notifyWorkflowChange();
    }

    /**
     * Get workflow summary for UI display
     */
    getWorkflowSummary(): {
        hasActiveWorkflow: boolean;
        workflowId: string | null;
        totalSteps: number;
        completedSteps: number;
        currentStepNumber: number;
        status: string;
    } {
        const workflow = this.getCurrentWorkflow();
        if (!workflow) {
            return {
                hasActiveWorkflow: false,
                workflowId: null,
                totalSteps: 0,
                completedSteps: 0,
                currentStepNumber: 0,
                status: 'none'
            };
        }

        return {
            hasActiveWorkflow: true,
            workflowId: workflow.id,
            totalSteps: workflow.steps.length,
            completedSteps: workflow.steps.filter(s => s.status === 'applied').length,
            currentStepNumber: workflow.currentStepIndex + 1,
            status: workflow.status
        };
    }
}

// ============================================================================
// Singleton & Initialization
// ============================================================================

export const agentStepTracker = new AgentStepTracker();

/**
 * Initialize step tracking by wiring up to ChangeTracker
 * Call this once during extension activation
 */
export function initializeStepTracking(): void {
    changeTracker.onChangeSetAdded((changeSet: ChangeSet) => {
        // Automatically link new ChangeSets to current step
        agentStepTracker.linkChangeSet(changeSet.id);
    });
    
    info('[AgentStep] Step tracking initialized');
}

/**
 * Get the agent step tracker instance
 */
export function getAgentStepTracker(): AgentStepTracker {
    return agentStepTracker;
}
