import { v4 as uuidv4 } from 'uuid';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getCouchbaseClient } from './couchbaseClient';
import { GrokUsage } from '../api/grokClient';
import { NextStepItem } from '../prompts/responseSchema';

const MAX_PAYLOAD_SIZE_MB = 15; // Conservative limit (Couchbase max is 20MB)

function getMaxPayloadSize(): number {
    const config = vscode.workspace.getConfiguration('grok');
    return (config.get<number>('maxPayloadSizeMB', MAX_PAYLOAD_SIZE_MB)) * 1024 * 1024;
}

function getDocumentSize(doc: any): number {
    return new TextEncoder().encode(JSON.stringify(doc)).length;
}

function trimOldPairsIfNeeded(doc: ChatSessionDocument): boolean {
    const maxSize = getMaxPayloadSize();
    let currentSize = getDocumentSize(doc);
    let trimmed = false;
    
    while (currentSize > maxSize && doc.pairs.length > 1) {
        doc.pairs.shift();
        currentSize = getDocumentSize(doc);
        trimmed = true;
    }
    
    if (trimmed) {
        console.log('Trimmed old messages to stay under payload limit. New pair count:', doc.pairs.length);
    }
    
    return trimmed;
}

export interface ChatRequest {
    text: string;
    timestamp: string;
    contextFiles?: string[];
    images?: string[]; // Base64 encoded images
    model?: string; // Model used for this request
}

export interface DiffPreviewItem {
    file: string;
    stats: { added: number; removed: number; modified: number };
}

export interface ChatResponse {
    text?: string;
    timestamp?: string;
    status: 'pending' | 'success' | 'error' | 'cancelled';
    errorMessage?: string;
    usage?: GrokUsage;
    diffPreview?: DiffPreviewItem[];
    structured?: {
        summary?: string;
        message?: string;
        sections?: Array<{ heading: string; content: string; codeBlocks?: Array<{ language?: string; code: string; caption?: string }> }>;
        todos?: Array<{ text: string; completed: boolean }>;
        fileChanges?: Array<{ path: string; content: string; language?: string; isDiff?: boolean; lineRange?: { start: number; end: number } }>;
        commands?: Array<{ command: string; description?: string }>;
        codeBlocks?: Array<{ language?: string; code: string; caption?: string }>;
        nextSteps?: NextStepItem[];
    };
}

export interface ChatPair {
    request: ChatRequest;
    response: ChatResponse;
}

export type StepType = 'planning' | 'execute' | 'main' | 'cleanup';

export interface StepTrackerEntry {
    step: StepType;
    timeMs: number;        // Cumulative time in ms for this step type
    tokensIn: number;      // Cumulative prompt tokens for this step type
    tokensOut: number;     // Cumulative completion tokens for this step type
    callCount: number;     // Number of times this step was invoked
}

export interface TodoItem {
    text: string;
    completed: boolean;
}

export interface SerializedChangeSet {
    id: string;
    sessionId: string;
    timestamp: string;
    files: Array<{
        filePath: string;
        fileName: string;
        oldContent: string;
        newContent: string;
        stats: { added: number; removed: number; modified: number };
        isNewFile: boolean;
    }>;
    totalStats: { added: number; removed: number; modified: number };
    cost: number;
    tokensUsed: number;
    durationMs: number;
    applied: boolean;
    description?: string;
}

export interface ChangeHistoryData {
    history: SerializedChangeSet[];
    position: number;
}

export interface ModelUsageEntry {
    model: string;      // e.g., "grok-4", "grok-3-mini"
    text: number;       // Number of text-only calls
    img: number;        // Number of calls with images (vision)
}

export type BugType = 'HTML' | 'CSS' | 'JSON' | 'JS' | 'TypeScript' | 'Markdown' | 'SQL' | 'Other';
export type BugReporter = 'user' | 'script';

export interface BugReport {
    id: string;              // Unique bug ID
    type: BugType;           // Type of bug
    pairIndex: number;       // Position in pairs array
    by: BugReporter;         // Who reported it
    description: string;     // Description of the bug
    timestamp: string;       // When it was reported
    resolved?: boolean;      // Whether bug has been addressed
    // Debug context for AI analysis
    debugContext?: {
        sourceLocation?: string;      // e.g., "ChatViewProvider.ts:1495"
        functionName?: string;        // e.g., "sendMessage"
        rawResponseLength?: number;   // Length of AI response that caused issue
        rawResponsePreview?: string;  // First 500 chars of problematic response
        apiError?: {                  // If API returned error
            status?: number;          // HTTP status code
            statusText?: string;
            errorBody?: string;       // First 1000 chars of error response
        };
        stackTrace?: string;          // Error stack if available
    };
}

