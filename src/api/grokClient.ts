import * as vscode from 'vscode';
import { createScopedLogger } from '../utils/logger';
import { optimizeMessageContent, getToonSystemPromptAddition } from '../utils/toonConverter';

const log = createScopedLogger('GrokAPI');

export interface GrokMessageContent {
    type: 'text' | 'image_url' | 'file';
    text?: string;
    image_url?: { url: string };
    /** xAI Files API file reference for document_search */
    file?: { file_id: string };
}

export interface GrokMessage {
    role: 'system' | 'user' | 'assistant';
    content: string | GrokMessageContent[];
}

export interface GrokUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface GrokResponse {
    text: string;
    usage?: GrokUsage;
    /** Why the response stopped: 'stop' (normal), 'length' (hit token limit = TRUNCATED), 'end_turn' */
    finishReason?: 'stop' | 'length' | 'end_turn' | string;
}

/**
 * Create a multimodal message with text and images for vision models.
 */
export function createVisionMessage(text: string, imageBase64Array: string[]): GrokMessage {
    const content: GrokMessageContent[] = [
        { type: 'text', text }
    ];
    
    for (const imageBase64 of imageBase64Array) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imageBase64}` }
        });
    }
    
    return { role: 'user', content };
}

/**
 * Create a message with file attachments for document_search.
 * Files must be pre-uploaded to xAI Files API.
 * 
 * @param text The user's message text
 * @param fileIds Array of file IDs from xAI Files API
 * @param imageBase64Array Optional images to include
 */
export function createFileMessage(
    text: string, 
    fileIds: string[], 
    imageBase64Array?: string[]
): GrokMessage {
    const content: GrokMessageContent[] = [];
    
    // Add file references first (triggers document_search)
    // xAI REST API format: {"type": "file", "file": {"file_id": "..."}}
    for (const fileId of fileIds) {
        content.push({
            type: 'file',
            file: { file_id: fileId }
        });
    }
    
    // Add images if present
    if (imageBase64Array) {
        for (const imageBase64 of imageBase64Array) {
            content.push({
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${imageBase64}` }
            });
        }
    }
    
    // Add text last
    content.push({ type: 'text', text });
    
    return { role: 'user', content };
}

export interface ChatCompletionOptions {
    signal?: AbortSignal;
    onChunk?: (chunk: string) => void;
    /** 
     * JSON Schema for structured outputs. When provided, API guarantees response matches schema.
     * @see https://docs.x.ai/docs/guides/structured-outputs
     */
    responseFormat?: object;
}

