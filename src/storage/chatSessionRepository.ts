import { v4 as uuidv4 } from 'uuid';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getCouchbaseClient, SubdocOp, CouchbaseErrorType, classifyCouchbaseError } from './couchbaseClient';
import { GrokUsage } from '../api/grokClient';
import { NextStepItem } from '../prompts/responseSchema';
import { debug, warn, error as logError, info } from '../utils/logger';

const MAX_CAS_RETRIES = 3;
const CAS_RETRY_DELAY_MS = 50;

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
        todos?: Array<{ text: string; aiText?: string; completed: boolean }>;
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
    aiText?: string;  // Verbose AI instructions (hidden from UI)
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

// ============================================================================
// File Revision Tracking - Line-level change history for precise rollback
// ============================================================================

/**
 * Type of change operation at line level
 */
export type LineChangeType = 'insert' | 'delete' | 'replace' | 'unchanged';

/**
 * A single line-level change within a revision
 */
export interface LineChange {
    type: LineChangeType;
    lineNumber: number;           // 1-indexed line number in the file
    oldContent?: string;          // Content before change (for delete/replace)
    newContent?: string;          // Content after change (for insert/replace)
}

/**
 * A range of lines affected by a change (for batch operations)
 */
export interface LineRangeChange {
    type: 'range-insert' | 'range-delete' | 'range-replace';
    startLine: number;            // 1-indexed start line
    endLine: number;              // 1-indexed end line (inclusive)
    oldLines?: string[];          // Lines before change
    newLines?: string[];          // Lines after change
}

/**
 * A file revision capturing state at a specific point in time.
 * Stored as a separate document in Couchbase for efficient querying.
 */
export interface FileRevisionDocument {
    id: string;                   // Document key: file-rev::{pathHash}::{revNum}
    docType: 'file-revision';
    
    // File identification
    filePath: string;             // Relative path from workspace
    absolutePath: string;         // Full filesystem path
    pathHash: string;             // SHA256 hash of path (first 16 chars)
    fileName: string;             // Just the filename
    
    // Revision info
    revisionNumber: number;       // Sequential revision number (1, 2, 3...)
    previousRevisionId?: string;  // Link to previous revision (for chain)
    
    // Content state
    md5Before: string;            // MD5 hash before this revision
    md5After: string;             // MD5 hash after this revision
    lineCountBefore: number;      // Line count before
    lineCountAfter: number;       // Line count after
    sizeBytesBefore: number;      // Size before
    sizeBytesAfter: number;       // Size after
    
    // Change details (line-level tracking)
    changes: LineChange[];        // Individual line changes
    rangeChanges?: LineRangeChange[]; // Batch changes (lineOperations)
    changeStats: {
        linesAdded: number;
        linesDeleted: number;
        linesModified: number;
    };
    
    // What caused this revision
    changeSource: 'ai' | 'user' | 'auto-apply';
    sessionId: string;            // Session that made the change
    pairIndex: number;            // Which conversation turn
    changeSetId?: string;         // Link to ChangeSet if applicable
    
    // Timestamps
    createdAt: string;
    
    // For quick restore - compressed content snapshots
    // Only stored if content is under 100KB to avoid bloat
    contentSnapshotBefore?: string;  // Base64 gzip of content before
    contentSnapshotAfter?: string;   // Base64 gzip of content after
}

/**
 * Summary of all revisions for a file.
 * Stored as a separate document for quick lookup.
 */
export interface FileRevisionIndex {
    id: string;                   // Document key: file-rev-index::{pathHash}
    docType: 'file-revision-index';
    filePath: string;
    absolutePath: string;
    pathHash: string;
    
    // Revision chain
    revisions: Array<{
        revisionNumber: number;
        revisionId: string;       // Document key for full revision
        md5After: string;         // Quick hash lookup
        createdAt: string;
        changeStats: { linesAdded: number; linesDeleted: number; linesModified: number };
        sessionId: string;
        pairIndex: number;
    }>;
    
    // Current state
    currentRevision: number;      // Latest revision number
    originalBackupId?: string;    // Link to FileBackupDocument for original
    
    // Timestamps
    firstSeenAt: string;          // When file was first tracked
    lastModifiedAt: string;       // Last revision timestamp
}

/**
 * Request to store a file before modification.
 * Must be called before any write operation.
 */
