/**
 * Agent Orchestrator - Three-pass workflow for intelligent file/URL handling.
 * 
 * Pass 1: Fast model analyzes request and creates a plan (TODOs + actions)
 * Pass 2: Execute actions (read files, fetch URLs) with progress updates
 * Pass 3: Main model processes everything and can refine the plan
 */

import * as vscode from 'vscode';
import { sendChatCompletion, GrokMessage } from '../api/grokClient';
import { findAndReadFiles, formatFilesForPrompt, getFilesSummary, FileContent, addLineNumbers } from './workspaceFiles';
import { fetchUrl, extractUrls } from './httpFetcher';
import { followImports, formatImportContext } from './importResolver';
import { 
    AgentPlan, 
    Action, 
    FileAction, 
    UrlAction, 
    ActionResult, 
    ExecutionResult,
    ProgressUpdate,
    TodoAction
} from './actionTypes';
import { debug, info, error as logError } from '../utils/logger';
import { getPromptFromConfig, getSchemaFromConfig } from '../utils/configLoader';

/**
 * Default planning schema for structured outputs (fallback if config not found)
 */
const DEFAULT_PLANNING_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "agent_plan",
        strict: true,
        schema: {
            type: "object",
            properties: {
                summary: { type: "string" },
                todos: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            text: { type: "string" },
                            order: { type: "integer" }
                        },
                        required: ["text", "order"],
                        additionalProperties: false
                    }
                },
                actions: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["file", "url"] },
                            pattern: { type: "string" },
                            url: { type: "string" },
                            reason: { type: "string" }
                        },
                        required: ["type", "reason"],
                        additionalProperties: false
                    }
                }
            },
            required: ["summary", "todos", "actions"],
            additionalProperties: false
        }
    }
};

/**
 * Get the planning schema from config or use default.
 */
function getPlanningSchema(): object {
    return getSchemaFromConfig('planning-schema', DEFAULT_PLANNING_SCHEMA);
}

/**
 * Default planning prompt (fallback if config file not found)
 */
const DEFAULT_PLANNING_PROMPT = `You are a code assistant planner. Analyze the user's request and create a plan.

IMPORTANT: If the user mentions a URL (especially raw.githubusercontent.com links), you MUST include it as a "url" action to fetch its content. The system will download the actual file content for you.

Respond with ONLY valid JSON in this exact format:
{
    "summary": "Brief description of what needs to be done",
    "todos": [
        {"text": "First step to do", "order": 1},
        {"text": "Second step to do", "order": 2}
    ],
    "actions": [
        {"type": "file", "pattern": "**/filename*.py", "reason": "Why this file is needed"},
        {"type": "url", "url": "https://example.com/docs", "reason": "Why this URL is needed"}
    ]
}

Rules for actions:
- Use "file" type for reading files from the workspace
- Use glob patterns for file patterns (e.g., "**/auth*.ts", "src/**/*.py")
- Use "url" type for fetching web pages, documentation, or raw file content from GitHub
- ALWAYS include URLs mentioned by the user as url actions (raw.githubusercontent.com, gist.github.com, docs sites)
- Only include actions that are clearly needed
- Limit to 5 file patterns and 3 URLs maximum

Rules for todos:
- Break down the task into clear steps
- Order them logically (1, 2, 3...)
- Keep each todo concise (under 50 chars)
- Include 2-5 todos typically

Respond with ONLY the JSON, no other text.`;

/**
 * Get the planning prompt from config or use default.
 */
function getPlanningPrompt(): string {
    return getPromptFromConfig('planning-prompt', DEFAULT_PLANNING_PROMPT);
}

export interface PlanResult {
    plan: AgentPlan;
    timeMs: number;
    tokensIn: number;
    tokensOut: number;
}

/**
 * Pass 1: Create a plan from user request.
 */
