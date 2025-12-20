import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Grok AI');
    }
    return outputChannel;
}

export function isDebugEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('grok');
    return config.get<boolean>('debug') || false;
}

export function log(message: string, ...args: unknown[]): void {
    if (!outputChannel) {
        initLogger();
    }
    
    const timestamp = new Date().toISOString();
    const formattedMessage = args.length > 0 
        ? `[${timestamp}] ${message} ${JSON.stringify(args)}`
        : `[${timestamp}] ${message}`;
    
    outputChannel!.appendLine(formattedMessage);
}

export function debug(message: string, ...args: unknown[]): void {
    if (isDebugEnabled()) {
        log(`[DEBUG] ${message}`, ...args);
    }
}

export function info(message: string, ...args: unknown[]): void {
    log(`[INFO] ${message}`, ...args);
}

export function warn(message: string, ...args: unknown[]): void {
    log(`[WARN] ${message}`, ...args);
}

export function error(message: string, ...args: unknown[]): void {
    log(`[ERROR] ${message}`, ...args);
}

export function showOutput(): void {
    if (outputChannel) {
        outputChannel.show();
    }
}

export type ModelType = 'fast' | 'reasoning' | 'vision';

export function getConfig() {
    const config = vscode.workspace.getConfiguration('grok');
    
    return {
        // Grok API settings
        apiBaseUrl: config.get<string>('apiBaseUrl') || 'https://api.x.ai/v1',
        modelFast: config.get<string>('modelFast') || 'grok-3-mini',
        modelReasoning: config.get<string>('modelReasoning') || 'grok-4',
        modelVision: config.get<string>('modelVision') || 'grok-4',
        defaultModelType: config.get<ModelType>('defaultModelType') || 'fast',
        
        // Couchbase settings
        couchbaseUrl: config.get<string>('couchbaseUrl') || 'localhost',
        couchbasePort: config.get<number>('couchbasePort') || 8091,
        couchbaseQueryPort: config.get<number>('couchbaseQueryPort') || 8093,
        couchbaseUsername: config.get<string>('couchbaseUsername') || 'Administrator',
        couchbasePassword: config.get<string>('couchbasePassword') || 'password',
        couchbaseBucket: config.get<string>('couchbaseBucket') || 'grokCoder',
        couchbaseScope: config.get<string>('couchbaseScope') || '_default',
        couchbaseCollection: config.get<string>('couchbaseCollection') || '_default',
        
        // Other settings
        debug: config.get<boolean>('debug') || false,
        enableSound: config.get<boolean>('enableSound') || false,
    };
}

export function getModelName(modelType?: ModelType): string {
    const config = getConfig();
    const type = modelType || config.defaultModelType;
    
    switch (type) {
        case 'reasoning':
            return config.modelReasoning;
        case 'vision':
            return config.modelVision;
        case 'fast':
        default:
            return config.modelFast;
    }
}

/**
 * Auto-detect the best model type based on prompt content.
 * Returns 'reasoning' for complex tasks, 'vision' for images, 'fast' for simple queries.
 */
export function detectModelType(prompt: string, hasImages: boolean = false): ModelType {
    if (hasImages) {
        return 'vision';
    }
    
    const lowerPrompt = prompt.toLowerCase();
    
    // Indicators of complex reasoning tasks
    const reasoningIndicators = [
        'explain',
        'analyze',
        'debug',
        'refactor',
        'architect',
        'design',
        'optimize',
        'review',
        'compare',
        'implement',
        'create a plan',
        'step by step',
        'why does',
        'how does',
        'what is the best',
        'trade-offs',
        'complex',
        'algorithm',
        'security',
        'performance'
    ];
    
    // Check for code blocks (indicates more complex task)
    const hasCodeBlock = prompt.includes('```');
    
    // Check for multi-line input (likely more complex)
    const lineCount = prompt.split('\n').length;
    
    // Check for reasoning indicators
    const hasReasoningIndicator = reasoningIndicators.some(indicator => 
        lowerPrompt.includes(indicator)
    );
    
    // Use reasoning model for complex tasks
    if (hasReasoningIndicator || hasCodeBlock || lineCount > 5) {
        return 'reasoning';
    }
    
    return 'fast';
}
