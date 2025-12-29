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
    AnalyzeAction,
    ExtractAction,
    RequestContentAction,
    FileMetadata,
    ActionResult, 
    ExecutionResult,
    ProgressUpdate,
    TodoAction
} from './actionTypes';
import { debug, info, error as logError } from '../utils/logger';
import { getPromptFromConfig, getSchemaFromConfig } from '../utils/configLoader';
import { 
    chunkFile, 
    needsChunking, 
    formatChunkForPrompt, 
    createChunkSummary,
    FileChunk,
    ChunkingResult,
    ChunkingOptions
} from './fileChunker';

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
                ).map((a: any) => {
                    if (a.type === 'file') {
                        // Support both patterns array and legacy pattern field
                        const patterns = a.patterns || (a.pattern ? [a.pattern] : []);
                        return {
                            type: a.type,
                            pattern: patterns[0] || a.pattern, // Keep for backward compat
                            patterns,
                            reason: a.reason || '',
                            required: a.required,
                            fallbackAction: a.fallbackAction
                        } as FileAction;
                    }
                    return {
                        type: a.type,
                        url: a.url,
                        reason: a.reason || ''
                    } as UrlAction;
                })
            };
            
            // Log raw actions from planner for debugging
            debug(`Raw actions from planner: ${JSON.stringify(parsed.actions || [])}`);
            
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
            
            // FALLBACK: If model didn't include file actions but user message contains file paths, add them
            // Matches patterns like: `path/to/file.ext`, "path/to/file.ext", or bare path/file.ext
            const filePathPatterns = [
                /`([^`]+\.[a-zA-Z]{1,10})`/g,  // backtick-quoted paths with extension
                /"([^"]+\.[a-zA-Z]{1,10})"/g,  // double-quoted paths with extension
                /'([^']+\.[a-zA-Z]{1,10})'/g,  // single-quoted paths with extension
                /\b([\w\/\\.-]+\.(py|ts|tsx|js|jsx|json|yaml|yml|md|txt|html|css|scss|go|rs|java|c|cpp|h|hpp))\b/gi  // common code file extensions
            ];
            
            const existingFilePaths = new Set<string>();
            plan.actions.filter(a => a.type === 'file').forEach((a: any) => {
                if (a.patterns) a.patterns.forEach((p: string) => existingFilePaths.add(p));
                if (a.pattern) existingFilePaths.add(a.pattern);
            });
            
            for (const regex of filePathPatterns) {
                let match;
                while ((match = regex.exec(userMessage)) !== null) {
                    const filePath = match[1];
                    // Skip if it looks like a URL or already exists
                    if (filePath.startsWith('http') || filePath.startsWith('//')) continue;
                    if (existingFilePaths.has(filePath)) continue;
                    
                    // Check if this path is already covered by an existing pattern
                    const fileName = filePath.split('/').pop() || filePath;
                    const alreadyCovered = Array.from(existingFilePaths).some(p => 
                        p.includes(fileName) || filePath.includes(p.replace('**/', ''))
                    );
                    if (alreadyCovered) continue;
                    
                    info(`Adding missed file path from user message: ${filePath}`);
                    existingFilePaths.add(filePath);
                    plan.actions.push({
                        type: 'file',
                        pattern: filePath,
                        patterns: [filePath, `**/${fileName}`],
                        reason: 'File path mentioned in user request'
                    } as FileAction);
                }
            }

            // Log URL actions for debugging
            const urlActions = plan.actions.filter(a => a.type === 'url');
            const fileActions = plan.actions.filter(a => a.type === 'file');
            
            info(`Plan created: ${plan.todos.length} todos, ${fileActions.length} file actions, ${urlActions.length} URL actions`);
            if (fileActions.length > 0) {
                fileActions.forEach((a: any) => debug(`File action: ${JSON.stringify(a.patterns || a.pattern)}`));
            }
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
 * Threshold for large file detection - files above this get metadata only.
 * Default: 100KB - files above this get metadata only, AI must request content
 * Files under this threshold are loaded directly with full content.
 */
const LARGE_FILE_THRESHOLD = 100 * 1024;

/** Number of preview lines to include in file metadata */
const METADATA_PREVIEW_LINES = 30;

/**
 * Extract structure hints from file content (classes, functions, sections).
 * Returns lightweight hints to help AI understand file structure without full content.
 */
function extractStructureHints(content: string, language: string): FileMetadata['structureHints'] {
    const lines = content.split('\n');
    const classes: string[] = [];
    const functions: string[] = [];
    const sections: string[] = [];
    
    const patterns: { [lang: string]: { classes: RegExp; functions: RegExp } } = {
        py: {
            classes: /^class\s+(\w+)/,
            functions: /^(?:async\s+)?def\s+(\w+)/
        },
        python: {
            classes: /^class\s+(\w+)/,
            functions: /^(?:async\s+)?def\s+(\w+)/
        },
        ts: {
            classes: /^(?:export\s+)?class\s+(\w+)/,
            functions: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
        },
        typescript: {
            classes: /^(?:export\s+)?class\s+(\w+)/,
            functions: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
        },
        js: {
            classes: /^(?:export\s+)?class\s+(\w+)/,
            functions: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
        },
        javascript: {
            classes: /^(?:export\s+)?class\s+(\w+)/,
            functions: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/
        }
    };
    
    const langPatterns = patterns[language.toLowerCase()];
    
    for (const line of lines) {
        const trimmed = line.trim();
        
        if (langPatterns) {
            const classMatch = trimmed.match(langPatterns.classes);
            if (classMatch && classes.length < 20) {
                classes.push(classMatch[1]);
            }
            const funcMatch = trimmed.match(langPatterns.functions);
            if (funcMatch && functions.length < 30) {
                functions.push(funcMatch[1]);
            }
        }
        
        // Section markers (comments with headers)
        if (trimmed.match(/^(#|\/\/)\s*={3,}|^(#|\/\/)\s*-{3,}/)) {
            const nextLineIdx = lines.indexOf(line) + 1;
            if (nextLineIdx < lines.length) {
                const sectionLine = lines[nextLineIdx].trim();
                const sectionMatch = sectionLine.match(/^(?:#|\/\/)\s*(.+)/);
                if (sectionMatch && sections.length < 10) {
                    sections.push(sectionMatch[1].substring(0, 50));
                }
            }
        }
    }
    
    return {
        classes: classes.length > 0 ? classes : undefined,
        functions: functions.length > 0 ? functions : undefined,
        sections: sections.length > 0 ? sections : undefined
    };
}

/**
 * Collect metadata for a large file without loading full content.
 */
function collectFileMetadata(file: FileContent): FileMetadata {
    const lines = file.content.split('\n');
    const previewLines = lines.slice(0, METADATA_PREVIEW_LINES).join('\n');
    const structureHints = extractStructureHints(file.content, file.language);
    
    return {
        path: file.relativePath,
        sizeBytes: file.content.length,
        lineCount: file.lineCount,
        language: file.language,
        md5Hash: file.md5Hash,
        preview: previewLines,
        structureHints,
        reason: `File size ${(file.content.length / 1024).toFixed(1)}KB exceeds ${LARGE_FILE_THRESHOLD / 1024}KB threshold`
    };
}

/**
 * Check if a file should be treated as a large file (metadata only).
 */
function isLargeFile(file: FileContent): boolean {
    return file.content.length > LARGE_FILE_THRESHOLD;
}

/**
 * Pass 2: Execute all actions with progress updates.
 * Large files (>50KB) get metadata only - AI must request content via request_content action.
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
    const largeFileMetadata: FileMetadata[] = [];

    for (const action of plan.actions) {
        if (action.type === 'file') {
            const fileAction = action as FileAction;
            
            // Get patterns to try (use patterns array or fall back to single pattern)
            const patternsToTry = fileAction.patterns?.length 
                ? fileAction.patterns 
                : (fileAction.pattern ? [fileAction.pattern] : []);
            
            if (patternsToTry.length === 0) {
                results.push({
                    action,
                    success: false,
                    error: 'No patterns specified'
                });
                continue;
            }
            
            let foundFiles: FileContent[] = [];
            let successfulPattern: string | null = null;
            let lastError: string | null = null;
            
            // Try each pattern in order until one succeeds
            for (let i = 0; i < patternsToTry.length; i++) {
                const pattern = patternsToTry[i];
                const isLastPattern = i === patternsToTry.length - 1;
                
                onProgress?.({
                    type: 'file-start',
                    message: `🔍 Searching: \`${pattern}\`${patternsToTry.length > 1 ? ` (${i + 1}/${patternsToTry.length})` : ''}`,
                    details: { path: pattern }
                });

                try {
                    const files = await findAndReadFiles(pattern, 5);
                    
                    if (files.length > 0) {
                        foundFiles = files;
                        successfulPattern = pattern;
                        
                        // Log which pattern worked if we tried multiple
                        if (i > 0) {
                            info(`Pattern fallback succeeded: "${pattern}" (attempt ${i + 1}/${patternsToTry.length})`);
                        }
                        break; // Stop trying patterns
                    } else if (!isLastPattern) {
                        // Pattern didn't find anything, try next
                        debug(`Pattern "${pattern}" found nothing, trying next fallback...`);
                    }
                } catch (err: any) {
                    lastError = err.message;
                    if (!isLastPattern) {
                        debug(`Pattern "${pattern}" error: ${err.message}, trying next fallback...`);
                    }
                }
            }
            
            if (foundFiles.length > 0 && successfulPattern) {
                // Separate large files (metadata only) from regular files (full content)
                const regularFiles: FileContent[] = [];
                const largeFiles: FileContent[] = [];
                
                for (const file of foundFiles) {
                    if (isLargeFile(file)) {
                        largeFiles.push(file);
                    } else {
                        regularFiles.push(file);
                    }
                }
                
                // Add regular files to content maps
                regularFiles.forEach(f => {
                    filesContent.set(f.path, f.content);
                    fileHashes.set(f.path, f.md5Hash);
                });
                
                // Collect metadata for large files (content not loaded)
                for (const file of largeFiles) {
                    const metadata = collectFileMetadata(file);
                    largeFileMetadata.push(metadata);
                    // Store hash so we can verify later when content is requested
                    fileHashes.set(file.path, file.md5Hash);
                    
                    onProgress?.({
                        type: 'file-done',
                        message: `📊 Large file detected: ${file.name} (${(file.content.length / 1024).toFixed(1)}KB, ${file.lineCount} lines)\n   └─ Metadata collected, awaiting AI request for content`,
                        details: { 
                            path: file.path,
                            lines: file.lineCount,
                            bytes: file.content.length
                        }
                    });
                }

                const totalLines = regularFiles.reduce((sum, f) => sum + f.lineCount, 0);
                const fileNames = regularFiles.map(f => f.name);
                
                if (regularFiles.length > 0) {
                    // Show each file found on its own line for better visibility
                    const fileList = fileNames.map(f => `   └─ ${f}`).join('\n');
                    onProgress?.({
                        type: 'file-done',
                        message: `✅ Loaded ${regularFiles.length} file(s) (${totalLines} lines)\n${fileList}`,
                        details: { 
                            path: successfulPattern,
                            lines: totalLines,
                            files: fileNames
                        }
                    });
                }

                // Follow imports for each loaded file (max depth 3) - only for regular files
                for (const file of regularFiles) {
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
                    content: formatFilesForPrompt(foundFiles),
                    metadata: { lines: totalLines, files: foundFiles.map(f => f.path) }
                });
            } else {
                // All patterns failed
                const allPatterns = patternsToTry.join(', ');
                const fallbackAction = fileAction.fallbackAction || 'ask_user';
                
                let message: string;
                if (fallbackAction === 'skip' && !fileAction.required) {
                    message = `⚠️ Skipped: No files found matching [${allPatterns}]`;
                } else {
                    message = `⚠️ No files found matching [${allPatterns}] - tried ${patternsToTry.length} pattern(s)`;
                }
                
                onProgress?.({
                    type: 'error',
                    message,
                    details: { path: patternsToTry[0] }
                });

                results.push({
                    action,
                    success: false,
                    error: lastError || 'No matching files found'
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
        } else if (action.type === 'analyze') {
            // Local analysis action - run command locally to analyze large files
            const analyzeAction = action as AnalyzeAction;
            
            onProgress?.({
                type: 'file-start',
                message: `🔬 Analyzing: ${analyzeAction.targetFile || 'file'} (${analyzeAction.reason})`,
                details: { path: analyzeAction.targetFile }
            });

            try {
                const analysisResult = await executeLocalCommand(analyzeAction.command, onProgress);
                
                if (analysisResult.success) {
                    onProgress?.({
                        type: 'file-done',
                        message: `✅ Analysis complete (${analysisResult.output?.split('\n').length || 0} lines output)`,
                        details: { path: analyzeAction.targetFile }
                    });

                    results.push({
                        action,
                        success: true,
                        content: analysisResult.output,
                        metadata: { 
                            bytes: analysisResult.output?.length || 0,
                            lines: analysisResult.output?.split('\n').length || 0
                        }
                    });
                } else {
                    results.push({
                        action,
                        success: false,
                        error: analysisResult.error || 'Analysis command failed'
                    });
                }
            } catch (err: any) {
                results.push({
                    action,
                    success: false,
                    error: err.message
                });
            }
        } else if (action.type === 'extract') {
            // Extract action - extract specific lines from a file
            const extractAction = action as ExtractAction;
            
            onProgress?.({
                type: 'file-start',
                message: `📑 Extracting lines ${extractAction.startLine}-${extractAction.endLine} from ${extractAction.sourceFile}`,
                details: { path: extractAction.sourceFile }
            });

            try {
                const extractResult = await extractFileLines(
                    extractAction.sourceFile,
                    extractAction.startLine,
                    extractAction.endLine,
                    extractAction.destinationFile
                );
                
                if (extractResult.success) {
                    onProgress?.({
                        type: 'file-done',
                        message: `✅ Extracted ${extractResult.lineCount} lines${extractAction.destinationFile ? ` → ${extractAction.destinationFile}` : ''}`,
                        details: { 
                            path: extractAction.sourceFile,
                            lines: extractResult.lineCount
                        }
                    });

                    // If extracted without destination, add to filesContent so AI can see it
                    if (!extractAction.destinationFile && extractResult.content) {
                        filesContent.set(
                            `${extractAction.sourceFile}:${extractAction.startLine}-${extractAction.endLine}`,
                            extractResult.content
                        );
                    }

                    results.push({
                        action,
                        success: true,
                        content: extractResult.content,
                        metadata: { 
                            lines: extractResult.lineCount,
                            bytes: extractResult.content?.length || 0
                        }
                    });
                } else {
                    results.push({
                        action,
                        success: false,
                        error: extractResult.error || 'Extraction failed'
                    });
                }
            } catch (err: any) {
                results.push({
                    action,
                    success: false,
                    error: err.message
                });
            }
        } else if (action.type === 'request_content') {
            // AI is requesting content for a large file that was previously shown as metadata
            const requestAction = action as RequestContentAction;
            
            onProgress?.({
                type: 'file-start',
                message: `📥 AI requested ${requestAction.deliveryMethod} for: ${requestAction.filePath}`,
                details: { path: requestAction.filePath }
            });
            
            try {
                if (requestAction.deliveryMethod === 'chunk') {
                    // Load the file and let the chunking system handle it
                    const files = await findAndReadFiles(requestAction.filePath, 1);
                    if (files.length > 0) {
                        const file = files[0];
                        filesContent.set(file.path, file.content);
                        fileHashes.set(file.path, file.md5Hash);
                        
                        onProgress?.({
                            type: 'file-done',
                            message: `✅ Loaded for chunking: ${file.name} (${file.lineCount} lines)`,
                            details: { path: file.path, lines: file.lineCount }
                        });
                        
                        results.push({
                            action,
                            success: true,
                            content: file.content,
                            metadata: { lines: file.lineCount, bytes: file.content.length }
                        });
                    } else {
                        results.push({
                            action,
                            success: false,
                            error: `File not found: ${requestAction.filePath}`
                        });
                    }
                } else if (requestAction.deliveryMethod === 'analyze') {
                    // Run the analysis command
                    if (!requestAction.command) {
                        results.push({
                            action,
                            success: false,
                            error: 'No command specified for analyze delivery method'
                        });
                    } else {
                        const analysisResult = await executeLocalCommand(requestAction.command, onProgress);
                        if (analysisResult.success) {
                            onProgress?.({
                                type: 'file-done',
                                message: `✅ Analysis complete (${analysisResult.output?.split('\n').length || 0} lines output)`,
                                details: { path: requestAction.filePath }
                            });
                            results.push({
                                action,
                                success: true,
                                content: analysisResult.output,
                                metadata: { bytes: analysisResult.output?.length || 0 }
                            });
                        } else {
                            results.push({
                                action,
                                success: false,
                                error: analysisResult.error || 'Analysis failed'
                            });
                        }
                    }
                } else if (requestAction.deliveryMethod === 'extract') {
                    // Extract specific lines
                    if (!requestAction.startLine || !requestAction.endLine) {
                        results.push({
                            action,
                            success: false,
                            error: 'startLine and endLine required for extract delivery method'
                        });
                    } else {
                        const extractResult = await extractFileLines(
                            requestAction.filePath,
                            requestAction.startLine,
                            requestAction.endLine
                        );
                        if (extractResult.success) {
                            filesContent.set(
                                `${requestAction.filePath}:${requestAction.startLine}-${requestAction.endLine}`,
                                extractResult.content!
                            );
                            onProgress?.({
                                type: 'file-done',
                                message: `✅ Extracted lines ${requestAction.startLine}-${requestAction.endLine} (${extractResult.lineCount} lines)`,
                                details: { path: requestAction.filePath, lines: extractResult.lineCount }
                            });
                            results.push({
                                action,
                                success: true,
                                content: extractResult.content,
                                metadata: { lines: extractResult.lineCount, bytes: extractResult.content?.length || 0 }
                            });
                        } else {
                            results.push({
                                action,
                                success: false,
                                error: extractResult.error || 'Extraction failed'
                            });
                        }
                    }
                }
            } catch (err: any) {
                results.push({
                    action,
                    success: false,
                    error: err.message
                });
            }
        }
    }

    return { 
        execution: { 
            plan, 
            results, 
            filesContent, 
            fileHashes, 
            urlsContent,
            largeFileMetadata: largeFileMetadata.length > 0 ? largeFileMetadata : undefined
        },
        timeMs: Date.now() - startTime
    };
}