export async function createPlan(
    userMessage: string,
    apiKey: string,
    fastModel: string,
    onProgress?: (update: ProgressUpdate) => void
): Promise<PlanResult> {
    debug('Creating plan for request...');
    const startTime = Date.now();
    let tokensIn = 0;
    let tokensOut = 0;
    
    const messages: GrokMessage[] = [
        { role: 'system', content: getPlanningPrompt() },
        { role: 'user', content: userMessage }
    ];

    try {
        // Use structured outputs to guarantee valid JSON response
        const response = await sendChatCompletion(
            messages,
            fastModel,
            apiKey,
            { responseFormat: getPlanningSchema() }
        );

        // Capture token usage
        if (response.usage) {
            tokensIn = response.usage.promptTokens;
            tokensOut = response.usage.completionTokens;
        }

        const text = response.text.trim();
        debug('Planning response:', text);

        // With structured outputs, response is guaranteed valid JSON
        try {
            const parsed = JSON.parse(text);
            
            const plan: AgentPlan = {
                summary: parsed.summary || 'Processing request',
                todos: (parsed.todos || []).map((t: any, i: number) => ({
                    text: t.text || `Step ${i + 1}`,
                    order: t.order || i + 1,
                    status: 'pending' as const
                })),
                actions: (parsed.actions || []).filter((a: any) => 
                    a.type === 'file' || a.type === 'url'
                ).map((a: any) => ({
                    type: a.type,
                    pattern: a.pattern,
                    url: a.url,
                    reason: a.reason || ''
                }))
            };
            
            // FALLBACK: If model didn't include URLs but user message contains URLs, add them
            const urlsInMessage = extractUrls(userMessage);
            const existingUrls = plan.actions.filter(a => a.type === 'url').map((a: any) => a.url);
            
            for (const url of urlsInMessage) {
                if (!existingUrls.includes(url)) {
                    info(`Adding missed URL from user message: ${url}`);
                    plan.actions.push({
                        type: 'url',
                        url,
                        reason: 'URL mentioned in user request'
                    } as UrlAction);
                }
            }

            // Log URL actions for debugging
            const urlActions = plan.actions.filter(a => a.type === 'url');
            const fileActions = plan.actions.filter(a => a.type === 'file');
            
            info(`Plan created: ${plan.todos.length} todos, ${fileActions.length} file actions, ${urlActions.length} URL actions`);
            if (urlActions.length > 0) {
                urlActions.forEach((a: any) => debug(`URL action: ${a.url}`));
            }

            onProgress?.({
                type: 'plan',
                message: `📋 Plan created: ${plan.todos.length} steps, ${plan.actions.length} actions` + 
                    (urlActions.length > 0 ? ` (${urlActions.length} URLs)` : ''),
                details: {
                    todoCount: plan.todos.length,
                    actionCount: plan.actions.length
                }
            });

            return {
                plan,
                timeMs: Date.now() - startTime,
                tokensIn,
                tokensOut
            };
        } catch (parseError) {
            debug('JSON parse failed despite structured outputs:', parseError);
        }
    } catch (error) {
        debug('Planning failed:', error);
    }

    // Default empty plan
    return {
        plan: {
            summary: 'Processing request',
            todos: [{ text: 'Analyze and respond', order: 1, status: 'pending' }],
            actions: []
        },
        timeMs: Date.now() - startTime,
        tokensIn,
        tokensOut
    };
}

export interface ExecuteResult {
    execution: ExecutionResult;
    timeMs: number;
}

/**
 * Pass 2: Execute all actions with progress updates.
 */
