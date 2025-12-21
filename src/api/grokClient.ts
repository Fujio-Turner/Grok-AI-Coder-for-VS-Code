import * as vscode from 'vscode';
import { createScopedLogger } from '../utils/logger';
import { optimizeMessageContent, getToonSystemPromptAddition } from '../utils/toonConverter';

const log = createScopedLogger('GrokAPI');

export interface GrokMessageContent {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
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

export async function sendChatCompletion(
    messages: GrokMessage[],
    model: string,
    apiKey: string,
    signal?: AbortSignal,
    onChunk?: (chunk: string) => void
): Promise<GrokResponse> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const timeoutSeconds = config.get<number>('apiTimeout') || 300;
    const optimizePayload = config.get<string>('optimizePayload') || 'none';

    // Apply TOON optimization if enabled
    let optimizedMessages = messages;
    if (optimizePayload === 'toon') {
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
        streaming: !!onChunk,
        baseUrl,
        timeoutSeconds,
        optimizePayload
    });

    const startTime = Date.now();

    // Combine user abort signal with timeout
    const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
    const combinedSignal = signal 
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: optimizedMessages.map(m => ({ role: m.role, content: m.content })),
            stream: !!onChunk,
            stream_options: onChunk ? { include_usage: true } : undefined
        }),
        signal: combinedSignal
    });

    if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `API error: ${response.status}`;
        
        try {
            const errorJson = JSON.parse(errorBody);
            errorMessage = errorJson.error?.message || errorMessage;
        } catch {
            if (errorBody) {
                errorMessage = errorBody;
            }
        }

        log.error(`API request failed`, { 
            status: response.status, 
            model, 
            error: errorMessage,
            durationMs: Date.now() - startTime 
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
    if (onChunk && response.body) {
        let fullText = '';
        let usage: GrokUsage | undefined;

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
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullText += delta;
                                onChunk(delta);
                            }
                            
                            // Capture usage if present
                            if (parsed.usage) {
                                usage = {
                                    promptTokens: parsed.usage.prompt_tokens || 0,
                                    completionTokens: parsed.usage.completion_tokens || 0,
                                    totalTokens: parsed.usage.total_tokens || 0
                                };
                            }
                        } catch {
                            // Skip malformed JSON chunks
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        log.info(`Streaming response complete`, {
            model,
            durationMs: Date.now() - startTime,
            responseLength: fullText.length,
            usage
        });

        return { text: fullText, usage };
    }

    // Handle non-streaming response
    const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const usage: GrokUsage | undefined = data.usage ? {
        promptTokens: data.usage.prompt_tokens || 0,
        completionTokens: data.usage.completion_tokens || 0,
        totalTokens: data.usage.total_tokens || 0
    } : undefined;

    log.info(`Non-streaming response complete`, {
        model,
        durationMs: Date.now() - startTime,
        responseLength: text.length,
        usage
    });

    return { text, usage };
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