export async function sendChatCompletion(
    messages: GrokMessage[],
    model: string,
    apiKey: string,
    signalOrOptions?: AbortSignal | ChatCompletionOptions,
    onChunk?: (chunk: string) => void
): Promise<GrokResponse> {
    // Handle both old signature (signal, onChunk) and new options object
    let options: ChatCompletionOptions = {};
    if (signalOrOptions instanceof AbortSignal) {
        options = { signal: signalOrOptions, onChunk };
    } else if (signalOrOptions) {
        options = signalOrOptions;
    } else if (onChunk) {
        options = { onChunk };
    }
    
    const { signal, onChunk: chunkCallback, responseFormat } = options;
    
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const timeoutSeconds = config.get<number>('apiTimeout') || 300;
    const requestFormat = config.get<string>('requestFormat') || 'json';

    // Apply TOON optimization for requests if enabled
    let optimizedMessages = messages;
    if (requestFormat === 'toon') {
        optimizedMessages = messages.map(msg => {
            if (msg.role === 'system') {
                // Add TOON understanding to system prompt
                const systemContent = typeof msg.content === 'string' 
                    ? msg.content + getToonSystemPromptAddition()
                    : msg.content;
                return { ...msg, content: systemContent };
            }
            // Optimize user message content
            return { ...msg, content: optimizeMessageContent(msg.content) };
        });
    }

    log.info(`Sending request to ${model}`, { 
        messageCount: messages.length, 
        streaming: !!chunkCallback,
        baseUrl,
        timeoutSeconds,
        requestFormat,
        structuredOutput: !!responseFormat
    });

    const startTime = Date.now();

    // Combine user abort signal with timeout
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const combinedSignal = signal 
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    // Get max output tokens from config (default 16384 to prevent truncation)
    const maxOutputTokens = config.get<number>('maxOutputTokens') || 16384;
    
    // Build request body
    const requestBody: Record<string, unknown> = {
        model,
        messages: optimizedMessages.map(m => ({ role: m.role, content: m.content })),
        max_tokens: maxOutputTokens,
        stream: !!chunkCallback,
        stream_options: chunkCallback ? { include_usage: true } : undefined
    };
    
    // Add structured output schema if provided (guarantees valid JSON response)
    if (responseFormat) {
        requestBody.response_format = responseFormat;
        log.info('Using structured outputs - API will guarantee schema compliance');
    }
    
    // Debug: Log the full request body for diagnosing 500 errors
    const requestBodyJson = JSON.stringify(requestBody, null, 2);
    log.info(`Chat completion request body:\n${requestBodyJson.substring(0, 5000)}`);
    
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: combinedSignal
    });

    if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `API error: ${response.status}`;
        
        // Log full error response for debugging 500 errors
        log.error(`Full API error response body: ${errorBody}`);
        
        try {
            const errorJson = JSON.parse(errorBody);
            errorMessage = errorJson.error?.message || errorMessage;
            log.error(`Parsed error details:`, errorJson);
        } catch {
            if (errorBody) {
                errorMessage = errorBody;
            }
        }

        log.error(`API request failed`, { 
            status: response.status, 
            model, 
            error: errorMessage,
            durationMs: Date.now() - startTime,
            requestBodyPreview: requestBodyJson.substring(0, 1000)
        });

        if (response.status === 401) {
            throw new Error('Invalid API key. Please run "Grok: Set API Key" to update.');
        }
        if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please wait and try again.');
        }
        
        throw new Error(errorMessage);
    }

    // Handle streaming response
    if (chunkCallback && response.body) {
        let fullText = '';
        let usage: GrokUsage | undefined;
        let finishReason: string | undefined;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            
                            // Check for error in stream
                            if (parsed.error) {
                                log.error('Stream error from API:', parsed.error);
                                throw new Error(parsed.error.message || JSON.stringify(parsed.error));
                            }
                            
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullText += delta;
                                chunkCallback(delta);
                            }
                            
                            // Capture finish_reason (indicates why response stopped)
                            const reason = parsed.choices?.[0]?.finish_reason;
                            if (reason) {
                                finishReason = reason;
                            }
                            
                            // Capture usage if present
                            if (parsed.usage) {
                                usage = {
                                    promptTokens: parsed.usage.prompt_tokens || 0,
                                    completionTokens: parsed.usage.completion_tokens || 0,
                                    totalTokens: parsed.usage.total_tokens || 0
                                };
                            }
                        } catch (parseErr: any) {
                            // Re-throw if it's an API error we detected
                            if (parseErr.message && !parseErr.message.includes('JSON')) {
                                throw parseErr;
                            }
                            // Skip malformed JSON chunks
                            log.warn(`Skipping malformed chunk: ${data.substring(0, 100)}`);
                        }
                    } else if (line.trim() && !line.startsWith(':')) {
                        // Log unexpected non-data lines for debugging
                        log.warn(`Unexpected stream line: ${line.substring(0, 200)}`);
                    }
                }
            }
        } catch (streamErr: any) {
            const durationMs = Date.now() - startTime;
            const durationSec = Math.round(durationMs / 1000);
            log.error(`Stream read error: ${streamErr.message}`, { 
                fullTextSoFar: fullText.substring(0, 500),
                errorName: streamErr.name,
                durationMs
            });
            reader.releaseLock();
            
            // Create more descriptive error message
            let enhancedMessage = streamErr.message;
            if (durationMs > 55000) {
                enhancedMessage = `API timeout after ${durationSec}s - connection dropped`;
            } else if (streamErr.message === 'terminated' || streamErr.message === 'network error') {
                enhancedMessage = `Stream ${streamErr.message} after ${durationSec}s`;
                if (fullText.length === 0) {
                    enhancedMessage += ' (no response received)';
                } else {
                    enhancedMessage += ` (partial response: ${fullText.length} chars)`;
                }
            }
            
            const enhancedError = new Error(enhancedMessage);
            enhancedError.name = streamErr.name;
            throw enhancedError;
        } finally {
            try { reader.releaseLock(); } catch { /* already released */ }
        }

        // Log warning if response was truncated due to token limit
        if (finishReason === 'length') {
            log.warn(`Response TRUNCATED - hit token limit`, {
                model,
                durationMs: Date.now() - startTime,
                responseLength: fullText.length,
                finishReason
            });
        } else {
            log.info(`Streaming response complete`, {
                model,
                durationMs: Date.now() - startTime,
                responseLength: fullText.length,
                finishReason,
                usage
            });
        }

        return { text: fullText, usage, finishReason };
    }

    // Handle non-streaming response
    const data = await response.json() as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason;
    const usage: GrokUsage | undefined = data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0
    } : undefined;

    if (finishReason === 'length') {
        log.warn(`Response TRUNCATED - hit token limit`, {
            model,
            durationMs: Date.now() - startTime,
            responseLength: text.length,
            finishReason
        });
    } else {
        log.info(`Non-streaming response complete`, {
            model,
            durationMs: Date.now() - startTime,
            responseLength: text.length,
            finishReason,
            usage
        });
    }

    return { text, usage, finishReason };
}

