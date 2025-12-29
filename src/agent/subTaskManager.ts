/**
 * Sub-Task Manager
 * 
 * Manages AI-proposed sub-tasks that can run semi-autonomously.
 * Phase 2: User approves batches of sub-tasks before execution.
 */

import { v4 as uuidv4 } from 'uuid';
import { debug, info, error as logError } from '../utils/logger';

/**
 * Sub-task status lifecycle:
 * pending -> ready -> running -> completed/failed
 * 
 * A task moves to 'ready' when all dependencies are completed.
 */
export type SubTaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * A sub-task proposed by the AI for semi-autonomous execution
 */
export interface SubTask {
    id: string;
    goal: string;
    files: string[];
    dependencies: string[];
    autoExecute: boolean;
    status: SubTaskStatus;
    sessionId?: string;
    result?: string;
    error?: string;
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    filesChanged?: string[];
}

/**
 * Sub-task as parsed from AI response (minimal fields)
 */
export interface SubTaskInput {
    id: string;
    goal: string;
    files?: string[];
    dependencies?: string[];
    autoExecute?: boolean;
}

/**
 * Result from executing a sub-task
 */
export interface SubTaskResult {
    taskId: string;
    success: boolean;
    summary?: string;
    filesChanged?: string[];
    error?: string;
}

/**
 * Session-level sub-task tracking
 */
export interface SubTaskRegistry {
    tasks: SubTask[];
    parentSessionId: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * Creates a SubTask from AI response input
 */
export function createSubTask(input: SubTaskInput): SubTask {
    return {
        id: input.id || uuidv4().slice(0, 8),
        goal: input.goal,
        files: input.files || [],
        dependencies: input.dependencies || [],
        autoExecute: input.autoExecute || false,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
}

/**
 * Validates sub-task inputs from AI response
 */
export function validateSubTasks(inputs: unknown): SubTaskInput[] {
    if (!Array.isArray(inputs)) {
        return [];
    }

    return inputs.filter((input): input is SubTaskInput => {
        if (typeof input !== 'object' || input === null) {
            return false;
        }
        const obj = input as Record<string, unknown>;
        return (
            typeof obj.id === 'string' &&
            obj.id.trim().length > 0 &&
            typeof obj.goal === 'string' &&
            obj.goal.trim().length > 0
        );
    }).map(input => ({
        id: input.id.trim(),
        goal: input.goal.trim(),
        files: Array.isArray(input.files) 
            ? input.files.filter((f): f is string => typeof f === 'string')
            : [],
        dependencies: Array.isArray(input.dependencies)
            ? input.dependencies.filter((d): d is string => typeof d === 'string')
            : [],
        autoExecute: typeof input.autoExecute === 'boolean' ? input.autoExecute : false
    }));
}

/**
 * SubTaskManager handles the lifecycle of sub-tasks for a session
 */
export class SubTaskManager {
    private tasks: Map<string, SubTask> = new Map();
    private parentSessionId: string;

    constructor(parentSessionId: string) {
        this.parentSessionId = parentSessionId;
    }

    /**
     * Add sub-tasks from AI response
     */
    addTasks(inputs: SubTaskInput[]): SubTask[] {
        const newTasks: SubTask[] = [];
        
        for (const input of inputs) {
            if (this.tasks.has(input.id)) {
                debug(`SubTask ${input.id} already exists, skipping`);
                continue;
            }
            
            const task = createSubTask(input);
            this.tasks.set(task.id, task);
            newTasks.push(task);
            debug(`Added sub-task: ${task.id} - ${task.goal.slice(0, 50)}...`);
        }

        this.updateReadyStatus();
        return newTasks;
    }

    /**
     * Get all tasks
     */
    getAllTasks(): SubTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get a specific task by ID
     */
    getTask(id: string): SubTask | undefined {
        return this.tasks.get(id);
    }

    /**
     * Get tasks that are ready to execute (all dependencies completed)
     */
    getReadyTasks(): SubTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'ready');
    }

    /**
     * Get tasks that can be auto-executed
     */
    getAutoExecutableTasks(): SubTask[] {
        return this.getReadyTasks().filter(t => t.autoExecute);
    }

    /**
     * Update status of tasks based on dependency completion
     */
    private updateReadyStatus(): void {
        for (const task of this.tasks.values()) {
            if (task.status !== 'pending') {
                continue;
            }

            const allDepsCompleted = task.dependencies.every(depId => {
                const dep = this.tasks.get(depId);
                return dep && dep.status === 'completed';
            });

            const anyDepFailed = task.dependencies.some(depId => {
                const dep = this.tasks.get(depId);
                return dep && (dep.status === 'failed' || dep.status === 'skipped');
            });

            if (anyDepFailed) {
                task.status = 'skipped';
                debug(`Sub-task ${task.id} skipped due to failed dependency`);
            } else if (allDepsCompleted || task.dependencies.length === 0) {
                task.status = 'ready';
                debug(`Sub-task ${task.id} is now ready`);
            }
        }
    }