// Operation failure tracking for debugging file edit issues
export interface OperationFailure {
    id: string;
    timestamp: string;
    pairIndex: number;
    filePath: string;
    operationType: 'lineOperation' | 'diff' | 'fullReplace' | 'apiError' | 'parseError';
    error: string;
    // Snapshot of file state at time of failure
    fileSnapshot?: {
        hash: string;           // MD5 hash of content at time of operation
        lineCount: number;
        sizeBytes: number;
        capturedAt: string;     // When snapshot was taken
        contentPreview?: string; // First/last 200 chars for context
    };
    // The operation that failed
    failedOperation?: {
        type: string;
        line?: number;
        expectedContent?: string;
        actualContent?: string;
        newContent?: string;
    };
    // All operations in the batch (for context)
    allOperations?: unknown[];
    // Was file modified during processing?
    fileModifiedDuringProcessing?: boolean;
    originalHash?: string;      // Hash when AI started processing
    currentHash?: string;       // Hash when operation was attempted
    // Debug context for AI analysis
    debugContext?: {
        sourceLocation?: string;      // e.g., "ChatViewProvider.ts:1721"
        functionName?: string;        // e.g., "applyFileChanges"
        rawAiResponse?: string;       // First 1000 chars of AI response
        userPrompt?: string;          // First 500 chars of user's request
        apiError?: {
            status?: number;
            statusText?: string;
            errorBody?: string;
        };
        stackTrace?: string;
        // For file corruption debugging
        beforeContent?: string;       // File content before change (first 500 chars)
        afterContent?: string;        // What we tried to write (first 500 chars)
        diffPreview?: string;         // Unified diff preview
    };
}

/**
 * CLI command execution record - tracks both successes and failures
 */
export interface CliExecution {
    id: string;
    timestamp: string;
    pairIndex: number;
    command: string;
    cwd: string;
    success: boolean;
    exitCode?: number;
    durationMs: number;
    // Output (truncated)
    stdout?: string;  // First 1000 chars
    stderr?: string;  // First 1000 chars
    error?: string;   // Error message if failed
    // Execution context
    wasAutoExecuted: boolean;  // True if auto-executed, false if manual
    wasWhitelisted: boolean;   // True if command was in whitelist
    // AI analysis result (if AI was asked to analyze)
    aiAnalysis?: {
        hadErrors: boolean;
        errorSummary?: string;
    };
}

// ============================================================================
// Session Extension Types (for sessions exceeding 15MB storage limit)
// ============================================================================

/**
 * Metadata about a session extension stored in the root document.
 * Tracks when the split happened and final token counts at time of split.
 */
export interface ExtensionMetadata {
    extensionNum: number;       // 1, 2, 3, etc. (root is always 1)
    splitAt: string;            // ISO timestamp when extension was created
    finalTokensIn: number;      // Token count when this extension was split off
    finalTokensOut: number;
    finalCost: number;
    sizeBytes: number;          // Size of this extension document in bytes
    pairCount: number;          // Number of pairs in this extension
}

/**
 * Extension tracking metadata stored only in root document.
 * The root document (key: {UUID}) acts as the index for all extensions.
 */
export interface SessionExtensionInfo {
    currentExtension: number;   // Which extension is currently active (1 = root only)
    extensions: ExtensionMetadata[];  // Metadata for all extensions including root
    totalSizeBytes: number;     // Sum of all extension sizes for quick lookup
}

/**
 * Extension document schema. These are stored with keys like {UUID}:2, {UUID}:3, etc.
 * Extension 1 is always the root document (ChatSessionDocument).
 */
export interface SessionExtensionDocument {
    id: string;                 // Same as key: {UUID}:N
    docType: 'chat-extension';
    parentId: string;           // Root session UUID (without :N suffix)
    extensionNum: number;       // 2, 3, 4, etc.
    createdAt: string;
    updatedAt: string;
    pairs: ChatPair[];          // This extension's portion of the conversation
    tokensIn: number;           // Tokens in this extension only
    tokensOut: number;
    cost: number;               // Cost for this extension only
}

