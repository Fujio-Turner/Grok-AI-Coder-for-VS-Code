/**
 * xAI Files API Client
 * 
 * Handles uploading files to xAI's server-side storage for use with
 * the document_search agentic tool. Files persist across conversation turns.
 * 
 * @see https://docs.x.ai/docs/guides/files
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { createScopedLogger } from '../utils/logger';

const log = createScopedLogger('FileUploader');

export interface UploadedFile {
    id: string;
    filename: string;
    size: number;
    createdAt: string;
    localPath?: string;
}

export interface FileUploadResult {
    success: boolean;
    file?: UploadedFile;
    error?: string;
}

export interface FileListResponse {
    data: UploadedFile[];
    hasMore: boolean;
    nextToken?: string;
}

/**
 * Upload a file to xAI Files API
 */
export async function uploadFile(
    filePath: string,
    apiKey: string,
    onProgress?: (bytesUploaded: number, totalBytes: number) => void
): Promise<FileUploadResult> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const maxSize = config.get<number>('maxUploadSize') || 10485760; // 10MB default
    
    try {
        // Read file content
        const uri = vscode.Uri.file(filePath);
        const content = await vscode.workspace.fs.readFile(uri);
        const filename = path.basename(filePath);
        
        // Check file size
        if (content.length > maxSize) {
            return {
                success: false,
                error: `File too large: ${(content.length / 1024 / 1024).toFixed(2)}MB exceeds limit of ${(maxSize / 1024 / 1024).toFixed(2)}MB`
            };
        }
        
        // Check file size against xAI limit (48MB)
        if (content.length > 48 * 1024 * 1024) {
            return {
                success: false,
                error: `File exceeds xAI limit of 48MB`
            };
        }
        
        log.info(`Uploading file: ${filename} (${(content.length / 1024).toFixed(1)}KB)`);
        
        // Create form data - Node.js compatible approach
        const boundary = `----FormBoundary${Date.now()}`;
        const contentType = getContentType(filename);
        
        // Build multipart body manually
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        
        const headerBytes = new TextEncoder().encode(header);
        const footerBytes = new TextEncoder().encode(footer);
        
        // Combine into single buffer
        const body = new Uint8Array(headerBytes.length + content.length + footerBytes.length);
        body.set(headerBytes, 0);
        body.set(content, headerBytes.length);
        body.set(footerBytes, headerBytes.length + content.length);
        
        const response = await fetch(`${baseUrl}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            log.error(`File upload failed: ${response.status}`, { error: errorText });
            return {
                success: false,
                error: `Upload failed: ${response.status} - ${errorText}`
            };
        }
        
        const rawResponse = await response.text();
        log.info(`File upload raw response: ${rawResponse}`);
        
        let data: { id: string; filename: string; size: number; created_at: string };
        try {
            data = JSON.parse(rawResponse);
        } catch (parseErr) {
            log.error(`Failed to parse file upload response: ${rawResponse}`);
            return {
                success: false,
                error: `Invalid JSON response from Files API: ${rawResponse.substring(0, 200)}`
            };
        }
        
        if (!data.id) {
            log.error(`File upload response missing 'id' field:`, data);
            return {
                success: false,
                error: `Files API did not return a file ID. Response: ${JSON.stringify(data)}`
            };
        }
        
        const uploadedFile: UploadedFile = {
            id: data.id,
            filename: data.filename,
            size: data.size,
            createdAt: data.created_at,
            localPath: filePath
        };
        
        log.info(`File uploaded successfully: ${filename} -> ${data.id} (full response: ${rawResponse})`);
        
        return {
            success: true,
            file: uploadedFile
        };
        
    } catch (err: any) {
        log.error(`File upload exception: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
}

/**
 * Upload file content directly (bytes)
 */
export async function uploadFileContent(
    content: Uint8Array,
    filename: string,
    apiKey: string
): Promise<FileUploadResult> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    
    try {
        log.info(`Uploading content as: ${filename} (${(content.length / 1024).toFixed(1)}KB)`);
        
        const boundary = `----FormBoundary${Date.now()}`;
        const contentType = getContentType(filename);
        
        const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
        const footer = `\r\n--${boundary}--\r\n`;
        
        const headerBytes = new TextEncoder().encode(header);
        const footerBytes = new TextEncoder().encode(footer);
        
        const body = new Uint8Array(headerBytes.length + content.length + footerBytes.length);
        body.set(headerBytes, 0);
        body.set(content, headerBytes.length);
        body.set(footerBytes, headerBytes.length + content.length);
        
        const response = await fetch(`${baseUrl}/files`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: body
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `Upload failed: ${response.status} - ${errorText}` };
        }
        
        const data = await response.json() as {
            id: string;
            filename: string;
            size: number;
            created_at: string;
        };
        
        return {
            success: true,
            file: {
                id: data.id,
                filename: data.filename,
                size: data.size,
                createdAt: data.created_at
            }
        };
        
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

/**
 * Delete a file from xAI
 */
export async function deleteFile(fileId: string, apiKey: string): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    
    try {
        const response = await fetch(`${baseUrl}/files/${fileId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        
        if (response.ok) {
            log.info(`Deleted file: ${fileId}`);
            return true;
        } else {
            log.warn(`Failed to delete file ${fileId}: ${response.status}`);
            return false;
        }
    } catch (err: any) {
        log.error(`Delete file exception: ${err.message}`);
        return false;
    }
}

/**
 * List uploaded files
 */
export async function listFiles(
    apiKey: string,
    limit: number = 100
): Promise<FileListResponse> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    
    try {
        const response = await fetch(`${baseUrl}/files?limit=${limit}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        
        if (!response.ok) {
            log.error(`Failed to list files: ${response.status}`);
            return { data: [], hasMore: false };
        }
        
        const data = await response.json() as {
            data: Array<{
                id: string;
                filename: string;
                size: number;
                created_at: string;
            }>;
            has_more?: boolean;
            next_page_token?: string;
        };
        
        return {
            data: (data.data || []).map(f => ({
                id: f.id,
                filename: f.filename,
                size: f.size,
                createdAt: f.created_at
            })),
            hasMore: data.has_more || false,
            nextToken: data.next_page_token
        };
        
    } catch (err: any) {
        log.error(`List files exception: ${err.message}`);
        return { data: [], hasMore: false };
    }
}

/**
 * Get file metadata
 */
export async function getFileMetadata(
    fileId: string,
    apiKey: string
): Promise<UploadedFile | null> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    
    try {
        const response = await fetch(`${baseUrl}/files/${fileId}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json() as {
            id: string;
            filename: string;
            size: number;
            created_at: string;
        };
        
        return {
            id: data.id,
            filename: data.filename,
            size: data.size,
            createdAt: data.created_at
        };
        
    } catch {
        return null;
    }
}

/**
 * Delete multiple files (cleanup helper)
 */
export async function deleteFiles(fileIds: string[], apiKey: string): Promise<number> {
    let deleted = 0;
    for (const id of fileIds) {
        if (await deleteFile(id, apiKey)) {
            deleted++;
        }
    }
    log.info(`Cleaned up ${deleted}/${fileIds.length} files`);
    return deleted;
}

/**
 * Check if a file still exists on xAI servers.
 * Returns true if file exists and is accessible.
 */
export async function fileExists(fileId: string, apiKey: string): Promise<boolean> {
    const metadata = await getFileMetadata(fileId, apiKey);
    return metadata !== null;
}

/**
 * Rehydrate a file - re-upload if it doesn't exist on xAI servers.
 * Used when returning to a session where files may have been cleaned up.
 * 
 * @param localPath - Local workspace path to the file
 * @param existingFileId - Previous file ID (to check if still valid)
 * @param apiKey - xAI API key
 * @returns FileUploadResult with new file_id, or existing if still valid
 */
export async function rehydrateFile(
    localPath: string,
    existingFileId: string | undefined,
    apiKey: string
): Promise<FileUploadResult> {
    // Check if existing file is still valid
    if (existingFileId) {
        const exists = await fileExists(existingFileId, apiKey);
        if (exists) {
            log.info(`File still exists on xAI: ${existingFileId}`);
            
            // Return as if it was just uploaded
            const metadata = await getFileMetadata(existingFileId, apiKey);
            if (metadata) {
                return {
                    success: true,
                    file: {
                        ...metadata,
                        localPath
                    }
                };
            }
        }
        log.info(`File expired/deleted on xAI, re-uploading: ${localPath}`);
    }
    
    // File doesn't exist or no previous ID - upload fresh
    return uploadFile(localPath, apiKey);
}

/**
 * Get content type for file
 */
function getContentType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.py': 'text/x-python',
        '.java': 'text/x-java',
        '.c': 'text/x-c',
        '.cpp': 'text/x-c++',
        '.h': 'text/x-c',
        '.cs': 'text/x-csharp',
        '.go': 'text/x-go',
        '.rs': 'text/x-rust',
        '.rb': 'text/x-ruby',
        '.php': 'text/x-php',
        '.swift': 'text/x-swift',
        '.kt': 'text/x-kotlin',
        '.scala': 'text/x-scala',
        '.html': 'text/html',
        '.css': 'text/css',
        '.xml': 'text/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.sql': 'text/x-sql',
        '.sh': 'text/x-sh',
        '.bash': 'text/x-sh',
        '.csv': 'text/csv',
        '.pdf': 'application/pdf'
    };
    return mimeTypes[ext] || 'text/plain';
}