/**
 * Model info from xAI API
 */
export interface GrokModelInfo {
    id: string;
    contextLength: number;
    inputPricePer1M: number;
    outputPricePer1M: number;
}

/**
 * Fetch language model info from xAI API
 * Returns context length and pricing for each model
 */
export async function fetchLanguageModels(apiKey: string): Promise<GrokModelInfo[]> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    
    log.info('Fetching language models from API');
    
    try {
        const response = await fetch(`${baseUrl}/language-models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(30000)
        });
        
        if (!response.ok) {
            log.error('Failed to fetch language models', { status: response.status });
            return [];
        }
        
        const data = await response.json() as {
            data?: Array<{
                id: string;
                context_length?: number;
                pricing?: {
                    input?: { per_million_tokens?: number };
                    output?: { per_million_tokens?: number };
                };
            }>;
        };
        
        const models: GrokModelInfo[] = (data.data || []).map(m => ({
            id: m.id,
            contextLength: m.context_length || 131072,
            inputPricePer1M: m.pricing?.input?.per_million_tokens || 0.30,
            outputPricePer1M: m.pricing?.output?.per_million_tokens || 0.50
        }));
        
        log.info('Fetched language models', { count: models.length });
        return models;
    } catch (err: any) {
        log.error('Exception fetching language models', { error: err.message });
        return [];
    }
}

/**
 * Test API connection by making a minimal request
 */
export async function testApiConnection(apiKey: string): Promise<{ success: boolean; error?: string; latencyMs?: number }> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const timeoutSeconds = Math.min(config.get<number>('apiTimeout') || 300, 30); // Use shorter timeout for connection test
    
    log.info('Testing API connection', { baseUrl, timeoutSeconds });
    const startTime = Date.now();
    
    try {
        const response = await fetch(`${baseUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(timeoutSeconds * 1000)
        });
        
        const latencyMs = Date.now() - startTime;
        
        if (response.ok) {
            log.info('API connection test successful', { latencyMs });
            return { success: true, latencyMs };
        } else {
            const error = `HTTP ${response.status}: ${response.statusText}`;
            log.error('API connection test failed', { error, latencyMs });
            return { success: false, error, latencyMs };
        }
    } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        let error = err.message || 'Network error';
        if (err.name === 'TimeoutError') {
            error = `Connection timed out after ${timeoutSeconds}s`;
        }
        log.error('API connection test exception', { error, latencyMs });
        return { success: false, error, latencyMs };
    }
}