export interface ChatSessionDocument {
    id: string;
    docType: 'chat';
    projectId: string;
    projectName: string;
    createdAt: string;
    updatedAt: string;
    summary?: string;  // AI-generated summary of the chat topic
    cost: number;      // Total cost in USD
    tokensIn: number;  // Total input/prompt tokens
    tokensOut: number; // Total output/completion tokens
    pairs: ChatPair[];
    stepTracker: StepTrackerEntry[];  // Cumulative stats per step type
    todos?: TodoItem[];  // TODOs extracted from AI responses
    handoffText?: string;  // Summary for handoff to new session
    handoffToSessionId?: string;  // ID of the session this was handed off to
    parentSessionId?: string;  // ID of parent session (for handoff sessions)
    changeHistory?: ChangeHistoryData;  // Persisted change tracking history
    modelUsed?: ModelUsageEntry[];  // Aggregate model usage at root level for fast queries
    bugs?: BugReport[];  // Bug reports for malformed responses
    operationFailures?: OperationFailure[];  // Detailed logs of file operation failures
    cliExecutions?: CliExecution[];  // CLI command executions (successes and failures)
    extensionInfo?: SessionExtensionInfo;  // Extension tracking for sessions exceeding storage limit
}

/**
 * Generate a deterministic projectId from the workspace folder path.
 * Uses a hash of the folder path to create a consistent UUID-like ID.
 */
export function getProjectId(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return 'no-workspace';
    }
    
    const folderPath = workspaceFolders[0].uri.fsPath;
    const hash = crypto.createHash('sha256').update(folderPath).digest('hex');
    // Format as UUID-like string for consistency
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Get the project name from the workspace folder.
 */
export function getProjectName(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return 'No Workspace';
    }
    return workspaceFolders[0].name;
}

export async function createSession(parentSessionId?: string): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const id = uuidv4();
    const now = new Date().toISOString();
    const projectId = getProjectId();
    const projectName = getProjectName();
    
    const doc: ChatSessionDocument = {
        id,
        docType: 'chat',
        projectId,
        projectName,
        createdAt: now,
        updatedAt: now,
        cost: 0,
        tokensIn: 0,
        tokensOut: 0,
        pairs: [],
        stepTracker: [],
        parentSessionId,
        modelUsed: []
    };

    const success = await client.insert(id, doc);
    if (!success) {
        throw new Error('Failed to create session in Couchbase');
    }
    
    console.log('Created new session:', id, 'for project:', projectName, parentSessionId ? `(handoff from ${parentSessionId})` : '');
    return doc;
}

export async function getSession(id: string): Promise<ChatSessionDocument | null> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(id);
    if (!result || !result.content) {
        console.log('getSession: No result for', id);
        return null;
    }
    
    // Ensure pairs array exists
    const doc = result.content;
    if (!doc.pairs) {
        doc.pairs = [];
    }
    
    console.log('getSession: Found session', id, 'with', doc.pairs.length, 'pairs');
    return doc;
}

export async function appendPair(
    sessionId: string,
    pair: ChatPair
): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    console.log('appendPair: Getting session', sessionId);
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        console.error('appendPair: Session not found:', sessionId);
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Ensure pairs array exists
    if (!doc.pairs) {
        doc.pairs = [];
    }
    
    doc.pairs.push(pair);
    doc.updatedAt = now;
    
    // Check payload size and trim old messages if needed
    trimOldPairsIfNeeded(doc);
    
    console.log('appendPair: Saving with', doc.pairs.length, 'pairs');
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append pair to session');
    }
    
    console.log('appendPair: Successfully appended pair to session:', sessionId);
    return doc;
}

export async function updateLastPairResponse(
    sessionId: string,
    response: ChatResponse
): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    if (doc.pairs.length > 0) {
        doc.pairs[doc.pairs.length - 1].response = response;
    }
    doc.updatedAt = now;
    
    // Check payload size and trim old messages if needed
    trimOldPairsIfNeeded(doc);
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update pair response');
    }
    
    console.log('Updated last pair response for session:', sessionId);
    return doc;
}

/**
 * Update session summary
 */
export async function updateSessionSummary(sessionId: string, summary: string): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.summary = summary;
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session summary');
    }
    
    console.log('Updated summary for session:', sessionId);
}

/**
 * Update session TODOs
 */
export async function updateSessionTodos(sessionId: string, todos: TodoItem[]): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.todos = todos;
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session todos');
    }
}

