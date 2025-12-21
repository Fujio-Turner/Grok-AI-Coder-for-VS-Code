/**
 * Agent Orchestrator - Three-pass workflow for intelligent file/URL handling.
 * 
 * Pass 1: Fast model analyzes request and creates a plan (TODOs + actions)
 * Pass 2: Execute actions (read files, fetch URLs) with progress updates
 * Pass 3: Main model processes everything and can refine the plan
 */

import * as vscode from 'vscode';
import { sendChatCompletion, GrokMessage } from '../api/grokClient';
import { findAndReadFiles, formatFilesForPrompt, getFilesSummary, FileContent } from './workspaceFiles';
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

/**
 * System prompt for the fast model to create a plan.
 */
const PLANNING_PROMPT = `You are a code assistant planner. Analyze the user's request and create a plan.

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
- Use "url" type for fetching web pages (documentation, API references)
- Only include actions that are clearly needed
- Limit to 5 file patterns and 3 URLs maximum

Rules for todos:
- Break down the task into clear steps
- Order them logically (1, 2, 3...)
- Keep each todo concise (under 50 chars)
- Include 2-5 todos typically

Examples:

User: "Review the 06_read_*.py files for Couchbase"
{
    "summary": "Review Couchbase read files for best practices",
    "todos": [
        {"text": "Locate and read 06_read_*.py files", "order": 1},
        {"text": "Check error handling patterns", "order": 2},
        {"text": "Review timeout configurations", "order": 3},
        {"text": "Identify improvements", "order": 4}
    ],
    "actions": [
        {"type": "file", "pattern": "**/06_read_*.py", "reason": "Main files to review"}
    ]
}

User: "How do I use the Couchbase Python SDK for replica reads? Check the docs."
{
    "summary": "Explain Couchbase replica reads with SDK docs",
    "todos": [
        {"text": "Fetch Couchbase SDK documentation", "order": 1},
        {"text": "Find replica read examples", "order": 2},
        {"text": "Explain usage patterns", "order": 3}
    ],
    "actions": [
        {"type": "url", "url": "https://docs.couchbase.com/python-sdk/current/howtos/concurrent-document-mutations.html", "reason": "Official replica read docs"}
    ]
}

User: "What's the best way to handle errors in JavaScript?"
{
    "summary": "Explain JavaScript error handling best practices",
    "todos": [
        {"text": "Explain try-catch patterns", "order": 1},
        {"text": "Cover async error handling", "order": 2},
        {"text": "Show best practices", "order": 3}
    ],
    "actions": []
}

Respond with ONLY the JSON, no other text.`;

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
        { role: 'system', content: PLANNING_PROMPT },
        { role: 'user', content: userMessage }
    ];

    try {
        const response = await sendChatCompletion(
            messages,
            fastModel,
            apiKey,
            undefined,
            undefined
        );

        // Capture token usage
        if (response.usage) {
            tokensIn = response.usage.promptTokens;
            tokensOut = response.usage.completionTokens;
        }

        const text = response.text.trim();
        debug('Planning response:', text);

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            
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

            onProgress?.({
                type: 'plan',
                message: `📋 Plan created: ${plan.todos.length} steps, ${plan.actions.length} actions`,
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
    const urlsContent = new Map<string, string>();

    for (const action of plan.actions) {
        if (action.type === 'file') {
            const fileAction = action as FileAction;
            
            onProgress?.({
                type: 'file-start',
                message: `📂 Searching for ${fileAction.pattern}...`,
                details: { path: fileAction.pattern }
            });

            try {
                const files = await findAndReadFiles(fileAction.pattern, 5);
                
                if (files.length > 0) {
                    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
                    const fileNames = files.map(f => f.name).join(', ');
                    
                    files.forEach(f => {
                        filesContent.set(f.path, f.content);
                    });

                    onProgress?.({
                        type: 'file-done',
                        message: `✅ Loaded ${files.length} file(s): ${fileNames} (${totalLines} lines)`,
                        details: { 
                            path: fileAction.pattern,
                            lines: totalLines,
                            files: files.map(f => f.name)
                        }
                    });

                    // Follow imports for each loaded file (max depth 3)
                    for (const file of files) {
                        try {
                            onProgress?.({
                                type: 'file-start',
                                message: `🔗 Following imports in ${file.name}...`,
                                details: { path: file.path }
                            });
                            
                            const importResult = await followImports(
                                file.path, 
                                file.content,
                                (msg) => onProgress?.({ type: 'file-start', message: msg, details: {} })
                            );
                            
                            // Add imported files to context
                            for (const [importPath, importFile] of importResult.files) {
                                if (!filesContent.has(importPath)) {
                                    filesContent.set(importPath, importFile.content);
                                }
                            }
                            
                            // Add external docs to URLs
                            for (const [url, content] of importResult.external) {
                                if (!urlsContent.has(url)) {
                                    urlsContent.set(url, content);
                                }
                            }
                            
                            if (importResult.files.size > 0 || importResult.external.size > 0) {
                                onProgress?.({
                                    type: 'file-done',
                                    message: `🔗 Found ${importResult.files.size} imported files, ${importResult.external.size} external docs (depth ${importResult.depth})`,
                                    details: { files: Array.from(importResult.files.keys()).map(p => p.split('/').pop() || p) }
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
            
            onProgress?.({
                type: 'url-start',
                message: `🌐 Fetching ${urlAction.url}...`,
                details: { url: urlAction.url }
            });

            try {
                const fetchResult = await fetchUrl(urlAction.url);
                
                if (fetchResult.success && fetchResult.content) {
                    urlsContent.set(urlAction.url, fetchResult.content);
                    
                    const sizeKB = Math.round((fetchResult.bytes || 0) / 1024);
                    onProgress?.({
                        type: 'url-done',
                        message: `✅ Fetched ${new URL(urlAction.url).hostname} (${sizeKB}KB)`,
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
        execution: { plan, results, filesContent, urlsContent },
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

    // Add file contents
    if (execution.filesContent.size > 0) {
        augmented += '\n\n---\n**Files from workspace:**\n';
        for (const [path, content] of execution.filesContent) {
            augmented += `\n### ${path}\n\`\`\`\n${content}\n\`\`\`\n`;
        }
    }

    // Add URL contents
    if (execution.urlsContent.size > 0) {
        augmented += '\n\n---\n**Content from URLs:**\n';
        for (const [url, content] of execution.urlsContent) {
            // Truncate to reasonable size
            const truncated = content.length > 10000 
                ? content.substring(0, 10000) + '\n\n[Content truncated...]'
                : content;
            augmented += `\n### ${url}\n${truncated}\n`;
        }
    }

    augmented += '\n\n---\nPlease analyze the above and respond to the user\'s request. You may update the TODO list if needed.';

    return augmented;
}

export interface AgentWorkflowResult {
    augmentedMessage: string;
    filesLoaded: FileContent[];
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
                if (content) {
                    filesLoaded.push({
                        path: filePath,
                        relativePath: filePath,
                        name: filePath.split('/').pop() || filePath,
                        content,
                        language: filePath.split('.').pop() || 'text',
                        lineCount: content.split('\n').length
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
        skipped: false,
        plan,
        stepMetrics: {
            planning: { timeMs: planResult.timeMs, tokensIn: planResult.tokensIn, tokensOut: planResult.tokensOut },
            execute: { timeMs: executeResult.timeMs }
        }
    };
}

// Re-export for backward compatibility
export { FileContent } from './workspaceFiles';