    /**
     * Mark a task as running
     */
    startTask(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task || task.status !== 'ready') {
            return false;
        }
        
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        info(`Starting sub-task: ${id}`);
        return true;
    }

    /**
     * Mark a task as completed with result
     */
    completeTask(id: string, result: SubTaskResult): boolean {
        const task = this.tasks.get(id);
        if (!task) {
            return false;
        }

        if (result.success) {
            task.status = 'completed';
            task.result = result.summary;
            task.filesChanged = result.filesChanged;
        } else {
            task.status = 'failed';
            task.error = result.error;
        }
        
        task.completedAt = new Date().toISOString();
        
        this.updateReadyStatus();
        info(`Sub-task ${id} ${result.success ? 'completed' : 'failed'}`);
        return true;
    }

    /**
     * Skip a task (user chose not to run it)
     */
    skipTask(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task) {
            return false;
        }
        
        task.status = 'skipped';
        task.completedAt = new Date().toISOString();
        
        this.updateReadyStatus();
        debug(`Sub-task ${id} skipped by user`);
        return true;
    }

    /**
     * Check if all tasks are complete (or skipped/failed)
     */
    isAllComplete(): boolean {
        return Array.from(this.tasks.values()).every(
            t => t.status === 'completed' || t.status === 'failed' || t.status === 'skipped'
        );
    }

    /**
     * Get summary of task statuses
     */
    getStatusSummary(): { pending: number; ready: number; running: number; completed: number; failed: number; skipped: number } {
        const summary = { pending: 0, ready: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
        for (const task of this.tasks.values()) {
            summary[task.status]++;
        }
        return summary;
    }

    /**
     * Build dependency graph for visualization
     */
    getDependencyGraph(): { nodes: Array<{ id: string; label: string; status: SubTaskStatus }>; edges: Array<{ from: string; to: string }> } {
        const nodes = Array.from(this.tasks.values()).map(t => ({
            id: t.id,
            label: t.goal.length > 40 ? t.goal.slice(0, 40) + '...' : t.goal,
            status: t.status
        }));

        const edges: Array<{ from: string; to: string }> = [];
        for (const task of this.tasks.values()) {
            for (const depId of task.dependencies) {
                edges.push({ from: depId, to: task.id });
            }
        }

        return { nodes, edges };
    }

    /**
     * Serialize for storage
     */
    toRegistry(): SubTaskRegistry {
        return {
            tasks: Array.from(this.tasks.values()),
            parentSessionId: this.parentSessionId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
    }

    /**
     * Load from storage
     */
    static fromRegistry(registry: SubTaskRegistry): SubTaskManager {
        const manager = new SubTaskManager(registry.parentSessionId);
        for (const task of registry.tasks) {
            manager.tasks.set(task.id, task);
        }
        return manager;
    }

    /**
     * Generate handoff context for a child session
     */
    buildHandoffContext(taskId: string, parentSummary?: string): string {
        const task = this.tasks.get(taskId);
        if (!task) {
            return '';
        }

        let context = `## Sub-Task Assignment\n\n`;
        context += `**Task ID:** ${task.id}\n`;
        context += `**Goal:** ${task.goal}\n\n`;

        if (parentSummary) {
            context += `### Parent Session Context\n${parentSummary}\n\n`;
        }

        if (task.files.length > 0) {
            context += `### Files to Work With\n`;
            for (const file of task.files) {
                context += `- ${file}\n`;
            }
            context += '\n';
        }

        context += `### Scope\n`;
        context += `Focus ONLY on the stated goal. Do not expand scope beyond what is specified.\n`;
        context += `When complete, provide a summary of what was accomplished.\n`;

        return context;
    }

    /**
     * Generate markdown summary for UI display
     */
    buildDisplaySummary(): string {
        if (this.tasks.size === 0) {
            return '';
        }

        const summary = this.getStatusSummary();
        let md = `## 📋 Sub-Tasks (${summary.completed}/${this.tasks.size} complete)\n\n`;

        const statusEmoji: Record<SubTaskStatus, string> = {
            pending: '⏸️',
            ready: '🟡',
            running: '🔄',
            completed: '✅',
            failed: '❌',
            skipped: '⏭️'
        };

        for (const task of this.tasks.values()) {
            md += `${statusEmoji[task.status]} **${task.id}**: ${task.goal}\n`;
            if (task.dependencies.length > 0) {
                md += `   └─ Depends on: ${task.dependencies.join(', ')}\n`;
            }
            if (task.result) {
                md += `   └─ Result: ${task.result}\n`;
            }
            if (task.error) {
                md += `   └─ Error: ${task.error}\n`;
            }
        }

        return md;
    }
}
