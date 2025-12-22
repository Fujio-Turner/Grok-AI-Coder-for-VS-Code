import { v4 as uuidv4 } from 'uuid';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getCouchbaseClient } from './couchbaseClient';
import { GrokUsage } from '../api/grokClient';

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
        nextSteps?: string[];
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
        parentSessionId
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