/**
 * Default whitelisted commands for local analysis.
 * These are safe read-only commands that don't modify files.
 */
const ANALYSIS_COMMAND_WHITELIST = [
    'grep', 'egrep', 'fgrep',  // Pattern searching
    'head', 'tail',             // Line extraction
    'wc',                       // Word/line counting
    'cat', 'less',              // File viewing (cat is limited by timeout)
    'sed -n',                   // Print-only sed (no in-place editing)
    'awk',                      // Text processing
    'cut',                      // Column extraction
    'sort', 'uniq',             // Sorting/deduplication
    'find',                     // File finding
    'ls', 'tree',               // Directory listing
    'python -c', 'python3 -c',  // Python one-liners
];

/**
 * Check if a command is safe for auto-execution.
 */
function isAnalysisCommandSafe(command: string): boolean {
    const cmdLower = command.trim().toLowerCase();
    
    // Block dangerous commands
    const dangerous = ['rm ', 'mv ', 'cp ', 'chmod', 'chown', 'sudo', '>', '>>', '|'];
    if (dangerous.some(d => cmdLower.includes(d))) {
        return false;
    }
    
    // Check if command starts with a whitelisted prefix
    return ANALYSIS_COMMAND_WHITELIST.some(prefix => 
        cmdLower.startsWith(prefix.toLowerCase())
    );
}

