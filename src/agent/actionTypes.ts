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

/**
 * Local analysis action - AI requests to run a command locally to analyze large files.
 * Uses the CLI whitelist system for security.
 * 
 * Use cases:
 * - Extract specific line ranges from large files
 * - Search for patterns (grep)
 * - Count occurrences
 * - Parse file structure
 */
export interface AnalyzeAction {
    type: 'analyze';
    /** Command to execute (e.g., "grep -n 'DASHBOARD_HTML' file.py") */
    command: string;
    /** Path to the file being analyzed (for context) */
    targetFile?: string;
    /** What information is being extracted */
    reason: string;
    /** Expected output format hint (helps AI parse the result) */
    outputHint?: 'line_numbers' | 'json' | 'text' | 'count';
    /** If true and command not whitelisted, prompt user (otherwise skip) */
    requireApproval?: boolean;
}

/**
 * Extract action - AI requests to extract a portion of a file using local commands.
 * Useful for large files where only a section is needed.
 */
export interface ExtractAction {
    type: 'extract';
    /** Source file path */
    sourceFile: string;
    /** Start line (1-indexed) */
    startLine: number;
    /** End line (1-indexed) */
    endLine: number;
    /** Destination file path (optional - if provided, saves extracted content) */
    destinationFile?: string;
    /** Why this extraction is needed */
    reason: string;
}

/**
 * Request content action - AI explicitly requests how to receive a large file's content.
 * Used in the "file awareness" system where AI sees metadata first, then chooses delivery method.
 */
export interface RequestContentAction {
    type: 'request_content';
    /** Path to the file (as shown in metadata) */
    filePath: string;
    /** How AI wants to receive the content */
    deliveryMethod: 'chunk' | 'analyze' | 'extract';
    /** For 'analyze': the command to run (e.g., "grep -n 'class' file.py") */
    command?: string;
    /** For 'extract': start line (1-indexed) */
    startLine?: number;
    /** For 'extract': end line (1-indexed) */
    endLine?: number;
    /** Why this content/analysis is needed */
    reason: string;
}

/**
 * Metadata about a large file - sent to AI instead of full content.
 * AI can then request content via RequestContentAction.
 */
export interface FileMetadata {
    /** Relative path from workspace root */
    path: string;
    /** File size in bytes */
    sizeBytes: number;
    /** Number of lines */
    lineCount: number;
    /** File extension/language */
    language: string;
    /** MD5 hash for verification */
    md5Hash: string;
    /** First few lines of the file (for context) */
    preview: string;
    /** Structure hints - classes, functions, sections found */
    structureHints?: {
        classes?: string[];
        functions?: string[];
        sections?: string[];
    };
    /** Why this file wasn't loaded (size threshold) */
    reason: string;
}

export interface TodoAction {
    text: string;
    order: number;
    status: 'pending' | 'in-progress' | 'done';
}

export type Action = FileAction | UrlAction | AnalyzeAction | ExtractAction | RequestContentAction;

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
    /** Metadata for large files (file awareness system) */
    largeFileMetadata?: FileMetadata[];
}

export interface ProgressUpdate {
    type: 'plan' | 'file-start' | 'file-done' | 'url-start' | 'url-done' | 'dir-start' | 'dir-done' | 'error';
    message: string;
    /** Wall clock timestamp when this operation started/completed */
    timestamp?: string;
    /** Duration in milliseconds for completed operations */
    durationMs?: number;
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

// ============================================================================
// Telemetry Collector - Collects timing entries during a request
// ============================================================================

import { 
    TelemetryEntry, 
    TelemetryOperationType, 
    TelemetryTimer,
    createTelemetryTimer,
    appendTelemetry,
    generateTurnSummary,
    saveTurnSummary
} from '../storage/chatSessionRepository';

/**
 * Collects telemetry entries during a request for batch saving.
 * Pass this to operations to track their timing.
 */
export class TelemetryCollector {
    private entries: TelemetryEntry[] = [];
    private activeTimers: Map<string, TelemetryTimer> = new Map();
    private pairIndex: number;
    private sessionId: string;
    private projectId: string;

    constructor(sessionId: string, projectId: string, pairIndex: number) {
        this.sessionId = sessionId;
        this.projectId = projectId;
        this.pairIndex = pairIndex;
    }

    /** Start timing an operation, returns timer ID */
    startTimer(type: TelemetryOperationType, operation: string): string {
        const timer = createTelemetryTimer(type, operation, this.pairIndex);
        const timerId = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.activeTimers.set(timerId, timer);
        return timerId;
    }

    /** Get an active timer by ID */
    getTimer(timerId: string): TelemetryTimer | undefined {
        return this.activeTimers.get(timerId);
    }

    /** End a timer and record the entry */
    endTimer(timerId: string, success: boolean, errorMessage?: string): TelemetryEntry | undefined {
        const timer = this.activeTimers.get(timerId);
        if (!timer) return undefined;
        
        const entry = timer.end(success, errorMessage);
        this.entries.push(entry);
        this.activeTimers.delete(timerId);
        return entry;
    }

    /** Manually add an entry (for operations that manage their own timing) */
    addEntry(entry: TelemetryEntry): void {
        this.entries.push(entry);
    }

    /** Get all collected entries */
    getEntries(): TelemetryEntry[] {
        return [...this.entries];
    }

    /** Get slow operations (for debugging/logging) */
    getSlowOperations(): TelemetryEntry[] {
        return this.entries.filter(e => e.flags?.slow);
    }

    /** Save all collected entries to Couchbase */
    async save(): Promise<void> {
        if (this.entries.length === 0) return;
        
        await appendTelemetry(this.sessionId, this.projectId, this.entries);
        
        // Generate and save turn summary
        const summary = generateTurnSummary(this.entries, this.pairIndex);
        await saveTurnSummary(this.sessionId, this.projectId, summary);
    }

    /** Get a summary of collected telemetry */
    getSummary(): { operationCount: number; totalMs: number; slowCount: number; bottleneck?: string } {
        let totalMs = 0;
        let slowCount = 0;
        let bottleneck: { operation: string; durationMs: number } | undefined;

        for (const entry of this.entries) {
            totalMs += entry.durationMs;
            if (entry.flags?.slow) slowCount++;
            if (!bottleneck || entry.durationMs > bottleneck.durationMs) {
                bottleneck = { operation: entry.operation, durationMs: entry.durationMs };
            }
        }

        return {
            operationCount: this.entries.length,
            totalMs,
            slowCount,
            bottleneck: bottleneck ? `${bottleneck.operation} (${bottleneck.durationMs}ms)` : undefined
        };
    }
}

/**
 * Create a telemetry collector for a request.
 * Returns null if telemetry is disabled or sessionId is missing.
 */
export function createTelemetryCollector(
    sessionId: string | undefined,
    projectId: string | undefined,
    pairIndex: number
): TelemetryCollector | null {
    if (!sessionId || !projectId) return null;
    return new TelemetryCollector(sessionId, projectId, pairIndex);
}