export interface StoreFileRequest {
    filePath: string;             // Relative path
    absolutePath: string;         // Full path
    reason: 'read' | 'write' | 'pre-modify';  // Why we're storing
    sessionId: string;
    pairIndex: number;
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
    operationType: 'lineOperation' | 'diff' | 'fullReplace' | 'apiError' | 'parseError' | 'hashMismatch' | 'noHash';
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

/**
 * Response remediation record - tracks auto-corrections applied to AI responses.
 * Used to analyze patterns and eventually remove workarounds when AI improves.
 */
export type RemediationType = 
    | 'malformed-diff-to-linerange'  // isDiff:true but no +/- markers, converted to line replacement
    | 'json-cleanup'                  // Malformed JSON fixed by cleanup pass
    | 'truncation-recovery'           // Recovered partial content from truncated response
    | 'encoding-fix'                  // Fixed character encoding issues
    | 'structure-repair';             // Repaired JSON structure (missing brackets, etc.)

export interface ResponseRemediation {
    id: string;
    timestamp: string;
    pairIndex: number;
    type: RemediationType;
    filePath?: string;                // For file-related remediations
    description: string;              // Human-readable description
    // Before/after for analysis
    before: {
        format: string;               // e.g., "isDiff:true, no markers"
        preview: string;              // First 500 chars of original
        lineRange?: { start: number; end: number };
    };
    after: {
        format: string;               // e.g., "lineRange replacement"
        preview: string;              // First 500 chars of corrected
        method: string;               // How it was fixed
    };
    success: boolean;                 // Did the remediation succeed?
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
    workspacePath?: string;  // Absolute path to workspace root folder
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
    remediations?: ResponseRemediation[];  // Auto-corrections applied to AI responses
    extensionInfo?: SessionExtensionInfo;  // Extension tracking for sessions exceeding storage limit
    /** xAI Files API - uploaded files for this session */
    uploadedFiles?: UploadedFileRecord[];
    /** Track file operations per pair/turn - helps AI know current file state */
    pairFileHistory?: PairFileHistoryEntry[];
    /** Whether audit generation is enabled for this session */
    auditGenerating?: boolean;
    /** File registry - persistent file metadata across conversation turns */
    fileRegistry?: Record<string, FileRegistryEntry>;
    /** Pending directory listing results to inject in next turn */
    pendingDirectoryResults?: PendingDirectoryResults;
    /** Pending bundled files (imports/tests) to attach in next turn */
    pendingBundledFiles?: PendingBundledFiles;
    /** Sub-task registry for parallel/sequential work decomposition */
    subTaskRegistry?: SubTaskRegistryData;
    /** Large file metadata (file awareness system) - files too big to load, awaiting AI request */
    pendingLargeFiles?: LargeFileMetadataEntry[];
    /** Analysis results cache - stores results of grep/head/python commands for AI reference */
    analysisResults?: AnalysisResult[];
}

/**
 * Large file metadata entry stored in session for persistence.
 * Part of the file awareness system where AI sees metadata before requesting full content.
 */
export interface LargeFileMetadataEntry {
    path: string;
    sizeBytes: number;
    lineCount: number;
    language: string;
    md5Hash: string;
    preview: string;
    structureHints?: {
        classes?: string[];
        functions?: string[];
        sections?: string[];
    };
    reason: string;
    detectedAt: string;
    /** Track if AI has requested this file's content */
    contentRequested?: boolean;
    contentRequestMethod?: 'chunk' | 'analyze' | 'extract';
}

// ============================================================================
// Analysis Results Cache - Persistent storage of file analysis results
// ============================================================================

/**
 * Result of an analysis command run on a file.
 * Stored in session so AI can reference previous analysis without re-requesting.
 */
export interface AnalysisResult {
    /** Unique ID for this analysis */
    id: string;
    /** The command that was run (grep, head, python -c, etc.) */
    command: string;
    /** File path that was analyzed */
    filePath: string;
    /** Command output (truncated if too long) */
    output: string;
    /** Number of lines in output */
    outputLines: number;
    /** Whether output was truncated */
    truncated: boolean;
    /** MD5 hash of the file at time of analysis */
    md5Hash: string;
    /** ISO timestamp when analysis was run */
    timestamp: string;
    /** Which conversation pair requested this */
    pairIndex: number;
    /** Exit code of the command */
    exitCode: number;
    /** Duration in ms */
    durationMs: number;
}

// ============================================================================
// Sub-Task Registry - Parallel work decomposition
// ============================================================================

export type SubTaskStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

export interface SubTaskData {
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

export interface SubTaskRegistryData {
    tasks: SubTaskData[];
    parentSessionId: string;
    createdAt: string;
    updatedAt: string;
}

// ============================================================================
// Chat Audit Document - Stores full generation text for debugging
// ============================================================================

/**
 * A single audit entry capturing the full generation for a pair.
 */
export interface AuditPairEntry {
    pairIndex: number;
    timestamp: string;
    userMessage: string;           // User's input (truncated to 2000 chars)
    fullGeneration: string;        // Complete AI generation text (untruncated)
    systemPromptPreview?: string;  // First 1000 chars of system prompt for context
    model?: string;                // Model used
    finishReason?: string;         // Why generation stopped (stop, length, etc.)
    tokensIn?: number;
    tokensOut?: number;
}

/**
 * Audit document stored separately from main session to avoid size limits.
 * Key format: debug:{sessionId}
 */
export interface ChatAuditDocument {
    id: string;                    // Same as key: debug:{sessionId}
    docType: 'chatAudit';
    sessionId: string;             // Reference to parent session
    projectId: string;
    createdAt: string;
    updatedAt: string;
    pairs: AuditPairEntry[];       // Full generation text for each pair
}

/**
 * Record of a file uploaded to xAI Files API for this session.
 * Used for cleanup on session end and to persist file_ids across turns.
 */
export interface UploadedFileRecord {
    fileId: string;         // xAI file ID (e.g., "file-abc123")
    localPath: string;      // Original workspace path
    filename: string;       // Just the filename
    size: number;           // File size in bytes
    uploadedAt: string;     // ISO timestamp
    hash?: string;          // MD5 hash of content at upload time
    expiresAt?: string;     // ISO timestamp when file should be cleaned up (TTL)
}

/**
 * Track file operations per conversation turn (pair).
 * Stored as array where index = pair index.
 * Helps AI know what files it has read/modified and their current state.
 */
export type PairFileOperationType = 'read' | 'update' | 'create' | 'delete';

// ============================================================================
// File Backup Types - Original file storage for 100% recovery
// ============================================================================

/**
 * File backup document stored in Couchbase.
 * Key format: backup:{hash(path)}:{md5(original_content)}
 * This allows us to always recover the original file before any AI modifications.
 */
export interface FileBackupDocument {
    id: string;                     // Same as document key
    docType: 'file-backup';
    filePath: string;               // Full absolute path to the file
    fileName: string;               // Just the filename
    originalMd5: string;            // MD5 hash of the original content
    pathHash: string;               // SHA256 hash of the file path (first 16 chars)
    createdAt: string;              // When backup was created
    createdBySession: string;       // Session ID that triggered the backup
    createdByPair: number;          // Pair index when backup was created
    sizeBytes: number;              // Original file size
    contentBase64: string;          // Base64-encoded gzip-compressed content
    encoding: 'gzip+base64';        // Compression method used
}

/**
 * Reference to a file backup stored in pairFileHistory.
 * This links the backup to a specific file operation.
 */
export interface FileBackupReference {
    backupId: string;               // Document key in Couchbase
    originalMd5: string;            // MD5 of original content
    filePath: string;               // For quick lookup
}

/**
 * Who triggered the file operation:
 * - 'user': User manually attached or applied file
 * - 'auto': Agent workflow auto-loaded file (Pass 2)
 * - 'ai-adhoc': AI requested file mid-conversation
 */
export type PairFileOperationBy = 'user' | 'auto' | 'ai-adhoc';

export interface PairFileOperation {
    file: string;           // File path (relative to workspace)
    md5: string;            // MD5 hash of file content at time of operation
    op: PairFileOperationType;  // Operation type
    dt: number;             // Unix timestamp (milliseconds)
    size?: number;          // File size in bytes (optional)
    by: PairFileOperationBy; // Who triggered this operation
    backup?: FileBackupReference;  // Reference to original file backup (for first update only)
}

/**
 * File operations for a single pair/turn.
 * Each entry in pairFileHistory corresponds to a pair index.
 */
export type PairFileHistoryEntry = PairFileOperation[];

// ============================================================================
// File Registry - Persistent file metadata across conversation turns
// ============================================================================

/**
 * Entry in the file registry tracking file metadata across the conversation.
 * Allows AI to know which files it has "seen" even if not in current context.
 * Tracks MD5 hashes at read time and after modifications for change detection.
 */
export interface FileRegistryEntry {
    path: string;              // Relative path from workspace root
    absolutePath: string;      // Full filesystem path
    md5: string;               // Current/last known hash
    originalMd5?: string;      // MD5 hash when file was FIRST read (before any AI changes)
    originalReadAt?: string;   // ISO timestamp when file was first read
    lastSeenTurn: number;      // Which pairIndex last had this file attached
    lastModifiedTurn?: number; // Which pairIndex last modified this file
    lastModifiedAt?: string;   // ISO timestamp of last modification
    sizeBytes: number;         // File size for context budget decisions
    language: string;          // Detected language (for syntax highlighting)
    loadedBy: PairFileOperationBy;  // How file was loaded (user/auto/ai-adhoc)
    /** Track MD5 changes over time: [{turn, md5, timestamp}] */
    md5History?: Array<{
        turn: number;
        md5: string;
        timestamp: string;
        changedBy: 'ai' | 'user' | 'external';
    }>;
}

// ============================================================================
// Directory Listing - AI can explore workspace directories
// ============================================================================

/**
 * Entry in a directory listing result.
 */
export interface DirectoryListingEntry {
    name: string;           // File or directory name
    isDirectory: boolean;   // True if this is a directory
    sizeBytes?: number;     // File size (only for files)
}

/**
 * Result of a directory listing request.
 */
export interface DirectoryListingResult {
    path: string;           // Requested directory path
    entries: DirectoryListingEntry[];  // Listing entries
    error?: string;         // Error message if listing failed
    filter?: string;        // Glob filter that was applied
    recursive: boolean;     // Whether subdirectories were included
    requestedAt: string;    // ISO timestamp of request
}

/**
 * Pending directory requests waiting to be processed.
 * Stored on session and injected into next turn's context.
 */
export interface PendingDirectoryResults {
    turn: number;           // Which turn requested these listings
    results: DirectoryListingResult[];  // Results to inject
}

// ============================================================================
// Proactive File Bundling - Auto-attach imports/tests
// ============================================================================

/**
 * A file that was bundled due to its relationship to a modified file.
 */
export interface BundledFileEntry {
    path: string;           // Absolute path to the file
    relativePath: string;   // Relative to workspace root
    type: 'import' | 'test' | 'related';  // Why this file was bundled
    sourceFile: string;     // Which modified file triggered this bundle
    sizeBytes?: number;     // File size for context budget
}

/**
 * Pending bundled files waiting to be attached in next turn.
 */
export interface PendingBundledFiles {
    turn: number;           // Which turn's modifications triggered the bundling
    files: BundledFileEntry[];  // Files to auto-attach
    triggeredBy: string[];  // Paths of modified files that triggered bundling
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

/**
 * Get the absolute path to the workspace folder.
 */
export function getWorkspacePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined;
    }
    return workspaceFolders[0].uri.fsPath;
}

/**
 * Create a new chat session.
 * Uses insert which fails if document exists (05_cb_exception_handling.py pattern).
 * On DocumentExists error (extremely rare with UUIDs), fetches existing session with CAS.
 */
export async function createSession(parentSessionId?: string): Promise<ChatSessionDocument> {
    const client = getCouchbaseClient();
    const id = uuidv4();
    const now = new Date().toISOString();
    const projectId = getProjectId();
    const projectName = getProjectName();
    const workspacePath = getWorkspacePath();
    
    const doc: ChatSessionDocument = {
        id,
        docType: 'chat',
        projectId,
        projectName,
        workspacePath,
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

    const result = await client.insert(id, doc);
    
    if (result.success) {
        info('Created new session', { id, projectName, parentSessionId });
        return doc;
    }
    
    // Insert failed - check specific error type (following 05_cb_exception_handling.py)
    if (result.error === 'DocumentExists') {
        // UUID collision - extremely rare, but handle gracefully
        warn('Session already exists (UUID collision), fetching existing with CAS', { id });
        const existing = await client.get<ChatSessionDocument>(id);
        if (existing && existing.content) {
            return existing.content;
        }
    }
    
    // Other error - timeout, connection issue, etc.
    logError('Failed to create session in Couchbase', { id, projectName, error: result.error });
    throw new Error(`Failed to create session in Couchbase: ${result.error}`);
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
 * Update contextFiles for the last pair's request.
 * Called after agent workflow loads files so we persist which files were loaded.
 */
export async function updateLastPairContextFiles(
    sessionId: string,
    contextFiles: string[]
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    if (doc.pairs.length > 0) {
        const lastPair = doc.pairs[doc.pairs.length - 1];
        lastPair.request.contextFiles = contextFiles;
    }
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update pair contextFiles');
    }
    
    console.log('Updated last pair contextFiles for session:', sessionId, 'files:', contextFiles.length);
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
 * Mark a single TODO as completed using subdocument API.
 * Uses upsert at specific array index path for efficiency on large documents.
 * 
 * @param sessionId - The session document ID
 * @param todoIndex - 0-indexed position in the todos array
 */
export async function markTodoCompleted(sessionId: string, todoIndex: number): Promise<boolean> {
    const client = getCouchbaseClient();
    
    const ops: SubdocOp[] = [
        { type: 'upsert', path: `todos[${todoIndex}].completed`, value: true },
        { type: 'upsert', path: 'updatedAt', value: new Date().toISOString() }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    
    if (!result.success) {
        debug('Failed to mark todo completed via subdoc', { sessionId, todoIndex, error: result.error });
        return false;
    }
    
    debug('Marked todo completed', { sessionId, todoIndex });
    return true;
}

/**
 * Update session usage totals (cost, tokensIn, tokensOut).
 * Uses CAS-based retry logic (01b_cb_get_update_w_cas.py pattern) for concurrent safety.
 */
export async function updateSessionUsage(
    sessionId: string, 
    promptTokens: number, 
    completionTokens: number,
    model: string = 'grok-3-mini'
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    // Calculate cost based on model
    const pricing: Record<string, { inputPer1M: number; outputPer1M: number }> = {
        'grok-3-mini': { inputPer1M: 0.30, outputPer1M: 0.50 },
        'grok-4': { inputPer1M: 3.00, outputPer1M: 15.00 }
    };
    const rates = pricing[model] || pricing['grok-3-mini'];
    const cost = (promptTokens / 1_000_000) * rates.inputPer1M + 
                 (completionTokens / 1_000_000) * rates.outputPer1M;

    // CAS-based retry loop (following 01b_cb_get_update_w_cas.py pattern)
    for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
        const result = await client.get<ChatSessionDocument>(sessionId);
        if (!result || !result.content) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        
        const doc = result.content;
        const cas = result.cas;
        
        doc.tokensIn = (doc.tokensIn || 0) + promptTokens;
        doc.tokensOut = (doc.tokensOut || 0) + completionTokens;
        doc.cost = (doc.cost || 0) + cost;
        doc.updatedAt = now;
        
        const replaceResult = await client.replaceWithCas(sessionId, doc, cas!);
        
        if (replaceResult.success) {
            debug('Updated usage for session', { sessionId, cost: doc.cost.toFixed(6) });
            return;
        }
        
        if (replaceResult.error === 'CasMismatch' && attempt < MAX_CAS_RETRIES) {
            warn('CAS mismatch on usage update, retrying', { sessionId, attempt });
            await new Promise(resolve => setTimeout(resolve, CAS_RETRY_DELAY_MS * attempt));
            continue;
        }
        
        logError('Failed to update session usage', { sessionId, error: replaceResult.error, attempt });
        throw new Error('Failed to update session usage');
    }
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
        AND projectId IS NOT MISSING
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
 * Append a bug report to a session.
 * Uses subdocument API (04_cb_sub_doc_ops.py pattern) for atomic array append.
 */
export async function appendSessionBug(
    sessionId: string,
    bug: Omit<BugReport, 'id' | 'timestamp'>
): Promise<BugReport> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const fullBug: BugReport = {
        id: uuidv4(),
        ...bug,
        timestamp: now,
        resolved: false
    };
    
    // Use subdocument API for atomic array append (appends to bottom of array)
    const ops: SubdocOp[] = [
        { type: 'arrayAppend', path: 'bugs', value: fullBug },
        { type: 'upsert', path: 'updatedAt', value: now }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    
    if (!result.success) {
        // Handle PathNotFound - bugs array doesn't exist yet
        if (result.error === 'PathNotFound') {
            debug('bugs array not found, initializing with first bug');
            // Fall back to get/replace to initialize the array
            const getResult = await client.get<ChatSessionDocument>(sessionId);
            if (!getResult || !getResult.content) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const doc = getResult.content;
            doc.bugs = [fullBug];
            doc.updatedAt = now;
            
            const replaceResult = await client.replaceWithCas(sessionId, doc, getResult.cas!);
            if (!replaceResult.success) {
                logError('Failed to initialize bugs array', { sessionId, error: replaceResult.error });
                throw new Error('Failed to append bug report');
            }
        } else {
            logError('Failed to append bug report via subdoc', { sessionId, error: result.error });
            throw new Error('Failed to append bug report');
        }
    }
    
    info('Added bug report to session', { sessionId, type: bug.type, pairIndex: bug.pairIndex });
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
 * Append an operation failure to a session for debugging.
 * Uses subdocument API for atomic array append.
 */
export async function appendOperationFailure(
    sessionId: string,
    failure: Omit<OperationFailure, 'id' | 'timestamp'>
): Promise<OperationFailure> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const fullFailure: OperationFailure = {
        id: uuidv4(),
        ...failure,
        timestamp: now
    };
    
    // Use subdocument API for atomic array append
    const ops: SubdocOp[] = [
        { type: 'arrayAppend', path: 'operationFailures', value: fullFailure },
        { type: 'upsert', path: 'updatedAt', value: now }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    
    if (!result.success) {
        if (result.error === 'PathNotFound') {
            debug('operationFailures array not found, initializing');
            const getResult = await client.get<ChatSessionDocument>(sessionId);
            if (!getResult || !getResult.content) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const doc = getResult.content;
            doc.operationFailures = [fullFailure];
            doc.updatedAt = now;
            
            const replaceResult = await client.replaceWithCas(sessionId, doc, getResult.cas!);
            if (!replaceResult.success) {
                logError('Failed to initialize operationFailures array', { sessionId, error: replaceResult.error });
                throw new Error('Failed to append operation failure');
            }
        } else {
            logError('Failed to append operation failure via subdoc', { sessionId, error: result.error });
            throw new Error('Failed to append operation failure');
        }
    }
    
    debug('Logged operation failure to session', { sessionId, file: failure.filePath, error: failure.error });
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
 * Append a CLI execution record to a session.
 * Uses subdocument API for atomic array append.
 */
export async function appendCliExecution(
    sessionId: string,
    execution: Omit<CliExecution, 'id' | 'timestamp'>
): Promise<CliExecution> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const fullExecution: CliExecution = {
        id: uuidv4(),
        ...execution,
        timestamp: now
    };
    
    // Use subdocument API for atomic array append
    const ops: SubdocOp[] = [
        { type: 'arrayAppend', path: 'cliExecutions', value: fullExecution },
        { type: 'upsert', path: 'updatedAt', value: now }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    
    if (!result.success) {
        if (result.error === 'PathNotFound') {
            debug('cliExecutions array not found, initializing');
            const getResult = await client.get<ChatSessionDocument>(sessionId);
            if (!getResult || !getResult.content) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const doc = getResult.content;
            doc.cliExecutions = [fullExecution];
            doc.updatedAt = now;
            
            const replaceResult = await client.replaceWithCas(sessionId, doc, getResult.cas!);
            if (!replaceResult.success) {
                logError('Failed to initialize cliExecutions array', { sessionId, error: replaceResult.error });
                throw new Error('Failed to append CLI execution');
            }
        } else {
            logError('Failed to append CLI execution via subdoc', { sessionId, error: result.error });
            throw new Error('Failed to append CLI execution');
        }
    }
    
    const status = execution.success ? '✓' : '✗';
    debug(`Logged CLI execution: ${status} ${execution.command.slice(0, 50)}`, { sessionId });
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
 * Append a response remediation record to a session.
 * Uses subdocument API for atomic array append.
 * Tracks auto-corrections for later analysis and potential removal.
 */
export async function appendRemediation(
    sessionId: string,
    remediation: Omit<ResponseRemediation, 'id' | 'timestamp'>
): Promise<ResponseRemediation> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const fullRemediation: ResponseRemediation = {
        id: uuidv4(),
        ...remediation,
        timestamp: now
    };
    
    // Use subdocument API for atomic array append
    const ops: SubdocOp[] = [
        { type: 'arrayAppend', path: 'remediations', value: fullRemediation },
        { type: 'upsert', path: 'updatedAt', value: now }
    ];
    
    const result = await client.mutateIn(sessionId, ops);
    
    if (!result.success) {
        if (result.error === 'PathNotFound') {
            debug('remediations array not found, initializing');
            const getResult = await client.get<ChatSessionDocument>(sessionId);
            if (!getResult || !getResult.content) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const doc = getResult.content;
            doc.remediations = [fullRemediation];
            doc.updatedAt = now;
            
            const replaceResult = await client.replaceWithCas(sessionId, doc, getResult.cas!);
            if (!replaceResult.success) {
                logError('Failed to initialize remediations array', { sessionId, error: replaceResult.error });
                throw new Error('Failed to append remediation');
            }
        } else {
            logError('Failed to append remediation via subdoc', { sessionId, error: result.error });
            throw new Error('Failed to append remediation');
        }
    }
    
    const status = remediation.success ? '✓' : '✗';
    debug(`[Remediation] ${status} ${remediation.type} for ${remediation.filePath || 'response'}`, { description: remediation.description.slice(0, 80) });
    return fullRemediation;
}

/**
 * Get all remediations for a session
 */
export async function getRemediations(sessionId: string): Promise<ResponseRemediation[]> {
    const session = await getSession(sessionId);
    return session?.remediations || [];
}

/**
 * Compute MD5 hash of file content for tracking changes
 */
export function computeFileHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

// ============================================================================
// Pair File History - Track file operations per conversation turn
// ============================================================================

/**
 * Append a file operation to the file history for a specific pair.
 * Creates the history entry if it doesn't exist for that pair.
 * 
 * @param sessionId - The session ID
 * @param pairIndex - The pair index (0-based) this operation belongs to
 * @param operation - The file operation to record
 */
export async function appendPairFileOperation(
    sessionId: string,
    pairIndex: number,
    operation: Omit<PairFileOperation, 'dt'>
): Promise<PairFileOperation> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize pairFileHistory if not present
    if (!doc.pairFileHistory) {
        doc.pairFileHistory = [];
    }
    
    // Ensure array is long enough for this pairIndex
    while (doc.pairFileHistory.length <= pairIndex) {
        doc.pairFileHistory.push([]);
    }
    
    const fullOperation: PairFileOperation = {
        ...operation,
        dt: Date.now()
    };
    
    // Add operation to the specific pair's history
    doc.pairFileHistory[pairIndex].push(fullOperation);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append pair file operation');
    }
    
    console.log(`[FileHistory] ${operation.op} ${operation.file} (pair ${pairIndex}, md5: ${operation.md5.slice(0, 8)}...)`);
    return fullOperation;
}

/**
 * Append multiple file operations to a pair's history in a single atomic operation.
 * This prevents race conditions when tracking multiple files loaded together.
 */
export async function appendPairFileOperationsBatch(
    sessionId: string,
    pairIndex: number,
    operations: Array<Omit<PairFileOperation, 'dt'>>
): Promise<PairFileOperation[]> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    const timestamp = Date.now();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize pairFileHistory if not present
    if (!doc.pairFileHistory) {
        doc.pairFileHistory = [];
    }
    
    // Ensure array is long enough for this pairIndex
    while (doc.pairFileHistory.length <= pairIndex) {
        doc.pairFileHistory.push([]);
    }
    
    // Add all operations with the same timestamp
    const fullOperations: PairFileOperation[] = operations.map(op => ({
        ...op,
        dt: timestamp
    }));
    
    // Append all operations to the specific pair's history
    doc.pairFileHistory[pairIndex].push(...fullOperations);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to append pair file operations batch');
    }
    
    console.log(`[FileHistory] Batch added ${operations.length} file(s) to pair ${pairIndex}`);
    return fullOperations;
}

/**
 * Get the file history for a specific pair.
 */
export async function getPairFileHistory(
    sessionId: string,
    pairIndex: number
): Promise<PairFileOperation[]> {
    const session = await getSession(sessionId);
    if (!session?.pairFileHistory || pairIndex >= session.pairFileHistory.length) {
        return [];
    }
    return session.pairFileHistory[pairIndex];
}

/**
 * Get the complete file history for all pairs in a session.
 * Returns array where index = pair index.
 */
export async function getAllPairFileHistory(
    sessionId: string
): Promise<PairFileHistoryEntry[]> {
    const session = await getSession(sessionId);
    return session?.pairFileHistory || [];
}

/**
 * Get the latest state of a file across all pairs.
 * Finds the most recent operation for a given file path.
 * Useful for determining current MD5 hash of a file.
 */
export async function getFileLatestState(
    sessionId: string,
    filePath: string
): Promise<PairFileOperation | null> {
    const history = await getAllPairFileHistory(sessionId);
    
    // Search from most recent pair backwards
    for (let i = history.length - 1; i >= 0; i--) {
        const pairOps = history[i];
        // Search from most recent operation in pair backwards
        for (let j = pairOps.length - 1; j >= 0; j--) {
            if (pairOps[j].file === filePath) {
                return pairOps[j];
            }
        }
    }
    return null;
}

/**
 * Build a summary of file operations for inclusion in AI context.
 * Returns a compact representation of recent file operations.
 */
export function buildFileHistorySummary(
    pairFileHistory: PairFileHistoryEntry[] | undefined,
    maxPairs: number = 5
): string {
    if (!pairFileHistory || pairFileHistory.length === 0) {
        return '';
    }
    
    // Get the most recent pairs
    const startIdx = Math.max(0, pairFileHistory.length - maxPairs);
    const recentHistory = pairFileHistory.slice(startIdx);
    
    const lines: string[] = [];
    lines.push('\n## FILE OPERATION HISTORY (Recent)');
    lines.push('These are files you have read or modified. Re-read files before modifying to get current MD5.\n');
    
    for (let i = 0; i < recentHistory.length; i++) {
        const pairIdx = startIdx + i;
        const ops = recentHistory[i];
        if (ops.length === 0) continue;
        
        lines.push(`Turn ${pairIdx}:`);
        for (const op of ops) {
            const opSymbol = op.op === 'read' ? '📖' : op.op === 'update' ? '✏️' : op.op === 'create' ? '📄' : '🗑️';
            const byLabel = op.by ? ` [by: ${op.by}]` : '';
            lines.push(`  ${opSymbol} ${op.op}: ${op.file} (md5: ${op.md5.slice(0, 12)}...)${byLabel}`);
        }
    }
    
    return lines.join('\n');
}

// ============================================================================
// File Registry - Persistent file metadata across conversation
// ============================================================================

/**
 * Update the file registry with new file entries.
 * Merges entries - existing files are updated, new files are added.
 * 
 * @param sessionId - The session ID
 * @param entries - Array of file registry entries to add/update
 * @param currentTurn - The current pair index (for lastSeenTurn)
 */
export async function updateFileRegistry(
    sessionId: string,
    entries: Array<{
        path: string;
        absolutePath: string;
        md5: string;
        sizeBytes: number;
        language: string;
        loadedBy: PairFileOperationBy;
    }>,
    currentTurn: number
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    if (!doc.fileRegistry) {
        doc.fileRegistry = {};
    }
    
    for (const entry of entries) {
        const existing = doc.fileRegistry[entry.path];
        
        // If this is the FIRST time we're seeing this file, record original MD5
        const isFirstRead = !existing;
        const originalMd5 = isFirstRead ? entry.md5 : (existing?.originalMd5 || existing?.md5);
        const originalReadAt = isFirstRead ? now : existing?.originalReadAt;
        
        doc.fileRegistry[entry.path] = {
            path: entry.path,
            absolutePath: entry.absolutePath,
            md5: entry.md5,
            originalMd5,              // Preserve original hash from first read
            originalReadAt,           // When file was first read
            lastSeenTurn: currentTurn,
            lastModifiedTurn: existing?.lastModifiedTurn,
            lastModifiedAt: existing?.lastModifiedAt,
            sizeBytes: entry.sizeBytes,
            language: entry.language,
            loadedBy: entry.loadedBy,
            md5History: existing?.md5History  // Preserve hash history
        };
    }
    
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update file registry');
    }
    
    debug(`[FileRegistry] Updated ${entries.length} entries for session ${sessionId}`);
}

/**
 * Mark a file as modified in the registry.
 * Updates the lastModifiedTurn and MD5 hash.
 * 
 * @param sessionId - The session ID
 * @param path - Relative path of the file
 * @param newMd5 - New MD5 hash after modification
 * @param modifiedTurn - The pair index where modification occurred
 */
export async function markFileModified(
    sessionId: string,
    path: string,
    newMd5: string,
    modifiedTurn: number
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    if (!doc.fileRegistry) {
        doc.fileRegistry = {};
    }
    
    const existing = doc.fileRegistry[path];
    if (existing) {
        const oldMd5 = existing.md5;
        
        // Update current MD5 and modification tracking
        existing.md5 = newMd5;
        existing.lastModifiedTurn = modifiedTurn;
        existing.lastModifiedAt = now;
        existing.lastSeenTurn = modifiedTurn;
        
        // Add to MD5 history if hash actually changed
        if (oldMd5 !== newMd5) {
            if (!existing.md5History) {
                existing.md5History = [];
            }
            existing.md5History.push({
                turn: modifiedTurn,
                md5: newMd5,
                timestamp: now,
                changedBy: 'ai'  // Assume AI made the change (can be overridden)
            });
            // Keep history limited to last 10 changes
            if (existing.md5History.length > 10) {
                existing.md5History.shift();
            }
            debug(`[FileRegistry] MD5 changed: ${oldMd5.slice(0, 8)}... -> ${newMd5.slice(0, 8)}...`);
        }
    } else {
        warn(`[FileRegistry] markFileModified called for unknown file: ${path}`);
    }
    
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to mark file as modified');
    }
    