/**
 * Execute a local command for file analysis.
 * This uses the shell to run commands like grep, head, tail, wc, etc.
 * 
 * SECURITY: Only auto-executes safe analysis commands. Others require user approval.
 */
async function executeLocalCommand(
    command: string,
    onProgress?: (update: ProgressUpdate) => void,
    requireApproval: boolean = false
): Promise<{ success: boolean; output?: string; error?: string; skipped?: boolean }> {
    const vscode = await import('vscode');
    const { exec } = require('child_process');
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    
    // Check if command is safe for auto-execution
    if (!isAnalysisCommandSafe(command)) {
        onProgress?.({
            type: 'error',
            message: `⚠️ Command requires approval: ${command}`,
            details: {}
        });
        
        // Show approval dialog
        const action = await vscode.window.showWarningMessage(
            `AI wants to run analysis command:\n"${command}"`,
            'Run Once',
            'Add to Whitelist & Run',
            'Skip'
        );
        
        if (action === 'Skip' || !action) {
            return { success: false, error: 'Command skipped by user', skipped: true };
        }
        
        if (action === 'Add to Whitelist & Run') {
            // Add command prefix to user's CLI whitelist
            const config = vscode.workspace.getConfiguration('grok');
            const whitelist = config.get<string[]>('cliWhitelist', []);
            const cmdPrefix = command.split(' ')[0];
            if (!whitelist.includes(cmdPrefix)) {
                whitelist.push(cmdPrefix);
                await config.update('cliWhitelist', whitelist, vscode.ConfigurationTarget.Global);
                info(`Added "${cmdPrefix}" to CLI whitelist`);
            }
        }
    }
    
    return new Promise((resolve) => {
        exec(command, { cwd, maxBuffer: 1024 * 1024, timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
            if (error && !stdout) {
                resolve({ success: false, error: error.message || stderr });
            } else {
                resolve({ success: true, output: stdout || stderr });
            }
        });
    });
}