export async function executeActions(
    plan: AgentPlan,
    onProgress?: (update: ProgressUpdate) => void
): Promise<ExecuteResult> {
    const startTime = Date.now();
    const results: ActionResult[] = [];
    const filesContent = new Map<string, string>();
    const fileHashes = new Map<string, string>();
    const urlsContent = new Map<string, string>();

    for (const action of plan.actions) {
        if (action.type === 'file') {
            const fileAction = action as FileAction;
            
            onProgress?.({
                type: 'file-start',
                message: `🔍 Searching: \`${fileAction.pattern}\``,
                details: { path: fileAction.pattern }
            });

            try {
                const files = await findAndReadFiles(fileAction.pattern, 5);
                
                if (files.length > 0) {
                    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
                    const fileNames = files.map(f => f.name);
                    
                    files.forEach(f => {
                        filesContent.set(f.path, f.content);
                        fileHashes.set(f.path, f.md5Hash);
                    });

                    // Show each file found on its own line for better visibility
                    const fileList = fileNames.map(f => `   └─ ${f}`).join('\n');
                    onProgress?.({
                        type: 'file-done',
                        message: `✅ Found ${files.length} file(s) (${totalLines} lines)\n${fileList}`,
                        details: { 
                            path: fileAction.pattern,
                            lines: totalLines,
                            files: fileNames
                        }
                    });

                    // Follow imports for each loaded file (max depth 3)
                    for (const file of files) {
                        try {
                            onProgress?.({
                                type: 'file-start',
                                message: `🔗 Analyzing imports: ${file.name}`,
                                details: { path: file.path }
                            });
                            
                            const importResult = await followImports(
                                file.path, 
                                file.content,
                                (msg) => onProgress?.({ type: 'file-start', message: msg, details: {} })
                            );
                            
                            // Add imported files to context (with hashes)
                            for (const [importPath, importFile] of importResult.files) {
                                if (!filesContent.has(importPath)) {
                                    filesContent.set(importPath, importFile.content);
                                    fileHashes.set(importPath, importFile.md5Hash);
                                }
                            }
                            
                            // Add external docs to URLs
                            for (const [url, content] of importResult.external) {
                                if (!urlsContent.has(url)) {
                                    urlsContent.set(url, content);
                                }
                            }
                            
                            if (importResult.files.size > 0 || importResult.external.size > 0) {
                                const importedNames = Array.from(importResult.files.keys()).map(p => p.split('/').pop() || p);
                                const importList = importedNames.length > 0 
                                    ? '\n' + importedNames.slice(0, 5).map(f => `   └─ ${f}`).join('\n') + (importedNames.length > 5 ? `\n   └─ ...and ${importedNames.length - 5} more` : '')
                                    : '';
                                onProgress?.({
                                    type: 'file-done',
                                    message: `✅ Found ${importResult.files.size} import(s), ${importResult.external.size} external doc(s)${importList}`,
                                    details: { files: importedNames }
                                });
                            }
                        } catch (importErr: any) {
                            debug('Import following error:', importErr);
                        }
                    }

                    results.push({
                        action,
                        success: true,
                        content: formatFilesForPrompt(files),
                        metadata: { lines: totalLines, files: files.map(f => f.path) }
                    });
                } else {
                    onProgress?.({
                        type: 'error',
                        message: `⚠️ No files found matching ${fileAction.pattern}`,
                        details: { path: fileAction.pattern }
                    });

                    results.push({
                        action,
                        success: false,
                        error: 'No matching files found'
                    });
                }
            } catch (err: any) {
                onProgress?.({
                    type: 'error',
                    message: `❌ Error reading ${fileAction.pattern}: ${err.message}`,
                    details: { path: fileAction.pattern }
                });

                results.push({
                    action,
                    success: false,
                    error: err.message
                });
            }
        } else if (action.type === 'url') {
            const urlAction = action as UrlAction;
            
            info(`Executing URL action: ${urlAction.url}`);
            
            // Extract a readable URL label
            let urlLabel = urlAction.url;
            try {
                const parsedUrl = new URL(urlAction.url);
                const pathParts = parsedUrl.pathname.split('/').filter(p => p);
                const fileName = pathParts[pathParts.length - 1] || parsedUrl.hostname;
                urlLabel = `${parsedUrl.hostname}/${fileName}`;
            } catch { /* keep full URL */ }
            
            onProgress?.({
                type: 'url-start',
                message: `🌐 Fetching: ${urlLabel}`,
                details: { url: urlAction.url }
            });

            try {
                const fetchResult = await fetchUrl(urlAction.url);
                info(`URL fetch result: success=${fetchResult.success}, bytes=${fetchResult.bytes}`);
                
                if (fetchResult.success && fetchResult.content) {
                    urlsContent.set(urlAction.url, fetchResult.content);
                    
                    const sizeKB = Math.round((fetchResult.bytes || 0) / 1024);
                    onProgress?.({
                        type: 'url-done',
                        message: `✅ Fetched ${urlLabel} (${sizeKB}KB)`,
                        details: { url: urlAction.url, bytes: fetchResult.bytes }
                    });

                    results.push({
                        action,
                        success: true,
                        content: fetchResult.content,
                        metadata: { bytes: fetchResult.bytes }
                    });
                } else {
                    onProgress?.({
                        type: 'error',
                        message: `⚠️ Failed to fetch ${urlAction.url}: ${fetchResult.error}`,
                        details: { url: urlAction.url }
                    });

                    results.push({
                        action,
                        success: false,
                        error: fetchResult.error
                    });
                }
            } catch (err: any) {
                onProgress?.({
                    type: 'error',
                    message: `❌ Error fetching ${urlAction.url}: ${err.message}`,
                    details: { url: urlAction.url }
                });

                results.push({
                    action,
                    success: false,
                    error: err.message
                });
            }
        }
    }

    return { 
        execution: { plan, results, filesContent, fileHashes, urlsContent },
        timeMs: Date.now() - startTime
    };
}

