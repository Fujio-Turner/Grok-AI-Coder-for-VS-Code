/**
 * Workspace file utilities for finding and reading files.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { debug, info } from '../utils/logger';

export interface FileMatch {
    path: string;
    relativePath: string;
    name: string;
}

export interface FileContent {
    path: string;
    relativePath: string;
    name: string;
    content: string;
    language: string;
    lineCount: number;
}

/**
 * Find files matching a glob pattern in the workspace.
 */
export async function findFiles(pattern: string, maxResults: number = 20): Promise<FileMatch[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    debug(`Finding files matching: ${pattern}`);
    
    try {
        const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', maxResults);
        
        const matches: FileMatch[] = uris.map(uri => ({
            path: uri.fsPath,
            relativePath: vscode.workspace.asRelativePath(uri),
            name: path.basename(uri.fsPath)
        }));

        info(`Found ${matches.length} files matching ${pattern}`);
        return matches;
    } catch (error) {
        debug(`Error finding files: ${error}`);
        return [];
    }
}

/**
 * Read file contents.
 */
export async function readFile(filePath: string): Promise<FileContent | null> {
    try {
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        
        return {
            path: filePath,
            relativePath: vscode.workspace.asRelativePath(uri),
            name: path.basename(filePath),
            content: document.getText(),
            language: document.languageId,
            lineCount: document.lineCount
        };
    } catch (error) {
        debug(`Error reading file ${filePath}: ${error}`);
        return null;
    }
}

/**
 * Read multiple files.
 */
export async function readFiles(filePaths: string[]): Promise<FileContent[]> {
    const results: FileContent[] = [];
    
    for (const filePath of filePaths) {
        const content = await readFile(filePath);
        if (content) {
            results.push(content);
        }
    }
    
    return results;
}

/**
 * Find and read files matching a pattern.
 */
export async function findAndReadFiles(pattern: string, maxResults: number = 10): Promise<FileContent[]> {
    const matches = await findFiles(pattern, maxResults);
    const filePaths = matches.map(m => m.path);
    return readFiles(filePaths);
}

/**
 * Format file contents for inclusion in a prompt.
 */
export function formatFilesForPrompt(files: FileContent[]): string {
    if (files.length === 0) {
        return 'No matching files found.';
    }

    return files.map(file => {
        return `## File: ${file.relativePath}\n\`\`\`${file.language}\n${file.content}\n\`\`\``;
    }).join('\n\n');
}

/**
 * Get summary of files (for display).
 */
export function getFilesSummary(files: FileContent[]): string {
    if (files.length === 0) {
        return 'No files found';
    }
    
    const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
    return `${files.length} file(s), ${totalLines} lines total`;
}