    debug(`[FileRegistry] Marked ${path} as modified at turn ${modifiedTurn}`);
}

/**
 * Get the file registry for a session.
 */
export async function getFileRegistry(
    sessionId: string
): Promise<Record<string, FileRegistryEntry>> {
    const session = await getSession(sessionId);
    return session?.fileRegistry || {};
}

/**
 * Get a specific file from the registry.
 */
export async function getFileFromRegistry(
    sessionId: string,
    path: string
): Promise<FileRegistryEntry | null> {
    const registry = await getFileRegistry(sessionId);
    return registry[path] || null;
}

/**
 * Build a summary of the file registry for inclusion in AI context.
 * Shows files the AI has "seen" across the conversation.
 * 
 * @param fileRegistry - The file registry from the session
 * @param currentTurn - Current pair index to calculate staleness
 * @param maxFiles - Maximum number of files to show (default 15)
 */
export function buildFileRegistrySummary(
    fileRegistry: Record<string, FileRegistryEntry> | undefined,
    currentTurn: number,
    maxFiles: number = 15
): string {
    if (!fileRegistry || Object.keys(fileRegistry).length === 0) {
        return '';
    }
    
    const entries = Object.values(fileRegistry);
    
    // Sort by lastSeenTurn descending (most recent first)
    entries.sort((a, b) => b.lastSeenTurn - a.lastSeenTurn);
    
    // Limit to maxFiles
    const displayEntries = entries.slice(0, maxFiles);
    
    const lines: string[] = [];
    lines.push('\n## 📂 KNOWN FILES (Session Registry)');
    lines.push('Files you have seen in this conversation. Tracks original MD5 from first read + changes.\n');
    lines.push('| File | First Read | Original MD5 | Current MD5 | Changes |');
    lines.push('|------|------------|--------------|-------------|---------|');
    
    for (const entry of displayEntries) {
        const turnsAgo = currentTurn - entry.lastSeenTurn;
        const lastSeenLabel = turnsAgo === 0 ? 'This turn' : `${turnsAgo} turn(s) ago`;
        
        // Show original MD5 from first read
        const originalHash = entry.originalMd5 ? entry.originalMd5.slice(0, 8) : entry.md5.slice(0, 8);
        const currentHash = entry.md5.slice(0, 8);
        
        // Determine change status
        let changeStatus = '—';
        const hasChanged = entry.originalMd5 && entry.originalMd5 !== entry.md5;
        if (hasChanged) {
            const changeCount = entry.md5History?.length || 1;
            changeStatus = `✏️ ${changeCount} change(s)`;
            if (entry.lastModifiedTurn !== undefined) {
                changeStatus += ` (turn ${entry.lastModifiedTurn})`;
            }
        }
        
        lines.push(`| ${entry.path} | ${lastSeenLabel} | ${originalHash}... | ${currentHash}... | ${changeStatus} |`);
    }
    
    // Show detailed change history for recently modified files
    const modifiedFiles = displayEntries.filter(e => e.md5History && e.md5History.length > 0);
    if (modifiedFiles.length > 0) {
        lines.push('\n### 📝 CHANGE HISTORY (your modifications)');
        for (const entry of modifiedFiles.slice(0, 5)) {
            lines.push(`\n**${entry.path}**`);
            lines.push(`- Original: ${entry.originalMd5?.slice(0, 12) || 'N/A'}... (read at ${entry.originalReadAt || 'unknown'})`);
            for (const change of entry.md5History || []) {
                lines.push(`- Turn ${change.turn}: → ${change.md5.slice(0, 12)}... (${change.changedBy}, ${change.timestamp})`);
            }
        }
    }
    
    if (entries.length > maxFiles) {
        lines.push(`\n*...and ${entries.length - maxFiles} more files in registry*`);
    }
    
    lines.push('\n**Use Original MD5 to verify file unchanged. If Current != Original, you modified it.**');
    
    return lines.join('\n');
}

