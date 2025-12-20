/**
 * Action types for the three-pass agent workflow.
 * 
 * Pass 1: Fast model creates a plan with actions
 * Pass 2: Execute actions (read files, fetch URLs)
 * Pass 3: Main model processes everything and can update the plan
 */

export interface FileAction {
    type: 'file';
    pattern: string;
    reason: string;
}

export interface UrlAction {
    type: 'url';
    url: string;
    reason: string;
}

export interface TodoAction {
    text: string;
    order: number;
    status: 'pending' | 'in-progress' | 'done';
}

export type Action = FileAction | UrlAction;

export interface AgentPlan {
    todos: TodoAction[];
    actions: Action[];
    summary: string;
}

export interface ActionResult {
    action: Action;
    success: boolean;
    content?: string;
    error?: string;
    metadata?: {
        lines?: number;
        bytes?: number;
        files?: string[];
    };
}

export interface ExecutionResult {
    plan: AgentPlan;
    results: ActionResult[];
    filesContent: Map<string, string>;
    urlsContent: Map<string, string>;
}

export interface ProgressUpdate {
    type: 'plan' | 'file-start' | 'file-done' | 'url-start' | 'url-done' | 'error';
    message: string;
    details?: {
        path?: string;
        url?: string;
        lines?: number;
        bytes?: number;
        todoCount?: number;
        actionCount?: number;
        files?: string[];
    };
}