/**
 * Extract specific lines from a file.
 * Uses sed/head/tail for efficiency on large files.
 */
async function extractFileLines(
    sourceFile: string,
    startLine: number,
    endLine: number,
    destinationFile?: string
): Promise<{ success: boolean; content?: string; lineCount?: number; error?: string }> {
    const fs = await import('fs');
    const path = await import('path');
    const vscode = await import('vscode');
    
    try {
        // Resolve the file path
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = path.isAbsolute(sourceFile) ? sourceFile : path.join(workspaceRoot, sourceFile);
        
        // Read the file
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        
        // Extract the specified range (1-indexed)
        const start = Math.max(0, startLine - 1);
        const end = Math.min(lines.length, endLine);
        const extractedLines = lines.slice(start, end);
        const extractedContent = extractedLines.join('\n');
        
        // If destination specified, write the file
        if (destinationFile) {
            const destPath = path.isAbsolute(destinationFile) ? destinationFile : path.join(workspaceRoot, destinationFile);
            
            // Create directory if needed
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            
            fs.writeFileSync(destPath, extractedContent, 'utf8');
            info(`Extracted lines ${startLine}-${endLine} to ${destinationFile}`);
        }
        
        return {
            success: true,
            content: extractedContent,
            lineCount: extractedLines.length
        };
    } catch (err: any) {
        return {
            success: false,
            error: err.message
        };
    }
}