// ============================================================================
// Directory Listing - AI can explore workspace directories
// ============================================================================

/**
 * Store pending directory listing results for injection into next turn.
 * These are processed after AI response and injected into the next API call.
 */
export async function storePendingDirectoryResults(
    sessionId: string,
    turn: number,
    results: DirectoryListingResult[]
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.pendingDirectoryResults = { turn, results };
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to store pending directory results');
    }
    
    debug('Stored pending directory results', { sessionId, turn, count: results.length });
}

/**
 * Clear pending directory results after they've been injected.
 */
export async function clearPendingDirectoryResults(sessionId: string): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return; // Session not found, nothing to clear
    }
    
    const doc = result.content;
    if (doc.pendingDirectoryResults) {
        delete doc.pendingDirectoryResults;
        doc.updatedAt = now;
        await client.replace(sessionId, doc);
        debug('Cleared pending directory results', { sessionId });
    }
}

/**
 * Build a summary of directory listing results for injection into AI context.
 * Called when building messages for the next turn.
 */
export function buildDirectoryListingSummary(
    results: DirectoryListingResult[]
): string {
    if (!results || results.length === 0) {
        return '';
    }
    
    const lines: string[] = [];
    lines.push('\n## 📁 DIRECTORY LISTING RESULTS');
    lines.push('You requested these directory listings. Use exact paths to request specific files.\n');
    
    for (const result of results) {
        if (result.error) {
            lines.push(`### ⚠️ ${result.path}`);
            lines.push(`Error: ${result.error}\n`);
            continue;
        }
        
        const filterNote = result.filter ? ` (filter: ${result.filter})` : '';
        const recursiveNote = result.recursive ? ' [recursive]' : '';
        lines.push(`### 📂 ${result.path}${filterNote}${recursiveNote}`);
        
        if (result.entries.length === 0) {
            lines.push('*(empty directory)*\n');
            continue;
        }
        
        // Separate dirs and files
        const dirs = result.entries.filter(e => e.isDirectory);
        const files = result.entries.filter(e => !e.isDirectory);
        
        lines.push('| Name | Type | Size |');
        lines.push('|------|------|------|');
        
        // Show directories first
        for (const entry of dirs) {
            lines.push(`| ${entry.name}/ | 📁 dir | - |`);
        }
        
        // Then files
        for (const entry of files) {
            const size = entry.sizeBytes !== undefined 
                ? formatFileSize(entry.sizeBytes) 
                : '-';
            lines.push(`| ${entry.name} | 📄 file | ${size} |`);
        }
        
        lines.push(`\n*${dirs.length} directories, ${files.length} files*\n`);
    }
    
    lines.push('**To load a file, use:** `{\"nextSteps\": [{\"html\": \"Attach file.ts\", \"inputText\": \"path/to/file.ts\"}]}`');
    
    return lines.join('\n');
}

