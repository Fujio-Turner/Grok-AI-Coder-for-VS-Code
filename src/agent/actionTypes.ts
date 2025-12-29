/**
 * Action types for the three-pass agent workflow.
 * 
 * Pass 1: Fast model creates a plan with actions
 * Pass 2: Execute actions (read files, fetch URLs)
 * Pass 3: Main model processes everything and can update the plan
 */

export type FallbackAction = 'ask_user' | 'skip' | 'create_new';

export interface FileAction {
    type: 'file';
    /** @deprecated Use patterns array instead */
    pattern?: string;
    /** Glob patterns to try in order (first match wins) */
    patterns?: string[];
    reason: string;
    /** If true, task cannot proceed without this file */
    required?: boolean;
    /** What to do if all patterns fail */
    fallbackAction?: FallbackAction;
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
    /** MD5 hashes of files - keyed by file path */
    fileHashes: Map<string, string>;
    urlsContent: Map<string, string>;
}

export interface ProgressUpdate {
    type: 'plan' | 'file-start' | 'file-done' | 'url-start' | 'url-done' | 'dir-start' | 'dir-done' | 'error';
    message: string;
    details?: {
        path?: string;
        url?: string;
        lines?: number;
        bytes?: number;
        todoCount?: number;
        actionCount?: number;
        files?: string[];
        directories?: string[];
        fileCount?: number;
        dirCount?: number;
    };
}

export interface DirectoryListingEntry {
    name: string;
    isDirectory: boolean;
    sizeBytes?: number;
}

export interface DirectoryListingResult {
    path: string;
    entries: DirectoryListingEntry[];
    error?: string;
    filter?: string;
    recursive: boolean;
}