/**
 * Build the augmented message with all gathered context.
 */
export function buildAugmentedMessage(
    originalMessage: string,
    plan: AgentPlan,
    execution: ExecutionResult
): string {
    let augmented = originalMessage;

    // Add plan context
    if (plan.todos.length > 0) {
        augmented += '\n\n---\n**Current Plan (you may refine this):**\n';
        plan.todos.forEach(t => {
            augmented += `${t.order}. ${t.text}\n`;
        });
    }

    // CRITICAL: Report failed file searches so AI doesn't hallucinate
    const failedFileActions = execution.results.filter(r => 
        !r.success && r.action.type === 'file'
    );
    if (failedFileActions.length > 0) {
        augmented += '\n\n---\n**⚠️ FILE SEARCH FAILED - DO NOT PRETEND YOU HAVE ACCESS:**\n';
        for (const result of failedFileActions) {
            const fileAction = result.action as FileAction;
            augmented += `- Pattern \`${fileAction.pattern}\` returned NO FILES\n`;
        }
        augmented += '\n**You CANNOT see these files. Ask the user to attach them or provide the correct path.**\n';
    }

    // Add file contents with line numbers
    if (execution.filesContent.size > 0) {
        augmented += '\n\n---\n**Files from workspace (with line numbers and MD5 hashes - use these in fileHashes when modifying):**\n';
        for (const [filePath, content] of execution.filesContent) {
            const hash = execution.fileHashes.get(filePath) || 'UNKNOWN';
            // Add line numbers to help AI reference correct lines
            const numberedContent = addLineNumbers(content);
            augmented += `\n### ${filePath} [MD5: ${hash}]\n\`\`\`\n${numberedContent}\n\`\`\`\n`;
        }
        augmented += '\n**IMPORTANT: Line numbers shown are 1-indexed. When using lineOperations, use exact line numbers as shown.**\n';
    }

    // CRITICAL: Report failed URL fetches so AI doesn't hallucinate
    const failedUrlActions = execution.results.filter(r => 
        !r.success && r.action.type === 'url'
    );
    if (failedUrlActions.length > 0) {
        augmented += '\n\n---\n**⚠️ URL FETCH FAILED - DO NOT PRETEND YOU HAVE THIS CONTENT:**\n';
        for (const result of failedUrlActions) {
            const urlAction = result.action as UrlAction;
            augmented += `- URL \`${urlAction.url}\` FAILED: ${result.error}\n`;
        }
        augmented += '\n**You CANNOT see this content. Tell the user the fetch failed.**\n';
    }

    // Add URL contents
    if (execution.urlsContent.size > 0) {
        augmented += '\n\n---\n**Content fetched from URLs (USE THIS EXACT CONTENT):**\n';
        for (const [url, content] of execution.urlsContent) {
            // Extract filename from URL for raw GitHub files
            let suggestedFilename = '';
            try {
                const urlPath = new URL(url).pathname;
                const filename = urlPath.split('/').pop() || '';
                if (filename && (filename.endsWith('.py') || filename.endsWith('.js') || 
                    filename.endsWith('.ts') || filename.endsWith('.json') || filename.endsWith('.md'))) {
                    suggestedFilename = filename;
                }
            } catch {}
            
            // Truncate to reasonable size
            const truncated = content.length > 10000 
                ? content.substring(0, 10000) + '\n\n[Content truncated...]'
                : content;
            
            if (suggestedFilename) {
                augmented += `\n### ${url}\n**SAVE AS: ${suggestedFilename}**\n\`\`\`\n${truncated}\n\`\`\`\n`;
            } else {
                augmented += `\n### ${url}\n\`\`\`\n${truncated}\n\`\`\`\n`;
            }
        }
    }

    augmented += '\n\n---\n**IMPORTANT:** When creating fileChanges from URL content, use the EXACT content fetched above (do not modify or regenerate). Include the full file extension (e.g., .py, .js) in the path.';

    return augmented;
}