/**
 * Format file size in human-readable format.
 */
function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Proactive File Bundling - Auto-attach imports/tests
// ============================================================================

/**
 * Store pending bundled files for injection into next turn.
 * Called after user applies file changes.
 */
export async function storePendingBundledFiles(
    sessionId: string,
    turn: number,
    files: BundledFileEntry[],
    triggeredBy: string[]
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.pendingBundledFiles = { turn, files, triggeredBy };
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to store pending bundled files');
    }
    
    debug('Stored pending bundled files', { sessionId, turn, count: files.length });
}

/**
 * Clear pending bundled files after they've been injected.
 */
export async function clearPendingBundledFiles(sessionId: string): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return; // Session not found, nothing to clear
    }
    
    const doc = result.content;
    if (doc.pendingBundledFiles) {
        delete doc.pendingBundledFiles;
        doc.updatedAt = now;
        await client.replace(sessionId, doc);
        debug('Cleared pending bundled files', { sessionId });
    }
}

/**
 * Build a summary of bundled files for injection into AI context.
 */
export function buildBundledFilesSummary(bundledFiles: PendingBundledFiles): string {
    if (!bundledFiles || bundledFiles.files.length === 0) {
        return '';
    }

    const lines: string[] = [];
    lines.push('\n## 📦 AUTO-BUNDLED FILES');
    lines.push('These files were automatically attached because they are related to files you modified.\n');

    const imports = bundledFiles.files.filter(f => f.type === 'import');
    const tests = bundledFiles.files.filter(f => f.type === 'test');
    const related = bundledFiles.files.filter(f => f.type === 'related');

    if (imports.length > 0) {
        lines.push('### Imported Files');
        for (const f of imports) {
            const size = f.sizeBytes ? ` (${formatFileSize(f.sizeBytes)})` : '';
            lines.push(`- 📄 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    if (tests.length > 0) {
        lines.push('### Test Files');
        for (const f of tests) {
            const size = f.sizeBytes ? ` (${formatFileSize(f.sizeBytes)})` : '';
            lines.push(`- 🧪 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    if (related.length > 0) {
        lines.push('### Related Files');
        for (const f of related) {
            const size = f.sizeBytes ? ` (${formatFileSize(f.sizeBytes)})` : '';
            lines.push(`- 📎 ${f.relativePath}${size}`);
        }
        lines.push('');
    }

    lines.push(`*Triggered by modifications to: ${bundledFiles.triggeredBy.join(', ')}*`);
    lines.push('\n**These file contents are attached below. Review before making changes.**');

    return lines.join('\n');
}

// ============================================================================
// Sub-Task Registry Functions
// ============================================================================

/**
 * Store or update sub-task registry for a session
 */
export async function storeSubTaskRegistry(
    sessionId: string,
    registry: SubTaskRegistryData
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        warn('Cannot store sub-task registry: session not found', { sessionId });
        return;
    }

    const doc = result.content;
    doc.subTaskRegistry = {
        ...registry,
        updatedAt: now
    };
    doc.updatedAt = now;

    await client.replace(sessionId, doc);
    debug('Stored sub-task registry', { sessionId, taskCount: registry.tasks.length });
}

/**
 * Get sub-task registry for a session
 */
export async function getSubTaskRegistry(sessionId: string): Promise<SubTaskRegistryData | undefined> {
    const client = getCouchbaseClient();
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return undefined;
    }
    return result.content.subTaskRegistry;
}

/**
 * Update a single sub-task's status
 */
export async function updateSubTaskStatus(
    sessionId: string,
    taskId: string,
    status: SubTaskStatus,
    result?: string,
    error?: string,
    filesChanged?: string[]
): Promise<boolean> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const getResult = await client.get<ChatSessionDocument>(sessionId);
    if (!getResult || !getResult.content) {
        return false;
    }

    const doc = getResult.content;
    if (!doc.subTaskRegistry) {
        return false;
    }

    const task = doc.subTaskRegistry.tasks.find(t => t.id === taskId);
    if (!task) {
        return false;
    }

    task.status = status;
    if (status === 'running') {
        task.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
        task.completedAt = now;
    }
    if (result) {
        task.result = result;
    }
    if (error) {
        task.error = error;
    }
    if (filesChanged) {
        task.filesChanged = filesChanged;
    }

    doc.subTaskRegistry.updatedAt = now;
    doc.updatedAt = now;

    const success = await client.replace(sessionId, doc);
    if (success) {
        debug('Updated sub-task status', { sessionId, taskId, status });
    }
    return success;
}

/**
 * Build a summary of sub-tasks for display in AI context
 */