/**
 * Update session usage totals (cost, tokensIn, tokensOut)
 */
export async function updateSessionUsage(
    sessionId: string, 
    promptTokens: number, 
    completionTokens: number,
    model: string = 'grok-3-mini'
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Calculate cost based on model
    const pricing: Record<string, { inputPer1M: number; outputPer1M: number }> = {
        'grok-3-mini': { inputPer1M: 0.30, outputPer1M: 0.50 },
        'grok-4': { inputPer1M: 3.00, outputPer1M: 15.00 }
    };
    const rates = pricing[model] || pricing['grok-3-mini'];
    const cost = (promptTokens / 1_000_000) * rates.inputPer1M + 
                 (completionTokens / 1_000_000) * rates.outputPer1M;
    
    doc.tokensIn = (doc.tokensIn || 0) + promptTokens;
    doc.tokensOut = (doc.tokensOut || 0) + completionTokens;
    doc.cost = (doc.cost || 0) + cost;
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session usage');
    }
    
    console.log('Updated usage for session:', sessionId, '- cost:', doc.cost.toFixed(6));
}

/**
 * Update model usage aggregate at root level.
 * @param sessionId - Session to update
 * @param model - Model name (e.g., "grok-4", "grok-3-mini")
 * @param hasImages - Whether the request included images (vision call)
 */
export async function updateSessionModelUsage(
    sessionId: string,
    model: string,
    hasImages: boolean = false
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize modelUsed if not present (for existing sessions)
    if (!doc.modelUsed) {
        doc.modelUsed = [];
    }
    
    // Find existing entry for this model or create new one
    let entry = doc.modelUsed.find(e => e.model === model);
    if (entry) {
        if (hasImages) {
            entry.img += 1;
        } else {
            entry.text += 1;
        }
    } else {
        doc.modelUsed.push({
            model,
            text: hasImages ? 0 : 1,
            img: hasImages ? 1 : 0
        });
    }
    
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session model usage');
    }
    
    console.log('Updated model usage for session:', sessionId, '- model:', model, hasImages ? '(vision)' : '(text)');
}

/**
 * Update step tracker for a specific step type (cumulative stats).
 */
export async function updateStepTracker(
    sessionId: string,
    step: StepType,
    timeMs: number,
    tokensIn: number,
    tokensOut: number
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize stepTracker if not present (for existing sessions)
    if (!doc.stepTracker) {
        doc.stepTracker = [];
    }
    
    // Find existing entry for this step type or create new one
    let entry = doc.stepTracker.find(e => e.step === step);
    if (entry) {
        entry.timeMs += timeMs;
        entry.tokensIn += tokensIn;
        entry.tokensOut += tokensOut;
        entry.callCount += 1;
    } else {
        doc.stepTracker.push({
            step,
            timeMs,
            tokensIn,
            tokensOut,
            callCount: 1
        });
    }
    
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update step tracker');
    }
    
    console.log('Updated step tracker for session:', sessionId, '- step:', step, 'timeMs:', timeMs, 'tokensIn:', tokensIn, 'tokensOut:', tokensOut);
}

/**
 * List chat sessions for the current project, ordered by most recent first.
 * Returns lightweight session info (no pairs) for the history dropdown.
 */
export async function listSessions(limit: number = 20): Promise<ChatSessionDocument[]> {
    const client = getCouchbaseClient();
    const projectId = getProjectId();
    
    const query = `
        SELECT META().id, docType, projectId, projectName, createdAt, updatedAt, summary,
               cost, tokensIn, tokensOut, ARRAY_LENGTH(pairs) as pairCount
        FROM \`grokCoder\`._default._default
        WHERE docType = "chat" AND projectId = $projectId
        ORDER BY updatedAt DESC
        LIMIT $limit
    `;
    
    const results = await client.query<ChatSessionDocument & { pairCount?: number }>(query, { projectId, limit });
    console.log('listSessions: Found', results.length, 'sessions for project:', projectId);
    return results;
}

/**
 * List all chat sessions across all projects (for admin/debugging)
 */
export async function listAllSessions(limit: number = 50): Promise<ChatSessionDocument[]> {
    const client = getCouchbaseClient();
    
    const query = `
        SELECT META().id, docType, projectId, projectName, createdAt, updatedAt, pairs
        FROM \`grokCoder\`._default._default
        WHERE docType = "chat"
        ORDER BY updatedAt DESC
        LIMIT $limit
    `;
    
    const results = await client.query<ChatSessionDocument>(query, { limit });
    return results;
}

