import * as vscode from 'vscode';

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

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            stream: !!onChunk,
            stream_options: onChunk ? { include_usage: true } : undefined
        }),
        signal
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

    return { text, usage };
}
