import * as vscode from 'vscode';
import { createScopedLogger } from '../utils/logger';
import { getSchemaFromConfig } from '../utils/configLoader';

const log = createScopedLogger('ImageGen');

/**
 * Default schema for image prompts generation (fallback if config not found)
 */
const DEFAULT_IMAGE_PROMPTS_SCHEMA = {
    type: "json_schema",
    json_schema: {
        name: "image_prompts",
        strict: true,
        schema: {
            type: "object",
            properties: {
                prompts: {
                    type: "array",
                    items: { type: "string" }
                }
            },
            required: ["prompts"],
            additionalProperties: false
        }
    }
};

/**
 * Get the image prompts schema from config or use default.
 */
function getImagePromptsSchema(): object {
    return getSchemaFromConfig('image-prompts-schema', DEFAULT_IMAGE_PROMPTS_SCHEMA);
}

export interface ImageGenerationResult {
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
}

export interface ImageGenerationResponse {
    images: ImageGenerationResult[];
    usage?: {
        tokensUsed: number;
    };
}

export interface GeneratedImage {
    id: string;
    originalPrompt: string;
    revisedPrompt?: string;
    url?: string;
    base64?: string;
    timestamp: number;
    selected: boolean;
}

/**
 * Generate images using the xAI image generation API
 * Endpoint: POST /v1/images/generations
 * 
 * @param prompt - Text prompt describing the image(s) to generate
 * @param count - Number of images to generate (1-10, default 1)
 * @param apiKey - xAI API key
 * @param responseFormat - 'url' or 'b64_json' (default 'url')
 */
export async function generateImages(
    prompt: string,
    count: number = 1,
    apiKey: string,
    responseFormat: 'url' | 'b64_json' = 'url'
): Promise<ImageGenerationResponse> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const model = config.get<string>('modelImageCreate') || 'grok-2-image';
    const timeoutSeconds = config.get<number>('apiTimeout') || 300;

    log.info(`Generating ${count} image(s) with model ${model}`, { prompt: prompt.substring(0, 100) });
    const startTime = Date.now();

    const response = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            prompt,
            n: Math.min(Math.max(count, 1), 10), // Clamp between 1-10
            response_format: responseFormat
        }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000)
    });

    if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = `Image generation API error: ${response.status}`;
        
        try {
            const errorJson = JSON.parse(errorBody);
            errorMessage = errorJson.error?.message || errorMessage;
        } catch {
            if (errorBody) {
                errorMessage = errorBody;
            }
        }

        log.error(`Image generation failed`, { 
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

    const data = await response.json() as {
        data?: Array<{
            url?: string;
            b64_json?: string;
            revised_prompt?: string;
        }>;
        meta?: {
            usage?: {
                tokens_used?: number;
            };
        };
    };

    const images: ImageGenerationResult[] = (data.data || []).map(img => ({
        url: img.url,
        b64_json: img.b64_json,
        revised_prompt: img.revised_prompt
    }));

    const usage = data.meta?.usage?.tokens_used ? {
        tokensUsed: data.meta.usage.tokens_used
    } : undefined;

    log.info(`Image generation complete`, {
        model,
        durationMs: Date.now() - startTime,
        imageCount: images.length,
        usage
    });

    return { images, usage };
}

/**
 * Detect if a user message is requesting image generation
 */
export function detectImageGenerationRequest(message: string): {
    isImageRequest: boolean;
    imageCount: number;
    extractedPrompt: string;
} {
    const lowerMessage = message.toLowerCase();
    
    // Keywords that indicate image generation
    const imageKeywords = [
        'create an image',
        'create image',
        'generate an image',
        'generate image',
        'make an image',
        'make image',
        'draw',
        'create a picture',
        'generate a picture',
        'create icon',
        'create icons',
        'generate icon',
        'generate icons',
        'create logo',
        'generate logo',
        'create illustration',
        'generate illustration',
        'create artwork',
        'generate artwork',
        'create visual',
        'generate visual',
        'design an image',
        'design image',
        'produce an image',
        'produce image'
    ];

    const isImageRequest = imageKeywords.some(keyword => lowerMessage.includes(keyword));

    // Detect count - look for patterns like "4 icons", "3 images", etc.
    let imageCount = 1;
    const countMatch = lowerMessage.match(/(\d+)\s*(image|icon|logo|picture|illustration|artwork|visual|idea|option|variation)/i);
    if (countMatch) {
        imageCount = Math.min(parseInt(countMatch[1], 10), 10); // Max 10
    }

    // Extract the prompt (the message itself serves as the base prompt)
    const extractedPrompt = message;

    return {
        isImageRequest,
        imageCount,
        extractedPrompt
    };
}

/**
 * Create multiple prompts from a single request (for "create 4 icon ideas" type requests)
 * This uses the reasoning model to generate diverse prompts
 */
export async function generateImagePrompts(
    userRequest: string,
    count: number,
    apiKey: string,
    contextInfo?: string
): Promise<string[]> {
    const config = vscode.workspace.getConfiguration('grok');
    const baseUrl = config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1';
    const model = config.get<string>('modelFast') || 'grok-3-mini';

    log.info(`Generating ${count} image prompts from user request`);

    const systemPrompt = `You are an expert at creating image generation prompts. 
Given a user's request, generate ${count} distinct, detailed prompts for image generation.
Each prompt should be:
- Specific and descriptive
- Suitable for high-quality image generation
- A unique variation/interpretation of the request

${contextInfo ? `Context about the project:\n${contextInfo}` : ''}`;

    // Use structured outputs to guarantee valid JSON response
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userRequest }
            ],
            response_format: getImagePromptsSchema()
        }),
        signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
        throw new Error(`Failed to generate image prompts: ${response.status}`);
    }

    const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
    };
    
    const content = data.choices?.[0]?.message?.content || '{"prompts":[]}';
    
    try {
        // With structured outputs, response is guaranteed valid JSON
        const parsed = JSON.parse(content);
        const prompts = parsed.prompts || [];
        if (Array.isArray(prompts) && prompts.length > 0) {
            return prompts.slice(0, count);
        }
    } catch {
        log.error('Failed to parse generated prompts', { content });
    }

    // Fallback: return the original request as a single prompt
    return [userRequest];
}

/**
 * Create a unique ID for a generated image
 */
export function createImageId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