export interface AgentWorkflowResult {
    augmentedMessage: string;
    filesLoaded: FileContent[];
    urlsLoaded: number;
    skipped: boolean;
    plan?: AgentPlan;
    stepMetrics: {
        planning: { timeMs: number; tokensIn: number; tokensOut: number };
        execute: { timeMs: number };
    };
}

/**
 * Full three-pass agent workflow.
 */
export async function runAgentWorkflow(
    userMessage: string,
    apiKey: string,
    fastModel: string,
    onProgress?: (message: string) => void
): Promise<AgentWorkflowResult> {
    
    // Convert string progress to ProgressUpdate for internal use
    const progressHandler = (update: ProgressUpdate) => {
        onProgress?.(update.message);
    };

    // Pass 1: Create plan
    onProgress?.('🧠 Planning...');
    const planResult = await createPlan(userMessage, apiKey, fastModel, progressHandler);
    const plan = planResult.plan;
    
    if (plan.actions.length === 0) {
        debug('No actions in plan, proceeding directly');
        return {
            augmentedMessage: userMessage,
            filesLoaded: [],
            urlsLoaded: 0,
            skipped: true,
            plan,
            stepMetrics: {
                planning: { timeMs: planResult.timeMs, tokensIn: planResult.tokensIn, tokensOut: planResult.tokensOut },
                execute: { timeMs: 0 }
            }
        };
    }

    info(`Plan created: ${plan.todos.length} todos, ${plan.actions.length} actions`);

    // Pass 2: Execute actions
    const executeResult = await executeActions(plan, progressHandler);
    const execution = executeResult.execution;
    
    // Collect loaded files for return value
    const filesLoaded: FileContent[] = [];
    for (const result of execution.results) {
        if (result.success && result.action.type === 'file' && result.metadata?.files) {
            for (const filePath of result.metadata.files) {
                const content = execution.filesContent.get(filePath);
                const hash = execution.fileHashes.get(filePath);
                if (content) {
                    filesLoaded.push({
                        path: filePath,
                        relativePath: filePath,
                        name: filePath.split('/').pop() || filePath,
                        content,
                        language: filePath.split('.').pop() || 'text',
                        lineCount: content.split('\n').length,
                        md5Hash: hash || ''
                    });
                }
            }
        }
    }

    // Build augmented message
    const augmented = buildAugmentedMessage(userMessage, plan, execution);
    
    const totalFiles = execution.filesContent.size;
    const totalUrls = execution.urlsContent.size;
    
    if (totalFiles > 0 || totalUrls > 0) {
        onProgress?.(`✅ Ready: ${totalFiles} file(s), ${totalUrls} URL(s) loaded`);
    }

    return {
        augmentedMessage: augmented,
        filesLoaded,
        urlsLoaded: totalUrls,
        skipped: false,
        plan,
        stepMetrics: {
            planning: { timeMs: planResult.timeMs, tokensIn: planResult.tokensIn, tokensOut: planResult.tokensOut },
            execute: { timeMs: executeResult.timeMs }
        }
    };
}