/**
 * Update session with handoff information
 */
export async function updateSessionHandoff(
    sessionId: string, 
    handoffText: string, 
    handoffToSessionId: string
): Promise<void> {
    const client = getCouchbaseClient();
    const session = await getSession(sessionId);
    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }
    
    session.handoffText = handoffText;
    session.handoffToSessionId = handoffToSessionId;
    session.updatedAt = new Date().toISOString();
    
    await client.replace(sessionId, session);
}

/**
 * Update session change history (for version control / revert functionality)
 */
export async function updateSessionChangeHistory(
    sessionId: string,
    changeHistory: ChangeHistoryData
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.changeHistory = changeHistory;
    doc.updatedAt = now;
    
    // Check payload size and trim old messages if needed
    trimOldPairsIfNeeded(doc);
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session change history');
    }
    
    console.log('Updated change history for session:', sessionId, '- entries:', changeHistory.history.length);
}

/**
 * Get the change history for a session
 */
export async function getSessionChangeHistory(sessionId: string): Promise<ChangeHistoryData | null> {
    const session = await getSession(sessionId);
    return session?.changeHistory || null;
}

/**
 * Append a bug report to a session
 */
export async function appendSessionBug(
    sessionId: string,
    bug: Omit<BugReport, 'id' | 'timestamp'>
): Promise<BugReport> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize bugs array if not present
    if (!doc.bugs) {
        doc.bugs = [];
    }
    
    const fullBug: BugReport = {
        id: uuidv4(),
        ...bug,
        timestamp: now,
        resolved: false
    };
    
    doc.bugs.push(fullBug);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append bug report');
    }
    
    console.log('Added bug report to session:', sessionId, '- type:', bug.type, 'pairIndex:', bug.pairIndex);
    return fullBug;
}

/**
 * Get all bugs for a session
 */
export async function getSessionBugs(sessionId: string): Promise<BugReport[]> {
    const session = await getSession(sessionId);
    return session?.bugs || [];
}

/**
 * Append an operation failure to a session for debugging
 */
export async function appendOperationFailure(
    sessionId: string,
    failure: Omit<OperationFailure, 'id' | 'timestamp'>
): Promise<OperationFailure> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize operationFailures array if not present
    if (!doc.operationFailures) {
        doc.operationFailures = [];
    }
    
    const fullFailure: OperationFailure = {
        id: uuidv4(),
        ...failure,
        timestamp: now
    };
    
    // Keep only last 50 failures to prevent unbounded growth
    if (doc.operationFailures.length >= 50) {
        doc.operationFailures = doc.operationFailures.slice(-49);
    }
    
    doc.operationFailures.push(fullFailure);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append operation failure');
    }
    
    console.log('Logged operation failure to session:', sessionId, '- file:', failure.filePath, 'error:', failure.error);
    return fullFailure;
}

/**
 * Get all operation failures for a session
 */
export async function getOperationFailures(sessionId: string): Promise<OperationFailure[]> {
    const session = await getSession(sessionId);
    return session?.operationFailures || [];
}

/**
 * Append a CLI execution record to a session
 */
export async function appendCliExecution(
    sessionId: string,
    execution: Omit<CliExecution, 'id' | 'timestamp'>
): Promise<CliExecution> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize cliExecutions array if not present
    if (!doc.cliExecutions) {
        doc.cliExecutions = [];
    }
    
    const fullExecution: CliExecution = {
        id: uuidv4(),
        ...execution,
        timestamp: now
    };
    
    // Keep only last 100 executions to prevent unbounded growth
    if (doc.cliExecutions.length >= 100) {
        doc.cliExecutions = doc.cliExecutions.slice(-99);
    }
    
    doc.cliExecutions.push(fullExecution);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append CLI execution');
    }
    
    const status = execution.success ? '✓' : '✗';
    console.log(`Logged CLI execution to session: ${sessionId} - ${status} ${execution.command.slice(0, 50)}`);
    return fullExecution;
}

/**
 * Get all CLI executions for a session
 */
export async function getCliExecutions(sessionId: string): Promise<CliExecution[]> {
    const session = await getSession(sessionId);
    return session?.cliExecutions || [];
}

/**
 * Compute MD5 hash of file content for tracking changes
 */
export function computeFileHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

