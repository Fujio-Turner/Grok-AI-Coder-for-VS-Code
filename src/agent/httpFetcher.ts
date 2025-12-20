/**
 * HTTP Fetcher for retrieving URL content.
 * Used by the agent to fetch documentation, API references, etc.
 */

import { debug, info, error as logError } from '../utils/logger';

export interface FetchResult {
    success: boolean;
    content?: string;
    error?: string;
    contentType?: string;
    bytes?: number;
}

const MAX_CONTENT_SIZE = 100 * 1024; // 100KB max
const FETCH_TIMEOUT = 10000; // 10 seconds

/**
 * Fetch content from a URL with timeout and size limits.
 */
export async function fetchUrl(url: string): Promise<FetchResult> {
    debug('Fetching URL:', url);
    
    try {
        // Validate URL
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            return { success: false, error: 'Only HTTP/HTTPS URLs supported' };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Grok-AI-Coder/1.0 (VS Code Extension)',
                'Accept': 'text/html,text/plain,application/json,*/*'
            }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return { 
                success: false, 
                error: `HTTP ${response.status}: ${response.statusText}` 
            };
        }

        const contentType = response.headers.get('content-type') || 'text/plain';
        
        // Read with size limit
        const reader = response.body?.getReader();
        if (!reader) {
            return { success: false, error: 'No response body' };
        }

        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            totalBytes += value.length;
            if (totalBytes > MAX_CONTENT_SIZE) {
                reader.cancel();
                break;
            }
            chunks.push(value);
        }

        const decoder = new TextDecoder();
        let content = chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('');
        content += decoder.decode(); // Flush

        // If HTML, try to extract main content
        if (contentType.includes('html')) {
            content = extractTextFromHtml(content);
        }

        info(`Fetched ${url}: ${totalBytes} bytes`);

        return {
            success: true,
            content: content.substring(0, MAX_CONTENT_SIZE),
            contentType,
            bytes: totalBytes
        };

    } catch (err: any) {
        if (err.name === 'AbortError') {
            return { success: false, error: 'Request timed out' };
        }
        logError('Fetch failed:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Extract readable text from HTML, removing scripts, styles, nav, etc.
 */
function extractTextFromHtml(html: string): string {
    // Remove script and style tags with content
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');

    // Extract content from article or main if present
    const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    
    if (articleMatch) {
        text = articleMatch[1];
    } else if (mainMatch) {
        text = mainMatch[1];
    }

    // Convert headers to markdown-style
    text = text
        .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
        .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
        .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
        .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n');

    // Convert code blocks
    text = text
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
        .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

    // Convert lists
    text = text
        .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
        .replace(/<\/?[ou]l[^>]*>/gi, '\n');

    // Convert paragraphs and line breaks
    text = text
        .replace(/<p[^>]*>/gi, '\n\n')
        .replace(/<\/p>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n');

    // Remove all remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&hellip;/g, '...')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–');

    // Clean up whitespace
    text = text
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();

    return text;
}

/**
 * Check if a string looks like a URL.
 */
export function isUrl(text: string): boolean {
    try {
        const url = new URL(text);
        return ['http:', 'https:'].includes(url.protocol);
    } catch {
        return false;
    }
}

/**
 * Extract URLs from text.
 */
export function extractUrls(text: string): string[] {
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const matches = text.match(urlPattern) || [];
    return [...new Set(matches)]; // Deduplicate
}