export function buildSubTasksSummary(registry: SubTaskRegistryData): string {
    if (!registry || registry.tasks.length === 0) {
        return '';
    }

    const statusEmoji: Record<SubTaskStatus, string> = {
        pending: '⏸️',
        ready: '🟡',
        running: '🔄',
        completed: '✅',
        failed: '❌',
        skipped: '⏭️'
    };

    const completed = registry.tasks.filter(t => t.status === 'completed').length;
    const lines: string[] = [];
    
    lines.push(`\n## 📋 SUB-TASKS (${completed}/${registry.tasks.length} complete)\n`);
    lines.push('| Status | ID | Goal | Dependencies |');
    lines.push('|--------|-----|------|--------------|');

    for (const task of registry.tasks) {
        const emoji = statusEmoji[task.status];
        const deps = task.dependencies.length > 0 ? task.dependencies.join(', ') : '-';
        const goal = task.goal.length > 50 ? task.goal.slice(0, 50) + '...' : task.goal;
        lines.push(`| ${emoji} ${task.status} | ${task.id} | ${goal} | ${deps} |`);
    }

    lines.push('');
    
    // Show results for completed tasks
    const completedWithResults = registry.tasks.filter(t => t.status === 'completed' && t.result);
    if (completedWithResults.length > 0) {
        lines.push('### Completed Task Results\n');
        for (const task of completedWithResults) {
            lines.push(`**${task.id}**: ${task.result}`);
            if (task.filesChanged && task.filesChanged.length > 0) {
                lines.push(`  - Files changed: ${task.filesChanged.join(', ')}`);
            }
        }
        lines.push('');
    }

    // Show ready tasks
    const ready = registry.tasks.filter(t => t.status === 'ready');
    if (ready.length > 0) {
        lines.push('### Ready to Execute\n');
        for (const task of ready) {
            lines.push(`- **${task.id}**: ${task.goal}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ============================================================================
// Chat Audit - Debug Generation Tracking
// ============================================================================

/**
 * Get the audit document key for a session.
 */
export function getAuditDocumentKey(sessionId: string): string {
    return `debug:${sessionId}`;
}

/**
 * Create or get the audit document for a session.
 * Creates if it doesn't exist.
 */
export async function getOrCreateAuditDocument(
    sessionId: string,
    projectId: string
): Promise<ChatAuditDocument> {
    const client = getCouchbaseClient();
    const auditKey = getAuditDocumentKey(sessionId);
    const now = new Date().toISOString();
    
    try {
        const result = await client.get<ChatAuditDocument>(auditKey);
        if (result && result.content) {
            return result.content;
        }
    } catch {
        // Document doesn't exist, create it
    }
    
    const auditDoc: ChatAuditDocument = {
        id: auditKey,
        docType: 'chatAudit',
        sessionId,
        projectId,
        createdAt: now,
        updatedAt: now,
        pairs: []
    };
    
    // Try insert first, fall back to replace if document exists
    const result = await client.insert(auditKey, auditDoc);
    if (!result.success) {
        if (result.error === 'DocumentExists') {
            // Document already exists, replace it
            await client.replace(auditKey, auditDoc);
        } else {
            logError('Failed to create audit document', { sessionId, error: result.error });
        }
    }
    debug(`[Audit] Created audit document for session: ${sessionId}`);
    return auditDoc;
}

/**
 * Append a generation audit entry to the audit document.
 */
export async function appendAuditEntry(
    sessionId: string,
    projectId: string,
    entry: Omit<AuditPairEntry, 'timestamp'>
): Promise<void> {
    const client = getCouchbaseClient();
    const auditKey = getAuditDocumentKey(sessionId);
    const now = new Date().toISOString();
    
    // Get or create the audit document
    let auditDoc = await getOrCreateAuditDocument(sessionId, projectId);
    
    // Add the new entry
    const fullEntry: AuditPairEntry = {
        ...entry,
        timestamp: now
    };
    
    auditDoc.pairs.push(fullEntry);
    auditDoc.updatedAt = now;
    
    // Check size - if approaching limit, trim oldest entries
    const docSize = new TextEncoder().encode(JSON.stringify(auditDoc)).length;
    const maxSize = 18 * 1024 * 1024; // 18MB to leave buffer
    
    while (docSize > maxSize && auditDoc.pairs.length > 1) {
        auditDoc.pairs.shift();
        console.log('[Audit] Trimmed oldest entry to stay under size limit');
    }
    
    await client.replace(auditKey, auditDoc);
    console.log(`[Audit] Saved generation for pair ${entry.pairIndex} (${entry.fullGeneration.length} chars)`);
}

/**
 * Get the audit document for a session.
 */
export async function getAuditDocument(sessionId: string): Promise<ChatAuditDocument | null> {
    const client = getCouchbaseClient();
    const auditKey = getAuditDocumentKey(sessionId);
    
    try {
        const result = await client.get<ChatAuditDocument>(auditKey);
        return result?.content || null;
    } catch {
        return null;
    }
}

/**
 * Update the auditGenerating flag on the main session document.
 */
export async function updateSessionAuditFlag(
    sessionId: string,
    auditGenerating: boolean
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    doc.auditGenerating = auditGenerating;
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to update session audit flag');
    }
    
    console.log(`[Audit] Set auditGenerating=${auditGenerating} for session: ${sessionId}`);
}

// ============================================================================
// xAI Files API - Uploaded File Tracking
// ============================================================================

/**
 * Add an uploaded file record to a session.
 * Used to track files uploaded to xAI Files API for cleanup.
 */
export async function addUploadedFile(
    sessionId: string,
    file: Omit<UploadedFileRecord, 'uploadedAt'>
): Promise<UploadedFileRecord> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = result.content;
    
    // Initialize array if not present
    if (!doc.uploadedFiles) {
        doc.uploadedFiles = [];
    }
    
    // Check if file already uploaded (by localPath)
    const existingIdx = doc.uploadedFiles.findIndex(f => f.localPath === file.localPath);
    if (existingIdx >= 0) {
        // Update existing entry (file may have been re-uploaded after changes)
        const updated: UploadedFileRecord = {
            ...file,
            uploadedAt: now
        };
        doc.uploadedFiles[existingIdx] = updated;
        doc.updatedAt = now;
        
        await client.replace(sessionId, doc);
        console.log(`[FilesAPI] Updated uploaded file: ${file.filename} -> ${file.fileId}`);
        return updated;
    }
    
    const record: UploadedFileRecord = {
        ...file,
        uploadedAt: now
    };
    
    // Keep only last 50 files to prevent unbounded growth
    if (doc.uploadedFiles.length >= 50) {
        doc.uploadedFiles = doc.uploadedFiles.slice(-49);
    }
    
    doc.uploadedFiles.push(record);
    doc.updatedAt = now;
    
    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to add uploaded file record');
    }
    
    console.log(`[FilesAPI] Tracked uploaded file: ${file.filename} -> ${file.fileId}`);
    return record;
}

/**
 * Get all uploaded file records for a session.
 */
export async function getUploadedFiles(sessionId: string): Promise<UploadedFileRecord[]> {
    const session = await getSession(sessionId);
    return session?.uploadedFiles || [];
}

/**
 * Get file IDs for files that are still valid for this session.
 * Optionally filter by local paths to get only specific files.
 */
export async function getUploadedFileIds(
    sessionId: string,
    localPaths?: string[]
): Promise<string[]> {
    const files = await getUploadedFiles(sessionId);
    
    if (localPaths && localPaths.length > 0) {
        return files
            .filter(f => localPaths.includes(f.localPath))
            .map(f => f.fileId);
    }
    
    return files.map(f => f.fileId);
}

/**
 * Check if a file is already uploaded (by local path and optionally hash).
 * Returns the file ID if found and hash matches (file unchanged), null otherwise.
 */
export async function findUploadedFile(
    sessionId: string,
    localPath: string,
    currentHash?: string
): Promise<string | null> {
    const files = await getUploadedFiles(sessionId);
    const existing = files.find(f => f.localPath === localPath);
    
    if (!existing) {
        return null;
    }
    
    // If hash provided and doesn't match, file changed - needs re-upload
    if (currentHash && existing.hash && existing.hash !== currentHash) {
        return null;
    }
    
    return existing.fileId;
}

/**
 * Remove an uploaded file record (after deletion from xAI).
 */
export async function removeUploadedFile(
    sessionId: string,
    fileId: string
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return; // Session gone, nothing to do
    }
    
    const doc = result.content;
    
    if (!doc.uploadedFiles) {
        return;
    }
    
    doc.uploadedFiles = doc.uploadedFiles.filter(f => f.fileId !== fileId);
    doc.updatedAt = now;
    
    await client.replace(sessionId, doc);
    console.log(`[FilesAPI] Removed file record: ${fileId}`);
}

/**
 * Clear all uploaded file records for a session.
 * Called after cleanup when session ends.
 */
export async function clearUploadedFiles(sessionId: string): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return;
    }
    
    const doc = result.content;
    doc.uploadedFiles = [];
    doc.updatedAt = now;
    
    await client.replace(sessionId, doc);
    console.log(`[FilesAPI] Cleared all uploaded file records for session: ${sessionId}`);
}

/**
 * Get expired uploaded files (past their TTL).
 * Returns files that should be deleted from xAI.
 */
export async function getExpiredFiles(sessionId: string): Promise<UploadedFileRecord[]> {
    const files = await getUploadedFiles(sessionId);
    const now = new Date();
    
    return files.filter(f => {
        if (!f.expiresAt) return false;
        return new Date(f.expiresAt) <= now;
    });
}

/**
 * Get all expired files across ALL sessions (for global cleanup).
 * Queries Couchbase for sessions with expired files.
 */
export async function getExpiredFilesGlobal(): Promise<Array<{ sessionId: string; files: UploadedFileRecord[] }>> {
    const client = getCouchbaseClient();
    const config = vscode.workspace.getConfiguration('grok');
    const bucket = config.get<string>('couchbaseBucket', 'grokCoder');
    const scope = config.get<string>('couchbaseScope', '_default');
    const collection = config.get<string>('couchbaseCollection', '_default');
    const now = new Date().toISOString();
    
    const query = `
        SELECT META().id as sessionId, uploadedFiles
        FROM \`${bucket}\`.\`${scope}\`.\`${collection}\`
        WHERE type = 'chat_session'
          AND uploadedFiles IS NOT MISSING
          AND ARRAY_LENGTH(uploadedFiles) > 0
          AND ANY f IN uploadedFiles SATISFIES f.expiresAt IS NOT MISSING AND f.expiresAt <= $now END
    `;
    
    try {
        const results = await client.query<{ sessionId: string; uploadedFiles: UploadedFileRecord[] }>(
            query, { now }
        );
        
        return results.map(r => ({
            sessionId: r.sessionId,
            files: r.uploadedFiles.filter(f => f.expiresAt && f.expiresAt <= now)
        }));
    } catch (err) {
        console.error('[FilesAPI] Failed to query expired files:', err);
        return [];
    }
}

/**
 * Remove specific expired files from a session's records.
 * Call after deleting from xAI.
 */
export async function removeExpiredFileRecords(
    sessionId: string,
    expiredFileIds: string[]
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return;
    }
    
    const doc = result.content;
    if (!doc.uploadedFiles) return;
    
    const before = doc.uploadedFiles.length;
    doc.uploadedFiles = doc.uploadedFiles.filter(f => !expiredFileIds.includes(f.fileId));
    doc.updatedAt = now;
    
    await client.replace(sessionId, doc);
    console.log(`[FilesAPI] Removed ${before - doc.uploadedFiles.length} expired file records from session: ${sessionId}`);
}

/**
 * Set TTL (expiration time) for uploaded files in a session.
 * Used to mark files for future cleanup.
 */
export async function setFileTtl(
    sessionId: string,
    fileIds: string[],
    ttlHours: number
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return;
    }
    
    const doc = result.content;
    if (!doc.uploadedFiles) return;
    
    let updated = 0;
    for (const file of doc.uploadedFiles) {
        if (fileIds.includes(file.fileId)) {
            file.expiresAt = expiresAt;
            updated++;
        }
    }
    
    if (updated > 0) {
        doc.updatedAt = now.toISOString();
        await client.replace(sessionId, doc);
        console.log(`[FilesAPI] Set TTL (${ttlHours}h) for ${updated} files in session: ${sessionId}`);
    }
}

/**
 * Check if a file needs rehydration (re-upload).
 * Returns true if file record exists but may be expired on xAI side.
 */
export async function needsRehydration(
    sessionId: string,
    localPath: string
): Promise<{ needed: boolean; record?: UploadedFileRecord }> {
    const files = await getUploadedFiles(sessionId);
    const existing = files.find(f => f.localPath === localPath);
    
    if (!existing) {
        return { needed: true };
    }
    
    // If expired, needs re-upload
    if (existing.expiresAt && new Date(existing.expiresAt) <= new Date()) {
        return { needed: true, record: existing };
    }
    
    return { needed: false, record: existing };
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
    const insertResult = await client.insert(extensionKey, extensionDoc);
    if (!insertResult.success) {
        logError('Failed to create extension document', { extensionKey, error: insertResult.error });
        throw new Error(`Failed to create extension document: ${extensionKey} (${insertResult.error})`);
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

// ============================================================================
// File Backup Functions - Store and retrieve original files
// ============================================================================

import * as zlib from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

/**
 * Generate backup document key from file path and content hash.
 * Format: backup:{pathHash}:{md5}
 */
export function getBackupKey(filePath: string, md5: string): string {
    const pathHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    return `backup:${pathHash}:${md5}`;
}

/**
 * Check if a backup already exists for a file path.
 * Returns the backup document if found, null otherwise.
 */
export async function getExistingBackupForFile(filePath: string): Promise<FileBackupDocument | null> {
    const client = getCouchbaseClient();
    const pathHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    
    // Query for any backup with this path hash
    try {
        const query = `
            SELECT META().id, b.*
            FROM \`grokCoder\`._default._default b
            WHERE b.docType = 'file-backup'
            AND b.pathHash = $pathHash
            ORDER BY b.createdAt ASC
            LIMIT 1
        `;
        const result = await client.query(query, { pathHash });
        if (result && result.length > 0) {
            return result[0] as FileBackupDocument;
        }
    } catch (err) {
        console.error('Failed to query for existing backup:', err);
    }
    return null;
}

/**
 * Create a backup of a file before first modification.
 * Only creates if no backup exists for this file.
 * Returns the backup reference to store in pairFileHistory.
 */
export async function createFileBackup(
    filePath: string,
    content: string,
    sessionId: string,
    pairIndex: number
): Promise<FileBackupReference | null> {
    const client = getCouchbaseClient();
    
    // Compute MD5 of original content
    const originalMd5 = crypto.createHash('md5').update(content).digest('hex');
    const pathHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const backupId = getBackupKey(filePath, originalMd5);
    
    // Check if this exact backup already exists
    try {
        const existing = await client.get<FileBackupDocument>(backupId);
        if (existing && existing.content) {
            console.log('Backup already exists:', backupId);
            return {
                backupId,
                originalMd5,
                filePath
            };
        }
    } catch {
        // Backup doesn't exist, create it
    }
    
    // Compress content
    const contentBuffer = Buffer.from(content, 'utf8');
    const compressed = await gzipAsync(contentBuffer);
    const contentBase64 = compressed.toString('base64');
    
    const fileName = filePath.split('/').pop() || filePath;
    
    const backupDoc: FileBackupDocument = {
        id: backupId,
        docType: 'file-backup',
        filePath,
        fileName,
        originalMd5,
        pathHash,
        createdAt: new Date().toISOString(),
        createdBySession: sessionId,
        createdByPair: pairIndex,
        sizeBytes: content.length,
        contentBase64,
        encoding: 'gzip+base64'
    };
    
    const result = await client.insert(backupId, backupDoc);
    if (result.success) {
        debug('Created file backup', { backupId, originalBytes: content.length, base64Bytes: contentBase64.length });
        return {
            backupId,
            originalMd5,
            filePath
        };
    }
    
    // If document exists, backup already exists - that's fine
    if (result.error === 'DocumentExists') {
        debug('File backup already exists, reusing', { backupId });
        return {
            backupId,
            originalMd5,
            filePath
        };
    }
    
    logError('Failed to create file backup', { backupId, error: result.error });
    return null;
}

/**
 * Retrieve a backup document by its ID.
 */
export async function getFileBackup(backupId: string): Promise<FileBackupDocument | null> {
    const client = getCouchbaseClient();
    try {
        const result = await client.get<FileBackupDocument>(backupId);
        if (result && result.content) {
            return result.content;
        }
    } catch (err) {
        console.error('Failed to get file backup:', backupId, err);
    }
    return null;
}

/**
 * Restore file content from a backup.
 * Returns the original content as a string.
 */
export async function restoreFromBackup(backupId: string): Promise<string | null> {
    const backup = await getFileBackup(backupId);
    if (!backup) {
        return null;
    }
    
    try {
        const compressed = Buffer.from(backup.contentBase64, 'base64');
        const decompressed = await gunzipAsync(compressed);
        return decompressed.toString('utf8');
    } catch (err) {
        console.error('Failed to decompress backup:', backupId, err);
        return null;
    }
}

/**
 * Get the original backup for a file (the first backup ever created).
 * This is the baseline for revision history.
 */
export async function getOriginalBackup(filePath: string): Promise<FileBackupDocument | null> {
    return getExistingBackupForFile(filePath);
}

/**
 * Get all backups for a file, ordered by creation date.
 * Useful for building a revision history.
 */
export async function getAllBackupsForFile(filePath: string): Promise<FileBackupDocument[]> {
    const client = getCouchbaseClient();
    const pathHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    
    try {
        const query = `
            SELECT META().id, b.*
            FROM \`grokCoder\`._default._default b
            WHERE b.docType = 'file-backup'
            AND b.pathHash = $pathHash
            ORDER BY b.createdAt ASC
        `;
        const result = await client.query(query, { pathHash });
        return (result || []) as FileBackupDocument[];
    } catch (err) {
        console.error('Failed to get backups for file:', filePath, err);
        return [];
    }
}

/**
 * Get file backups created by a specific session.
 */
export async function getBackupsForSession(sessionId: string): Promise<FileBackupDocument[]> {
    const client = getCouchbaseClient();
    
    try {
        const query = `
            SELECT META().id, b.*
            FROM \`grokCoder\`._default._default b
            WHERE b.docType = 'file-backup'
            AND b.createdBySession = $sessionId
            ORDER BY b.createdAt ASC
        `;
        const result = await client.query(query, { sessionId });
        return (result || []) as FileBackupDocument[];
    } catch (err) {
        console.error('Failed to get backups for session:', sessionId, err);
        return [];
    }
}

// ============================================================================
// Large File Metadata (File Awareness System)
// ============================================================================

/**
 * Store large file metadata in session for persistence.
 * Called when a file exceeds the size threshold during agent workflow.
 */
export async function storePendingLargeFiles(
    sessionId: string,
    metadata: LargeFileMetadataEntry[]
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }

    const doc = result.content;
    
    // Merge with existing, avoiding duplicates by path
    const existing = doc.pendingLargeFiles || [];
    const existingPaths = new Set(existing.map(f => f.path));
    
    for (const entry of metadata) {
        if (!existingPaths.has(entry.path)) {
            existing.push({
                ...entry,
                detectedAt: entry.detectedAt || now
            });
            existingPaths.add(entry.path);
        }
    }
    
    doc.pendingLargeFiles = existing;
    doc.updatedAt = now;

    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to store pending large files');
    }

    debug('Stored pending large files', { sessionId, count: metadata.length, total: existing.length });
}

/**
 * Mark a large file's content as requested by AI.
 */
export async function markLargeFileRequested(
    sessionId: string,
    filePath: string,
    method: 'chunk' | 'analyze' | 'extract'
): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }

    const doc = result.content;
    
    if (doc.pendingLargeFiles) {
        const entry = doc.pendingLargeFiles.find(f => f.path === filePath);
        if (entry) {
            entry.contentRequested = true;
            entry.contentRequestMethod = method;
        }
    }
    
    doc.updatedAt = now;

    const success = await client.replace(sessionId, doc);
    if (!success) {
        throw new Error('Failed to mark large file requested');
    }

    debug('Marked large file requested', { sessionId, filePath, method });
}