// ============================================================================
// Session Extension Functions
// ============================================================================

const EXTENSION_SPLIT_THRESHOLD = 0.85; // Split at 85% of max to leave room for metadata

/**
 * Get the extension document key for a given session and extension number.
 * Root document (extension 1) uses just the UUID, extensions 2+ use UUID:N format.
 */
export function getExtensionKey(sessionId: string, extensionNum: number): string {
    if (extensionNum === 1) {
        return sessionId;
    }
    return `${sessionId}:${extensionNum}`;
}

/**
 * Parse a document key to extract session ID and extension number.
 */
export function parseExtensionKey(key: string): { sessionId: string; extensionNum: number } {
    const parts = key.split(':');
    if (parts.length === 1) {
        return { sessionId: key, extensionNum: 1 };
    }
    // Handle UUID format with colons: last part after final colon is the extension number
    const lastPart = parts[parts.length - 1];
    const extNum = parseInt(lastPart, 10);
    if (!isNaN(extNum) && extNum > 1) {
        return { 
            sessionId: parts.slice(0, -1).join(':'), 
            extensionNum: extNum 
        };
    }
    return { sessionId: key, extensionNum: 1 };
}

/**
 * Check if a session needs to be split into a new extension.
 * Returns true if the current document size exceeds the split threshold.
 */
export function needsExtension(doc: ChatSessionDocument): boolean {
    const maxSize = getMaxPayloadSize();
    const currentSize = getDocumentSize(doc);
    return currentSize > maxSize * EXTENSION_SPLIT_THRESHOLD;
}

/**
 * Create a new extension document for a session that's approaching the size limit.
 * This moves the current pairs to a frozen extension and starts fresh in the root.
 */
export async function createSessionExtension(sessionId: string): Promise<SessionExtensionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const rootDoc = result.content;
    
    // Determine the next extension number
    const currentExtNum = rootDoc.extensionInfo?.currentExtension || 1;
    const newExtNum = currentExtNum + 1;
    const extensionKey = getExtensionKey(sessionId, newExtNum);
    
    // Calculate current root stats before split
    const rootSize = getDocumentSize(rootDoc);
    const rootPairCount = rootDoc.pairs.length;
    
    // Create the extension document with current pairs
    const extensionDoc: SessionExtensionDocument = {
        id: extensionKey,
        docType: 'chat-extension',
        parentId: sessionId,
        extensionNum: newExtNum,
        createdAt: now,
        updatedAt: now,
        pairs: [...rootDoc.pairs],  // Copy all current pairs
        tokensIn: rootDoc.tokensIn,
        tokensOut: rootDoc.tokensOut,
        cost: rootDoc.cost
    };
    
    // Insert the extension document
    const insertSuccess = await client.insert(extensionKey, extensionDoc);
    if (!insertSuccess) {
        throw new Error(`Failed to create extension document: ${extensionKey}`);
    }
    
    const extDocSize = getDocumentSize(extensionDoc);
    
    // Update extension info in root document
    if (!rootDoc.extensionInfo) {
        // First extension - also record root as extension 1
        rootDoc.extensionInfo = {
            currentExtension: 1,
            extensions: [{
                extensionNum: 1,
                splitAt: now,
                finalTokensIn: 0,
                finalTokensOut: 0,
                finalCost: 0,
                sizeBytes: 0,
                pairCount: 0
            }],
            totalSizeBytes: 0
        };
    }
    
    // Freeze the current root state as the previous extension
    const rootExtMeta = rootDoc.extensionInfo.extensions.find(e => e.extensionNum === currentExtNum);
    if (rootExtMeta) {
        rootExtMeta.finalTokensIn = rootDoc.tokensIn;
        rootExtMeta.finalTokensOut = rootDoc.tokensOut;
        rootExtMeta.finalCost = rootDoc.cost;
        rootExtMeta.sizeBytes = rootSize;
        rootExtMeta.pairCount = rootPairCount;
        rootExtMeta.splitAt = now;
    }
    
    // Add metadata for new extension
    rootDoc.extensionInfo.extensions.push({
        extensionNum: newExtNum,
        splitAt: now,
        finalTokensIn: extensionDoc.tokensIn,
        finalTokensOut: extensionDoc.tokensOut,
        finalCost: extensionDoc.cost,
        sizeBytes: extDocSize,
        pairCount: extensionDoc.pairs.length
    });
    
    // Update root to point to new extension
    rootDoc.extensionInfo.currentExtension = newExtNum;
    rootDoc.extensionInfo.totalSizeBytes = rootDoc.extensionInfo.extensions.reduce(
        (sum, ext) => sum + ext.sizeBytes, 0
    );
    
    // Clear pairs from root - new messages will go to the extension
    rootDoc.pairs = [];
    rootDoc.updatedAt = now;
    
    // Save updated root document
    const replaceSuccess = await client.replace(sessionId, rootDoc);
    if (!replaceSuccess) {
        // Try to clean up the extension doc we created
        await client.remove(extensionKey);
        throw new Error('Failed to update root document after creating extension');
    }
    
    console.log(`Created session extension ${newExtNum} for session ${sessionId}. Moved ${rootPairCount} pairs.`);
    return extensionDoc;
}