// ============================================================================
// Files API Workflow - Upload files to xAI instead of embedding
// ============================================================================

import { uploadFile, UploadedFile, FileUploadResult } from '../api/fileUploader';
import { 
    addUploadedFile, 
    findUploadedFile, 
    getUploadedFiles,
    UploadedFileRecord 
} from '../storage/chatSessionRepository';
import { computeMd5Hash } from './workspaceFiles';

export interface FilesApiWorkflowResult {
    /** File IDs to attach to the message (for document_search) */
    fileIds: string[];
    /** Files that were uploaded this turn */
    newlyUploaded: UploadedFile[];
    /** Files that were already uploaded (reused) */
    reused: string[];
    /** Plan from Pass 1 */
    plan?: AgentPlan;
    /** URL content (still embedded as text) */
    urlContent: Map<string, string>;
    stepMetrics: {
        planning: { timeMs: number; tokensIn: number; tokensOut: number };
        execute: { timeMs: number };
    };
}

/**
 * Run agent workflow using xAI Files API.
 * 
 * Instead of embedding file content in the prompt, files are uploaded to xAI
 * and referenced by file_id. The AI uses document_search tool to access them.
 * 
 * Benefits:
 * - Files persist across conversation turns
 * - AI can search files multiple times with different queries
 * - Reduced token usage (file content not in prompt)
 * - No hallucination - AI searches actual uploaded content
 */
