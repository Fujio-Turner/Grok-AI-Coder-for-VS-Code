/**
 * Agent Orchestrator - Two-pass workflow for intelligent file handling.
 * 
 * Pass 1: Fast model analyzes request to determine if files are needed
 * Pass 2: If files needed, find/read them and include in main request
 */

import * as vscode from 'vscode';
import { sendChatCompletion, GrokMessage } from '../api/grokClient';
import { findAndReadFiles, formatFilesForPrompt, getFilesSummary, FileContent } from './workspaceFiles';
import { debug, info } from '../utils/logger';

export interface FileRequest {
    patterns: string[];
    reason: string;
}

export interface AgentAnalysis {
    needsFiles: boolean;
    fileRequest?: FileRequest;
    canAnswerDirectly: boolean;
}

export interface AgentResult {
    filesFound: FileContent[];
    filesSummary: string;
    augmentedPrompt: string;
}

/**
 * System prompt for the fast model to analyze if files are needed.
 */
const ANALYSIS_PROMPT = `You are a code assistant analyzer. Your job is to determine if the user's request requires reading files from their workspace.

Analyze the user's message and respond with ONLY valid JSON in this exact format:
{
    "needsFiles": true/false,
    "filePatterns": ["pattern1", "pattern2"],
    "reason": "brief explanation"
}

Rules:
- Set needsFiles=true if the user mentions specific files, file patterns, or asks to review/analyze code
- Use glob patterns for filePatterns (e.g., "**/06_read_*.py", "src/**/*.ts")
- Keep filePatterns empty [] if needsFiles is false
- Be conservative - only request files that are clearly needed

Examples:
User: "Review the 06_read_*.py files"
{"needsFiles":true,"filePatterns":["**/06_read_*.py"],"reason":"User explicitly asked to review files matching this pattern"}

User: "How do I create a REST API?"
{"needsFiles":false,"filePatterns":[],"reason":"General question, no specific files mentioned"}

User: "Check the auth middleware for security issues"
{"needsFiles":true,"filePatterns":["**/auth*","**/middleware*"],"reason":"User wants to review auth middleware code"}

User: "What's in my config files?"
{"needsFiles":true,"filePatterns":["**/*.config.*","**/config.*","**/.env*"],"reason":"User asking about configuration files"}

Respond with ONLY the JSON, no other text.`;

/**
 * Analyze user request to determine if files are needed.
 */
export async function analyzeRequest(
    userMessage: string,
    apiKey: string,
    fastModel: string
): Promise<AgentAnalysis> {
    debug('Analyzing request for file requirements...');
    
    const messages: GrokMessage[] = [
        { role: 'system', content: ANALYSIS_PROMPT },
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

        const text = response.text.trim();
        debug('Analysis response:', text);

        // Try to parse the JSON response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            
            return {
                needsFiles: parsed.needsFiles === true,
                fileRequest: parsed.needsFiles ? {
                    patterns: parsed.filePatterns || [],
                    reason: parsed.reason || ''
                } : undefined,
                canAnswerDirectly: !parsed.needsFiles
            };
        }
    } catch (error) {
        debug('Analysis failed, proceeding without files:', error);
    }

    // Default: don't need files
    return {
        needsFiles: false,
        canAnswerDirectly: true
    };
}

/**
 * Find and prepare files based on analysis.
 */
export async function prepareFiles(
    fileRequest: FileRequest,
    onProgress?: (message: string) => void
): Promise<AgentResult> {
    const allFiles: FileContent[] = [];
    
    for (const pattern of fileRequest.patterns) {
        onProgress?.(`Searching for ${pattern}...`);
        const files = await findAndReadFiles(pattern, 5);
        allFiles.push(...files);
    }

    // Deduplicate by path
    const uniqueFiles = allFiles.filter((file, index, self) =>
        index === self.findIndex(f => f.path === file.path)
    );

    const summary = getFilesSummary(uniqueFiles);
    const formattedContent = formatFilesForPrompt(uniqueFiles);

    info(`Prepared ${uniqueFiles.length} files for context`);

    return {
        filesFound: uniqueFiles,
        filesSummary: summary,
        augmentedPrompt: formattedContent
    };
}

/**
 * Create augmented user message with file contents.
 */
export function createAugmentedMessage(
    originalMessage: string,
    files: FileContent[]
): string {
    if (files.length === 0) {
        return originalMessage + '\n\n(Note: No matching files were found in the workspace.)';
    }

    const fileContent = formatFilesForPrompt(files);
    
    return `${originalMessage}

---
**Files from workspace:**

${fileContent}

---
Please analyze the above files and respond to the user's request.`;
}

/**
 * Full two-pass agent workflow.
 */
export async function runAgentWorkflow(
    userMessage: string,
    apiKey: string,
    fastModel: string,
    onProgress?: (message: string) => void
): Promise<{ augmentedMessage: string; filesLoaded: FileContent[]; skipped: boolean }> {
    
    // Pass 1: Analyze if files are needed
    onProgress?.('Analyzing request...');
    const analysis = await analyzeRequest(userMessage, apiKey, fastModel);
    
    if (!analysis.needsFiles || !analysis.fileRequest) {
        debug('No files needed, proceeding directly');
        return {
            augmentedMessage: userMessage,
            filesLoaded: [],
            skipped: true
        };
    }

    info(`Files needed: ${analysis.fileRequest.patterns.join(', ')}`);
    onProgress?.(`Finding files: ${analysis.fileRequest.patterns.join(', ')}`);

    // Pass 2: Find and read files
    const result = await prepareFiles(analysis.fileRequest, onProgress);
    
    if (result.filesFound.length === 0) {
        onProgress?.('No matching files found');
        return {
            augmentedMessage: userMessage + '\n\n(Note: I searched but found no files matching the patterns. Please check the file names or paths.)',
            filesLoaded: [],
            skipped: false
        };
    }

    onProgress?.(`Loaded ${result.filesSummary}`);

    const augmented = createAugmentedMessage(userMessage, result.filesFound);
    
    return {
        augmentedMessage: augmented,
        filesLoaded: result.filesFound,
        skipped: false
    };
}