/**
 * Get the active extension document for a session.
 * Returns the root document if no extensions exist, otherwise returns the latest extension.
 */
export async function getActiveExtension(sessionId: string): Promise<{
    doc: ChatSessionDocument | SessionExtensionDocument;
    isRoot: boolean;
    extensionNum: number;
}> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const rootDoc = result.content;
    
    // If no extensions, root is active
    if (!rootDoc.extensionInfo || rootDoc.extensionInfo.currentExtension === 1) {
        return { doc: rootDoc, isRoot: true, extensionNum: 1 };
    }
    
    // Get the current extension document
    const extNum = rootDoc.extensionInfo.currentExtension;
    const extKey = getExtensionKey(sessionId, extNum);
    const extResult = await client.get<SessionExtensionDocument>(extKey);
    
    if (!extResult || !extResult.content) {
        console.error(`Extension ${extNum} not found for session ${sessionId}, falling back to root`);
        return { doc: rootDoc, isRoot: true, extensionNum: 1 };
    }
    
    return { doc: extResult.content, isRoot: false, extensionNum: extNum };
}

/**
 * Get all pairs from a session, traversing all extensions in order.
 * This assembles the complete conversation history across all extensions.
 */
export async function getAllSessionPairs(sessionId: string): Promise<ChatPair[]> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return [];
    }
    
    const rootDoc = result.content;
    
    // If no extensions, just return root pairs
    if (!rootDoc.extensionInfo || rootDoc.extensionInfo.extensions.length <= 1) {
        return rootDoc.pairs;
    }
    
    const allPairs: ChatPair[] = [];
    
    // Collect pairs from all extensions in order (skip extension 1 which is root)
    for (const extMeta of rootDoc.extensionInfo.extensions) {
        if (extMeta.extensionNum === 1) {
            continue;  // Root's pairs were moved to extensions
        }
        
        const extKey = getExtensionKey(sessionId, extMeta.extensionNum);
        const extResult = await client.get<SessionExtensionDocument>(extKey);
        
        if (extResult?.content) {
            allPairs.push(...extResult.content.pairs);
        }
    }
    
    // Add any pairs still in root (for the currently active extension)
    allPairs.push(...rootDoc.pairs);
    
    return allPairs;
}

/**
 * Get the complete session including all extension pairs merged.
 * This is used for loading a session with full history.
 */
export async function getSessionWithExtensions(id: string): Promise<ChatSessionDocument | null> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(id);
    if (!result || !result.content) {
        console.log('getSessionWithExtensions: No result for', id);
        return null;
    }
    
    const doc = result.content;
    
    // Ensure pairs array exists
    if (!doc.pairs) {
        doc.pairs = [];
    }
    
    // If there are extensions, merge all pairs
    if (doc.extensionInfo && doc.extensionInfo.extensions.length > 1) {
        const allPairs = await getAllSessionPairs(id);
        doc.pairs = allPairs;
        console.log('getSessionWithExtensions: Merged', allPairs.length, 'pairs from', 
            doc.extensionInfo.extensions.length, 'extensions');
    }
    
    console.log('getSessionWithExtensions: Found session', id, 'with', doc.pairs.length, 'pairs');
    return doc;
}

/**
 * Get total storage size across all extensions for a session.
 */
export async function getSessionTotalStorage(sessionId: string): Promise<number> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return 0;
    }
    
    const doc = result.content;
    
    // If extensions exist, use cached total
    if (doc.extensionInfo) {
        // Recalculate to include current root size
        const rootSize = getDocumentSize(doc);
        const extensionSizes = doc.extensionInfo.extensions
            .filter(e => e.extensionNum !== doc.extensionInfo!.currentExtension)
            .reduce((sum, e) => sum + e.sizeBytes, 0);
        return rootSize + extensionSizes;
    }
    
    // No extensions, just return root document size
    return getDocumentSize(doc);
}