export async function runFilesApiWorkflow(
    userMessage: string,
    apiKey: string,
    fastModel: string,
    sessionId: string,
    onProgress?: (message: string) => void
): Promise<FilesApiWorkflowResult> {
    const startTime = Date.now();
    
    // Convert string progress to ProgressUpdate for internal use
    const progressHandler = (update: ProgressUpdate) => {
        onProgress?.(update.message);
    };

    // Pass 1: Create plan (same as before)
    onProgress?.('🧠 Planning...');
    const planResult = await createPlan(userMessage, apiKey, fastModel, progressHandler);
    const plan = planResult.plan;
    
    const fileIds: string[] = [];
    const newlyUploaded: UploadedFile[] = [];
    const reused: string[] = [];
    const urlContent = new Map<string, string>();
    
    if (plan.actions.length === 0) {
        debug('No actions in plan, proceeding directly');
        
        // Still include any previously uploaded files from this session
        const existingFiles = await getUploadedFiles(sessionId);
        for (const file of existingFiles) {
            fileIds.push(file.fileId);
            reused.push(file.localPath);
        }
        
        return {
            fileIds,
            newlyUploaded,
            reused,
            plan,
            urlContent,
            stepMetrics: {
                planning: { timeMs: planResult.timeMs, tokensIn: planResult.tokensIn, tokensOut: planResult.tokensOut },
                execute: { timeMs: 0 }
            }
        };
    }

    info(`Plan created: ${plan.todos.length} todos, ${plan.actions.length} actions`);

    // Pass 2: Execute actions - upload files instead of embedding
    const executeStart = Date.now();
    
    // Process file actions
    const fileActions = plan.actions.filter((a): a is FileAction => a.type === 'file');
    
    for (const fileAction of fileActions) {
        onProgress?.(`🔍 Finding: ${fileAction.pattern}`);
        
        const files = await findAndReadFiles(fileAction.pattern, 10);
        
        if (files.length === 0) {
            onProgress?.(`⚠️ No files found: ${fileAction.pattern}`);
            continue;
        }
        
        for (const file of files) {
            const hash = computeMd5Hash(file.content);
            
            // Check if already uploaded with same hash
            const existingId = await findUploadedFile(sessionId, file.path, hash);
            if (existingId) {
                info(`Reusing uploaded file: ${file.name} -> ${existingId}`);
                fileIds.push(existingId);
                reused.push(file.path);
                continue;
            }
            
            // Upload new file
            onProgress?.(`📤 Uploading: ${file.name}`);
            
            const result = await uploadFile(file.path, apiKey);
            
            if (result.success && result.file) {
                fileIds.push(result.file.id);
                newlyUploaded.push(result.file);
                
                // Track in session
                await addUploadedFile(sessionId, {
                    fileId: result.file.id,
                    localPath: file.path,
                    filename: file.name,
                    size: result.file.size,
                    hash
                });
                
                onProgress?.(`✅ Uploaded: ${file.name}`);
            } else {
                onProgress?.(`❌ Upload failed: ${file.name} - ${result.error}`);
            }
        }
    }
    
    // Process URL actions (still fetch and embed for now)
    const urlActions = plan.actions.filter((a): a is UrlAction => a.type === 'url');
    
    for (const urlAction of urlActions) {
        let urlLabel = urlAction.url;
        try {
            const u = new URL(urlAction.url);
            urlLabel = u.hostname + u.pathname.substring(0, 30);
        } catch { /* keep full URL */ }
        
        onProgress?.(`🌐 Fetching: ${urlLabel}`);
        
        try {
            const result = await fetchUrl(urlAction.url);
            if (result.success && result.content) {
                urlContent.set(urlAction.url, result.content);
                onProgress?.(`✅ Fetched: ${urlLabel}`);
            } else {
                onProgress?.(`⚠️ Failed: ${urlLabel}`);
            }
        } catch (err: any) {
            onProgress?.(`❌ Error: ${urlLabel}`);
        }
    }
    
    const executeTime = Date.now() - executeStart;
    
    // Include previously uploaded files that weren't in this plan
    const existingFiles = await getUploadedFiles(sessionId);
    for (const file of existingFiles) {
        if (!fileIds.includes(file.fileId)) {
            fileIds.push(file.fileId);
            reused.push(file.localPath);
        }
    }
    
    if (newlyUploaded.length > 0 || reused.length > 0) {
        onProgress?.(`✅ Ready: ${newlyUploaded.length} uploaded, ${reused.length} reused`);
    }

    return {
        fileIds,
        newlyUploaded,
        reused,
        plan,
        urlContent,
        stepMetrics: {
            planning: { timeMs: planResult.timeMs, tokensIn: planResult.tokensIn, tokensOut: planResult.tokensOut },
            execute: { timeMs: executeTime }
        }
    };
}

/**
 * Build message text for Files API workflow.
 * 
 * Unlike buildAugmentedMessage, this does NOT embed file content.
 * Files are attached via file_id and AI uses document_search.
 * 
 * We still include:
 * - Plan/TODOs
 * - URL content (since URLs aren't uploaded as files)
 * - Instructions for the AI
 */
export function buildFilesApiMessage(
    originalMessage: string,
    plan: AgentPlan,
    urlContent: Map<string, string>,
    fileCount: number
): string {
    let message = originalMessage;

    // Add plan context
    if (plan.todos.length > 0) {
        message += '\n\n---\n**Current Plan (you may refine this):**\n';
        plan.todos.forEach(t => {
            message += `${t.order}. ${t.text}\n`;
        });
    }

    // Add URL contents (these are still embedded)
    if (urlContent.size > 0) {
        message += '\n\n---\n**Content fetched from URLs:**\n';
        for (const [url, content] of urlContent) {
            const truncated = content.length > 10000 
                ? content.substring(0, 10000) + '\n\n[Content truncated...]'
                : content;
            message += `\n### ${url}\n\`\`\`\n${truncated}\n\`\`\`\n`;
        }
    }

    // Add instructions about file access
    if (fileCount > 0) {
        message += `\n\n---\n**📁 ${fileCount} file(s) attached via document_search.**\n`;
        message += 'You can search these files to find relevant content. The files are available for your analysis.\n';
        message += 'When modifying files, you can see their current content through document_search.\n';
    }

    return message;
}

// Re-export for backward compatibility
export { FileContent } from './workspaceFiles';