/**
 * Get pending large files that haven't had content requested yet.
 */
export async function getPendingLargeFiles(sessionId: string): Promise<LargeFileMetadataEntry[]> {
    const client = getCouchbaseClient();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return [];
    }

    return (result.content.pendingLargeFiles || []).filter(f => !f.contentRequested);
}

/**
 * Clear pending large files after they've been processed.
 */
export async function clearPendingLargeFiles(sessionId: string): Promise<void> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();

    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return;
    }

    const doc = result.content;
    doc.pendingLargeFiles = [];
    doc.updatedAt = now;

    await client.replace(sessionId, doc);
    debug('Cleared pending large files', { sessionId });
}

/**
 * Build a summary of large files for inclusion in context.
 */
export function buildLargeFilesSummary(entries: LargeFileMetadataEntry[]): string {
    if (entries.length === 0) {
        return '';
    }
    
    let summary = '\n\n---\n**📦 LARGE FILES PENDING (from previous turn):**\n';
    summary += 'These files were detected but not loaded. Use request_content to access.\n\n';
    
    for (const entry of entries) {
        const sizeKB = (entry.sizeBytes / 1024).toFixed(1);
        summary += `- **${entry.path}** (${sizeKB}KB, ${entry.lineCount} lines)\n`;
        if (entry.structureHints?.functions?.length) {
            summary += `  Functions: ${entry.structureHints.functions.slice(0, 5).join(', ')}...\n`;
        }
    }
    
    return summary;
}

// ============================================================================
// Analysis Results Cache - Store and retrieve file analysis results
// ============================================================================

/**
 * Store an analysis result in the session.
 * Results are keyed by command+filePath so duplicate runs update existing.
 */
export async function storeAnalysisResult(
    sessionId: string,
    result: Omit<AnalysisResult, 'id' | 'timestamp'>
): Promise<AnalysisResult> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    
    const fullResult: AnalysisResult = {
        ...result,
        id: uuidv4(),
        timestamp: now
    };
    
    const getResult = await client.get<ChatSessionDocument>(sessionId);
    if (!getResult || !getResult.content) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    
    const doc = getResult.content;
    const existing = doc.analysisResults || [];
    
    // Check if we already have a result for this command+filePath
    const existingIndex = existing.findIndex(r => 
        r.command === result.command && r.filePath === result.filePath
    );
    
    if (existingIndex >= 0) {
        // Update existing result
        existing[existingIndex] = fullResult;
        debug('Updated existing analysis result', { command: result.command, filePath: result.filePath });
    } else {
        // Add new result (keep last 20 to avoid bloat)
        existing.push(fullResult);
        if (existing.length > 20) {
            existing.shift(); // Remove oldest
        }
        debug('Added new analysis result', { command: result.command, filePath: result.filePath });
    }
    
    doc.analysisResults = existing;
    doc.updatedAt = now;
    
    await client.replace(sessionId, doc);
    return fullResult;
}

/**
 * Get all analysis results for a session.
 */
export async function getAnalysisResults(sessionId: string): Promise<AnalysisResult[]> {
    const client = getCouchbaseClient();
    
    const result = await client.get<ChatSessionDocument>(sessionId);
    if (!result || !result.content) {
        return [];
    }
    
    return result.content.analysisResults || [];
}

/**
 * Get analysis results for a specific file.
 */
export async function getFileAnalysisResults(sessionId: string, filePath: string): Promise<AnalysisResult[]> {
    const results = await getAnalysisResults(sessionId);
    return results.filter(r => r.filePath === filePath);
}

/**
 * Build a summary of previous analysis results for AI context.
 * Includes command, truncated output, and MD5 hash.
 */
export function buildAnalysisResultsSummary(results: AnalysisResult[]): string {
    if (results.length === 0) {
        return '';
    }
    
    let summary = '\n\n---\n**📊 PREVIOUS ANALYSIS RESULTS (use this data - don\'t re-request):**\n\n';
    
    for (const result of results) {
        const truncatedOutput = result.output.length > 2000 
            ? result.output.slice(0, 2000) + '\n... (truncated)'
            : result.output;
        
        summary += `### Analysis: \`${result.command}\`\n`;
        summary += `- File: ${result.filePath}\n`;
        summary += `- MD5: ${result.md5Hash}\n`;
        summary += `- Lines: ${result.outputLines}${result.truncated ? ' (truncated)' : ''}\n`;
        summary += `- Ran at: ${result.timestamp}\n`;
        summary += '```\n' + truncatedOutput + '\n```\n\n';
    }
    
    return summary;
}

// ============================================================================
// File Revision Functions - Line-level change tracking
// ============================================================================

/**
 * Generate a path hash for file revision keys
 */
function getRevisionPathHash(filePath: string): string {
    return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
}

/**
 * Get the revision index for a file (or null if not tracked)
 */
export async function getFileRevisionIndex(filePath: string): Promise<FileRevisionIndex | null> {
    const client = getCouchbaseClient();
    const pathHash = getRevisionPathHash(filePath);
    const indexId = `file-rev-index::${pathHash}`;
    
    try {
        const result = await client.get<FileRevisionIndex>(indexId);
        if (result && result.content) {
            return result.content;
        }
    } catch (err) {
        debug('Failed to get revision index:', { filePath, error: String(err) });
    }
    return null;
}

/**
 * Compute line-level diff between two content strings.
 * Returns individual line changes for precise rollback.
 */