/**
 * Append a pair to a session, respecting existing extensions.
 * This is the extension-aware version of appendPair.
 * Note: Extensions are only created when user explicitly clicks "Extend" - 
 * this function does NOT auto-create extensions.
 */
export async function appendPairWithExtension(
    sessionId: string,
    pair: ChatPair
): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    // Get root document
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const rootDoc = result.content;
    
    // Check if we have an active extension
    if (rootDoc.extensionInfo && rootDoc.extensionInfo.currentExtension > 1) {
        // Append to the active extension document
        const extNum = rootDoc.extensionInfo.currentExtension;
        const extKey = getExtensionKey(sessionId, extNum);
        const extResult = await client.get<SessionExtensionDocument>(extKey);
        
        if (!extResult || !extResult.content) {
            throw new Error(`Extension ${extNum} not found for session ${sessionId}`);
        }
        
        const extDoc = extResult.content;
        extDoc.pairs.push(pair);
        extDoc.updatedAt = now;
        
        const extSuccess = await client.replace(extKey, extDoc);
        if (!extSuccess) {
            throw new Error('Failed to append pair to extension');
        }
        
        // Update root's updatedAt
        rootDoc.updatedAt = now;
        await client.replace(sessionId, rootDoc);
        
        console.log('Appended pair to extension', extNum, 'for session:', sessionId);
        return rootDoc;
    }
    
    // No extensions, append to root as normal
    if (!rootDoc.pairs) {
        rootDoc.pairs = [];
    }
    rootDoc.pairs.push(pair);
    rootDoc.updatedAt = now;
    
    const success = await client.replace(sessionId, rootDoc);
    if (!success) {
        throw new Error('Failed to append pair to session');
    }
    
    console.log('Appended pair to session:', sessionId);
    return rootDoc;
}

/**
 * Update the last pair response in a session, handling extensions.
 */
export async function updateLastPairResponseWithExtension(
    sessionId: string,
    response: ChatResponse
): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    // Get root document
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const rootDoc = result.content;
    
    // Check if we have an active extension
    if (rootDoc.extensionInfo && rootDoc.extensionInfo.currentExtension > 1) {
        const extNum = rootDoc.extensionInfo.currentExtension;
        const extKey = getExtensionKey(sessionId, extNum);
        const extResult = await client.get<SessionExtensionDocument>(extKey);
        
        if (!extResult || !extResult.content) {
            throw new Error(`Extension ${extNum} not found for session ${sessionId}`);
        }
        
        const extDoc = extResult.content;
        if (extDoc.pairs.length > 0) {
            extDoc.pairs[extDoc.pairs.length - 1].response = response;
            extDoc.updatedAt = now;
            
            const extSuccess = await client.replace(extKey, extDoc);
            if (!extSuccess) {
                throw new Error('Failed to update extension pair response');
            }
        }
        
        rootDoc.updatedAt = now;
        await client.replace(sessionId, rootDoc);
        
        console.log('Updated last pair response in extension', extNum);
        return rootDoc;
    }
    
    // No extensions, update root as normal
    if (rootDoc.pairs.length > 0) {
        rootDoc.pairs[rootDoc.pairs.length - 1].response = response;
    }
    rootDoc.updatedAt = now;
    
    const success = await client.replace(sessionId, rootDoc);
    if (!success) {
        throw new Error('Failed to update pair response');
    }
    
    console.log('Updated last pair response for session:', sessionId);
    return rootDoc;
}

/**
 * Delete a session and all its extensions.
 */
export async function deleteSessionWithExtensions(sessionId: string): Promise<boolean> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return false;
    }
    
    const rootDoc = result.content;
    
    // Delete all extension documents
    if (rootDoc.extensionInfo) {
        for (const ext of rootDoc.extensionInfo.extensions) {
            if (ext.extensionNum > 1) {
                const extKey = getExtensionKey(sessionId, ext.extensionNum);
                await client.remove(extKey);
                console.log('Deleted extension:', extKey);
            }
        }
    }
    
    // Delete root document
    const success = await client.remove(sessionId);
    console.log('Deleted session:', sessionId);
    return success;
}