export interface AugmentedMessageResult {
    message: string;
    pendingChunks?: PendingChunks;
    chunkingInfo?: {
        filesChunked: number;
        totalChunks: number;
        currentChunkIndex: number;
    };
}

/**
 * Build the augmented message with all gathered context.
 * Now returns pending chunks for large file processing.
 */
export function buildAugmentedMessage(
    originalMessage: string,
    plan: AgentPlan,
    execution: ExecutionResult
): AugmentedMessageResult {
    let augmented = originalMessage;
    const pendingChunksMap: PendingChunks = {};

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

    // Add large file metadata (file awareness system)
    if (execution.largeFileMetadata && execution.largeFileMetadata.length > 0) {
        augmented += '\n\n---\n**📦 LARGE FILES DETECTED (Metadata Only - Request Content to Access):**\n';
        augmented += '⚠️ These files exceed 50KB. You have metadata + preview, NOT full content.\n';
        augmented += 'To access content, use nextSteps with a request_content action.\n\n';
        
        for (const meta of execution.largeFileMetadata) {
            const sizeKB = (meta.sizeBytes / 1024).toFixed(1);
            augmented += `### 📄 ${meta.path}\n`;
            augmented += `| Property | Value |\n`;
            augmented += `|----------|-------|\n`;
            augmented += `| Size | ${sizeKB}KB (${meta.lineCount} lines) |\n`;
            augmented += `| Language | ${meta.language} |\n`;
            augmented += `| MD5 Hash | ${meta.md5Hash} |\n`;
            
            // Add structure hints if available
            if (meta.structureHints) {
                if (meta.structureHints.classes?.length) {
                    augmented += `| Classes | ${meta.structureHints.classes.join(', ')} |\n`;
                }
                if (meta.structureHints.functions?.length) {
                    const funcs = meta.structureHints.functions.slice(0, 15).join(', ');
                    const more = meta.structureHints.functions.length > 15 ? ` (+${meta.structureHints.functions.length - 15} more)` : '';
                    augmented += `| Functions | ${funcs}${more} |\n`;
                }
                if (meta.structureHints.sections?.length) {
                    augmented += `| Sections | ${meta.structureHints.sections.join(', ')} |\n`;
                }
            }
            
            augmented += `\n**Preview (first ${METADATA_PREVIEW_LINES} lines):**\n\`\`\`${meta.language}\n${meta.preview}\n\`\`\`\n\n`;
            
            // Show how to request content
            augmented += `**To access this file's content, respond with nextSteps:**\n`;
            augmented += '```json\n';
            augmented += '// Option 1: Chunk the entire file to me\n';
            augmented += `{"nextSteps": [{"html": "Load ${meta.path.split('/').pop()} in chunks", "inputText": "request_content:chunk:${meta.path}"}]}\n\n`;
            augmented += '// Option 2: Run a local command to analyze (e.g., grep for patterns)\n';
            augmented += `{"nextSteps": [{"html": "Analyze ${meta.path.split('/').pop()}", "inputText": "request_content:analyze:${meta.path}:grep -n 'pattern' ${meta.path}"}]}\n\n`;
            augmented += '// Option 3: Extract specific line range\n';
            augmented += `{"nextSteps": [{"html": "Extract lines 100-200", "inputText": "request_content:extract:${meta.path}:100:200"}]}\n`;
            augmented += '```\n\n';
        }
    }

    // Add file contents with line numbers - WITH CHUNKING FOR LARGE FILES
    if (execution.filesContent.size > 0) {
        augmented += '\n\n---\n**Files from workspace (with line numbers and MD5 hashes - use these in fileHashes when modifying):**\n';
        
        const chunkedFiles: ChunkingResult[] = [];
        const regularFiles: { path: string; content: string; hash: string }[] = [];
        
        // Separate files into chunked and regular
        for (const [filePath, content] of execution.filesContent) {
            const hash = execution.fileHashes.get(filePath) || 'UNKNOWN';
            const lineCount = content.split('\n').length;
            const fileContent: FileContent = {
                path: filePath,
                relativePath: filePath,
                name: filePath.split('/').pop() || filePath,
                content,
                language: filePath.split('.').pop() || 'text',
                lineCount,
                md5Hash: hash
            };
            
            if (needsChunking(fileContent)) {
                const chunkResult = chunkFile(fileContent);
                chunkedFiles.push(chunkResult);
                info(`Large file chunked: ${filePath} -> ${chunkResult.chunks.length} chunks`);
            } else {
                regularFiles.push({ path: filePath, content, hash });
            }
        }
        
        // Add regular (small) files normally
        for (const file of regularFiles) {
            const numberedContent = addLineNumbers(file.content);
            augmented += `\n### ${file.path} [MD5: ${file.hash}]\n\`\`\`\n${numberedContent}\n\`\`\`\n`;
        }
        
        // Add chunked files - ONLY FIRST CHUNK with summary
        if (chunkedFiles.length > 0) {
            augmented += '\n\n---\n**📦 LARGE FILES (CHUNKED FOR PROCESSING):**\n';
            augmented += '⚠️ Files below exceed 50KB and have been split into chunks.\n';
            augmented += 'Process ONE chunk at a time. Use nextSteps to request the next chunk.\n\n';
            
            for (const chunkResult of chunkedFiles) {
                const firstChunk = chunkResult.chunks[0];
                augmented += createChunkSummary(chunkResult.chunks);
                augmented += '\n**CURRENT CHUNK (process this first):**\n';
                augmented += formatChunkForPrompt(firstChunk);
                augmented += '\n';
                
                // Store remaining chunks for later retrieval
                if (chunkResult.chunks.length > 1) {
                    const remaining = chunkResult.chunks.length - 1;
                    pendingChunksMap[chunkResult.originalFile.path] = chunkResult.chunks.slice(1);
                    augmented += `\n**${remaining} more chunk(s) pending.** After processing this chunk, respond with:\n`;
                    augmented += '```json\n{"nextSteps": [{"html": "Continue to chunk 2", "inputText": "continue with next chunk"}]}\n```\n';
                }
            }
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

    // Calculate chunking info
    const hasPendingChunks = Object.keys(pendingChunksMap).length > 0;
    const totalChunks = Object.values(pendingChunksMap).reduce((sum, chunks) => sum + chunks.length + 1, 0);
    
    return {
        message: augmented,
        pendingChunks: hasPendingChunks ? pendingChunksMap : undefined,
        chunkingInfo: hasPendingChunks ? {
            filesChunked: Object.keys(pendingChunksMap).length,
            totalChunks,
            currentChunkIndex: 0
        } : undefined
    };
}

/** Context accumulated from processing previous chunks */
export interface ChunkProcessingContext {
    /** File changes extracted from previous chunks */
    extractedChanges: { path: string; description: string }[];
    /** Summary of what was done in previous chunks */
    previousSummaries: string[];
    /** Current chunk being processed (1-indexed) */
    currentChunkNumber: number;
    /** Total chunks for the file */
    totalChunks: number;
}

/** Pending chunks that need to be processed in subsequent turns */
export interface PendingChunks {
    /** File path -> remaining chunks (after first chunk was sent) */
    [filePath: string]: FileChunk[];
}

/** Full chunking state including context */
export interface ChunkingState {
    /** Pending chunks to process */
    pendingChunks: PendingChunks;
    /** Accumulated context from previous chunks */
    context: ChunkProcessingContext;
}

export interface AgentWorkflowResult {
    augmentedMessage: string;
    filesLoaded: FileContent[];
    urlsLoaded: number;
    skipped: boolean;
    plan?: AgentPlan;
    /** Chunks waiting to be processed (for large files) */
    pendingChunks?: PendingChunks;
    /** Info about which files were chunked */
    chunkingInfo?: {
        filesChunked: number;
        totalChunks: number;
        currentChunkIndex: number;
    };
    /** Metadata for large files (>50KB) - content not loaded, AI must request */
    largeFileMetadata?: FileMetadata[];
    stepMetrics: {
        planning: { timeMs: number; tokensIn: number; tokensOut: number };
        execute: { timeMs: number };
    };
}

/**
 * Get the next chunk for a file that's being processed in chunks.
 * Returns the formatted chunk ready to include in the next message.
 * 
 * @param pendingChunks - Remaining chunks to process
 * @param previousContext - Context from previous chunk processing (summaries, changes found)
 */
export function getNextChunk(
    pendingChunks: PendingChunks, 
    previousContext?: ChunkProcessingContext
): {
    hasMore: boolean;
    chunkMessage: string;
    updatedPendingChunks: PendingChunks;
    currentChunk?: FileChunk;
    updatedContext?: ChunkProcessingContext;
} {
    const filePaths = Object.keys(pendingChunks);
    if (filePaths.length === 0) {
        return {
            hasMore: false,
            chunkMessage: '',
            updatedPendingChunks: {}
        };
    }

    // Get the first file with pending chunks
    const filePath = filePaths[0];
    const chunks = pendingChunks[filePath];
    
    if (!chunks || chunks.length === 0) {
        // No more chunks for this file, remove it and try next
        const { [filePath]: _, ...rest } = pendingChunks;
        return getNextChunk(rest, previousContext);
    }

    const [nextChunk, ...remainingChunks] = chunks;
    
    // Build the chunk message with context from previous chunks
    let message = `\n\n---\n**📦 CONTINUING LARGE FILE - CHUNK ${nextChunk.chunkIndex + 1}/${nextChunk.totalChunks}:**\n`;
    
    // CRITICAL: Include context from previous chunks so AI doesn't lose track
    if (previousContext && previousContext.previousSummaries.length > 0) {
        message += `\n**📋 CONTEXT FROM PREVIOUS CHUNKS (DO NOT RE-REQUEST THIS DATA):**\n`;
        previousContext.previousSummaries.forEach((summary, i) => {
            message += `- Chunk ${i + 1}: ${summary}\n`;
        });
        
        if (previousContext.extractedChanges.length > 0) {
            message += `\n**Already planned/extracted:**\n`;
            previousContext.extractedChanges.forEach(change => {
                message += `- ${change.path}: ${change.description}\n`;
            });
        }
        message += `\n**Continue from where you left off. Build on the work done in previous chunks.**\n\n`;
    }
    
    message += formatChunkForPrompt(nextChunk);
    
    const moreChunksForFile = remainingChunks.length;
    const moreFiles = filePaths.length - 1;
    
    if (moreChunksForFile > 0) {
        message += `\n\n**${moreChunksForFile} more chunk(s) for this file.** After processing this chunk:\n`;
        message += `1. Make any file changes for THIS chunk's content\n`;
        message += `2. Summarize what you found/did in this chunk\n`;
        message += `3. Respond with nextSteps to continue\n`;
        message += '```json\n{"nextSteps": [{"html": "Continue to next chunk", "inputText": "continue with next chunk"}]}\n```\n';
    } else if (moreFiles > 0) {
        message += `\n\n**This file complete. ${moreFiles} more file(s) with pending chunks.**\n`;
    } else {
        message += `\n\n**✅ This is the FINAL chunk. Now provide ALL remaining file changes and complete the task.**\n`;
        message += `You have seen the entire file across all chunks. Provide the final implementation.\n`;
    }

    // Update pending chunks
    const updatedPendingChunks: PendingChunks = { ...pendingChunks };
    if (remainingChunks.length > 0) {
        updatedPendingChunks[filePath] = remainingChunks;
    } else {
        delete updatedPendingChunks[filePath];
    }

    // Update context for next iteration
    const updatedContext: ChunkProcessingContext = {
        extractedChanges: previousContext?.extractedChanges || [],
        previousSummaries: previousContext?.previousSummaries || [],
        currentChunkNumber: nextChunk.chunkIndex + 1,
        totalChunks: nextChunk.totalChunks
    };

    return {
        hasMore: Object.keys(updatedPendingChunks).length > 0 || remainingChunks.length > 0,
        chunkMessage: message,
        updatedPendingChunks,
        currentChunk: nextChunk,
        updatedContext
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

    // Build augmented message (now handles chunking internally)
    const augmentedResult = buildAugmentedMessage(userMessage, plan, execution);
    
    const totalFiles = execution.filesContent.size;
    const totalUrls = execution.urlsContent.size;
    
    // Report chunking if applicable
    if (augmentedResult.chunkingInfo) {
        onProgress?.(`📦 Large file(s) chunked: ${augmentedResult.chunkingInfo.filesChunked} file(s) -> ${augmentedResult.chunkingInfo.totalChunks} chunks`);
    }
    
    if (totalFiles > 0 || totalUrls > 0) {
        onProgress?.(`✅ Ready: ${totalFiles} file(s), ${totalUrls} URL(s) loaded`);
    }
    
    // Report large files with metadata only
    if (execution.largeFileMetadata && execution.largeFileMetadata.length > 0) {
        onProgress?.(`📊 Large file(s) detected: ${execution.largeFileMetadata.length} file(s) - metadata only, AI must request content`);
    }

    return {
        augmentedMessage: augmentedResult.message,
        filesLoaded,
        urlsLoaded: totalUrls,
        skipped: false,
        plan,
        pendingChunks: augmentedResult.pendingChunks,
        chunkingInfo: augmentedResult.chunkingInfo,
        largeFileMetadata: execution.largeFileMetadata,
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
        // Get patterns to try (use patterns array or fall back to single pattern)
        const patternsToTry = fileAction.patterns?.length 
            ? fileAction.patterns 
            : (fileAction.pattern ? [fileAction.pattern] : []);
        
        if (patternsToTry.length === 0) {
            continue;
        }
        
        let files: FileContent[] = [];
        
        // Try each pattern in order until one succeeds
        for (const pattern of patternsToTry) {
            onProgress?.(`🔍 Finding: ${pattern}`);
            
            const foundFiles = await findAndReadFiles(pattern, 10);
            
            if (foundFiles.length > 0) {
                files = foundFiles;
                break; // Stop trying patterns
            }
        }
        
        if (files.length === 0) {
            onProgress?.(`⚠️ No files found: ${patternsToTry.join(', ')}`);
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