export function computeLineDiff(
    oldContent: string,
    newContent: string
): { changes: LineChange[]; stats: { linesAdded: number; linesDeleted: number; linesModified: number } } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const changes: LineChange[] = [];
    let linesAdded = 0;
    let linesDeleted = 0;
    let linesModified = 0;
    
    // Simple diff algorithm - LCS would be better for complex diffs
    // For now, compare line by line with insertions/deletions
    const maxLen = Math.max(oldLines.length, newLines.length);
    let oldIdx = 0;
    let newIdx = 0;
    
    while (oldIdx < oldLines.length || newIdx < newLines.length) {
        if (oldIdx >= oldLines.length) {
            // Remaining lines are inserts
            changes.push({
                type: 'insert',
                lineNumber: newIdx + 1,
                newContent: newLines[newIdx]
            });
            linesAdded++;
            newIdx++;
        } else if (newIdx >= newLines.length) {
            // Remaining lines are deletes
            changes.push({
                type: 'delete',
                lineNumber: oldIdx + 1,
                oldContent: oldLines[oldIdx]
            });
            linesDeleted++;
            oldIdx++;
        } else if (oldLines[oldIdx] === newLines[newIdx]) {
            // Lines match - skip
            oldIdx++;
            newIdx++;
        } else {
            // Lines differ - check if it's a replace or insert/delete
            // Look ahead to see if old line appears later in new content
            const oldLineInNew = newLines.slice(newIdx + 1).indexOf(oldLines[oldIdx]);
            const newLineInOld = oldLines.slice(oldIdx + 1).indexOf(newLines[newIdx]);
            
            if (oldLineInNew === -1 && newLineInOld === -1) {
                // Neither line appears later - it's a replace
                changes.push({
                    type: 'replace',
                    lineNumber: oldIdx + 1,
                    oldContent: oldLines[oldIdx],
                    newContent: newLines[newIdx]
                });
                linesModified++;
                oldIdx++;
                newIdx++;
            } else if (oldLineInNew !== -1 && (newLineInOld === -1 || oldLineInNew <= newLineInOld)) {
                // New line inserted
                changes.push({
                    type: 'insert',
                    lineNumber: newIdx + 1,
                    newContent: newLines[newIdx]
                });
                linesAdded++;
                newIdx++;
            } else {
                // Old line deleted
                changes.push({
                    type: 'delete',
                    lineNumber: oldIdx + 1,
                    oldContent: oldLines[oldIdx]
                });
                linesDeleted++;
                oldIdx++;
            }
        }
    }
    
    return { changes, stats: { linesAdded, linesDeleted, linesModified } };
}

/**
 * Store a file revision before/after a change.
 * This is the core function that captures line-level changes.
 */
export async function storeFileRevision(
    filePath: string,
    absolutePath: string,
    oldContent: string,
    newContent: string,
    options: {
        sessionId: string;
        pairIndex: number;
        changeSource: 'ai' | 'user' | 'auto-apply';
        changeSetId?: string;
    }
): Promise<FileRevisionDocument> {
    const client = getCouchbaseClient();
    const now = new Date().toISOString();
    const pathHash = getRevisionPathHash(absolutePath);
    const fileName = absolutePath.split('/').pop() || absolutePath;
    
    // Get or create revision index
    let revIndex = await getFileRevisionIndex(absolutePath);
    let revisionNumber = 1;
    let previousRevisionId: string | undefined;
    
    if (revIndex) {
        revisionNumber = revIndex.currentRevision + 1;
        if (revIndex.revisions.length > 0) {
            previousRevisionId = revIndex.revisions[revIndex.revisions.length - 1].revisionId;
        }
    }
    
    // Compute line-level diff
    const { changes, stats } = computeLineDiff(oldContent, newContent);
    
    // Create revision document
    const revisionId = `file-rev::${pathHash}::${revisionNumber}`;
    const oldMd5 = computeFileHash(oldContent);
    const newMd5 = computeFileHash(newContent);
    
    const revisionDoc: FileRevisionDocument = {
        id: revisionId,
        docType: 'file-revision',
        filePath,
        absolutePath,
        pathHash,
        fileName,
        revisionNumber,
        previousRevisionId,
        md5Before: oldMd5,
        md5After: newMd5,
        lineCountBefore: oldContent.split('\n').length,
        lineCountAfter: newContent.split('\n').length,
        sizeBytesBefore: Buffer.byteLength(oldContent, 'utf8'),
        sizeBytesAfter: Buffer.byteLength(newContent, 'utf8'),
        changes,
        changeStats: stats,
        changeSource: options.changeSource,
        sessionId: options.sessionId,
        pairIndex: options.pairIndex,
        changeSetId: options.changeSetId,
        createdAt: now
    };
    
    // Store content snapshots if under 100KB
    const SNAPSHOT_THRESHOLD = 100 * 1024;
    if (oldContent.length < SNAPSHOT_THRESHOLD) {
        const compressed = await gzipAsync(Buffer.from(oldContent, 'utf8'));
        revisionDoc.contentSnapshotBefore = compressed.toString('base64');
    }
    if (newContent.length < SNAPSHOT_THRESHOLD) {
        const compressed = await gzipAsync(Buffer.from(newContent, 'utf8'));
        revisionDoc.contentSnapshotAfter = compressed.toString('base64');
    }
    
    // Store revision document
    const insertResult = await client.insert(revisionId, revisionDoc);
    if (!insertResult.success) {
        throw new Error(`Failed to store file revision: ${insertResult.error}`);
    }
    
    // Update or create revision index
    const indexId = `file-rev-index::${pathHash}`;
    if (revIndex) {
        revIndex.revisions.push({
            revisionNumber,
            revisionId,
            md5After: newMd5,
            createdAt: now,
            changeStats: stats,
            sessionId: options.sessionId,
            pairIndex: options.pairIndex
        });
        revIndex.currentRevision = revisionNumber;
        revIndex.lastModifiedAt = now;
        
        await client.replace(indexId, revIndex);
    } else {
        const newIndex: FileRevisionIndex = {
            id: indexId,
            docType: 'file-revision-index',
            filePath,
            absolutePath,
            pathHash,
            revisions: [{
                revisionNumber,
                revisionId,
                md5After: newMd5,
                createdAt: now,
                changeStats: stats,
                sessionId: options.sessionId,
                pairIndex: options.pairIndex
            }],
            currentRevision: revisionNumber,
            firstSeenAt: now,
            lastModifiedAt: now
        };
        
        await client.insert(indexId, newIndex);
    }
    
    info(`Stored file revision ${revisionNumber} for ${fileName}`, { 
        changes: changes.length,
        stats 
    });
    
    return revisionDoc;
}

/**
 * Get a specific file revision by number
 */
export async function getFileRevision(
    filePath: string,
    revisionNumber: number
): Promise<FileRevisionDocument | null> {
    const client = getCouchbaseClient();
    const pathHash = getRevisionPathHash(filePath);
    const revisionId = `file-rev::${pathHash}::${revisionNumber}`;
    
    try {
        const result = await client.get<FileRevisionDocument>(revisionId);
        if (result && result.content) {
            return result.content;
        }
    } catch (err) {
        debug('Failed to get file revision:', { revisionId, error: String(err) });
    }
    return null;
}

/**
 * Get all revisions for a file
 */
export async function getFileRevisions(filePath: string): Promise<FileRevisionDocument[]> {
    const index = await getFileRevisionIndex(filePath);
    if (!index) {
        return [];
    }
    
    const client = getCouchbaseClient();
    const revisions: FileRevisionDocument[] = [];
    
    for (const rev of index.revisions) {
        try {
            const result = await client.get<FileRevisionDocument>(rev.revisionId);
            if (result && result.content) {
                revisions.push(result.content);
            }
        } catch (err) {
            debug('Failed to get revision:', { revisionId: rev.revisionId, error: String(err) });
        }
    }
    
    return revisions;
}

/**
 * Restore file content from a specific revision.
 * Returns the content at that revision (before or after state).
 */
export async function restoreFromRevision(
    filePath: string,
    revisionNumber: number,
    state: 'before' | 'after' = 'before'
): Promise<string | null> {
    const revision = await getFileRevision(filePath, revisionNumber);
    if (!revision) {
        warn('Revision not found:', { filePath, revisionNumber });
        return null;
    }
    
    // Try to use snapshot if available
    const snapshot = state === 'before' 
        ? revision.contentSnapshotBefore 
        : revision.contentSnapshotAfter;
    
    if (snapshot) {
        try {
            const compressed = Buffer.from(snapshot, 'base64');
            const decompressed = await gunzipAsync(compressed);
            return decompressed.toString('utf8');
        } catch (err) {
            warn('Failed to decompress snapshot, will reconstruct:', err);
        }
    }
    
    // No snapshot - need to reconstruct from original + changes
    // This requires having the original backup or iterating through revisions
    // For now, return null if no snapshot
    warn('No snapshot available for revision:', { filePath, revisionNumber, state });
    return null;
}

/**
 * Rollback a file to a specific revision.
 * Writes the file content to disk.
 */
export async function rollbackFileToRevision(
    filePath: string,
    revisionNumber: number,
    state: 'before' | 'after' = 'before'
): Promise<{ success: boolean; error?: string; content?: string }> {
    const content = await restoreFromRevision(filePath, revisionNumber, state);
    if (!content) {
        return { success: false, error: 'Could not restore content from revision' };
    }
    
    const vscode = await import('vscode');
    const uri = vscode.Uri.file(filePath);
    
    try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        info(`Rolled back ${filePath} to revision ${revisionNumber} (${state})`);
        return { success: true, content };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

/**
 * Build a summary of file revision history for display
 */
export function buildRevisionHistorySummary(index: FileRevisionIndex): string {
    if (!index || index.revisions.length === 0) {
        return '';
    }
    
    let summary = `\n📜 **Revision History for ${index.filePath}**\n`;
    summary += `| Rev | Date | Changes | Session |\n`;
    summary += `|-----|------|---------|--------|\n`;
    
    for (const rev of index.revisions.slice(-10)) { // Last 10 revisions
        const date = new Date(rev.createdAt).toLocaleString();
        const changes = `+${rev.changeStats.linesAdded}/-${rev.changeStats.linesDeleted}`;
        summary += `| ${rev.revisionNumber} | ${date} | ${changes} | ${rev.sessionId.slice(0, 8)} |\n`;
    }
    
    return summary;
}
