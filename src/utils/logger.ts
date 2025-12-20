import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

// In-memory log buffer for export/diagnostics
const LOG_BUFFER_MAX_SIZE = 1000;
const logBuffer: LogEntry[] = [];

export interface LogEntry {
    timestamp: string;
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
    message: string;
    data?: unknown;
    source?: string;
}

export interface DiagnosticsReport {
    generatedAt: string;
    extensionVersion: string;
    vscodeVersion: string;
    platform: string;
    config: Record<string, unknown>;
    connectionStatus: {
        couchbase: boolean;
        grokApi: boolean;
    };
    sessionInfo: {
        currentSessionId?: string;
        sessionCount?: number;
    };
    recentLogs: LogEntry[];
    recentErrors: LogEntry[];
}

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

function addToBuffer(entry: LogEntry): void {
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX_SIZE) {
        logBuffer.shift();
    }
}

export function log(level: LogEntry['level'], message: string, data?: unknown, source?: string): void {
    if (!outputChannel) {
        initLogger();
    }
    
    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, message, data, source };
    addToBuffer(entry);
    
    let formattedMessage = `[${timestamp}] [${level}]`;
    if (source) {
        formattedMessage += ` [${source}]`;
    }
    formattedMessage += ` ${message}`;
    
    if (data !== undefined) {
        try {
            const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 0);
            // Truncate very long data
            formattedMessage += ` ${dataStr.length > 500 ? dataStr.slice(0, 500) + '...' : dataStr}`;
        } catch {
            formattedMessage += ` [Unserializable data]`;
        }
    }
    
    outputChannel!.appendLine(formattedMessage);
}

export function debug(message: string, data?: unknown, source?: string): void {
    if (isDebugEnabled()) {
        log('DEBUG', message, data, source);
    }
}

export function info(message: string, data?: unknown, source?: string): void {
    log('INFO', message, data, source);
}

export function warn(message: string, data?: unknown, source?: string): void {
    log('WARN', message, data, source);
}

export function error(message: string, data?: unknown, source?: string): void {
    log('ERROR', message, data, source);
}

export function showOutput(): void {
    if (outputChannel) {
        outputChannel.show();
    }
}

export function getLogBuffer(): LogEntry[] {
    return [...logBuffer];
}

export function getRecentErrors(count: number = 50): LogEntry[] {
    return logBuffer.filter(e => e.level === 'ERROR').slice(-count);
}

export function clearLogBuffer(): void {
    logBuffer.length = 0;
}

export async function exportLogsToFile(): Promise<string | null> {
    const logs = logBuffer.map(e => {
        let line = `[${e.timestamp}] [${e.level}]`;
        if (e.source) line += ` [${e.source}]`;
        line += ` ${e.message}`;
        if (e.data) {
            try {
                line += ` ${JSON.stringify(e.data)}`;
            } catch {
                line += ` [Unserializable]`;
            }
        }
        return line;
    }).join('\n');

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`grok-ai-logs-${Date.now()}.txt`),
        filters: { 'Text Files': ['txt'], 'JSON': ['json'] }
    });

    if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(logs, 'utf8'));
        return uri.fsPath;
    }
    return null;
}

export async function generateDiagnosticsReport(
    connectionStatus: { couchbase: boolean; grokApi: boolean },
    sessionInfo: { currentSessionId?: string; sessionCount?: number }
): Promise<DiagnosticsReport> {
    const config = getConfig();
    
    // Sanitize config (remove sensitive data)
    const sanitizedConfig: Record<string, unknown> = {
        apiBaseUrl: config.apiBaseUrl,
        modelFast: config.modelFast,
        modelReasoning: config.modelReasoning,
        modelVision: config.modelVision,
        defaultModelType: config.defaultModelType,
        couchbaseUrl: config.couchbaseUrl,
        couchbasePort: config.couchbasePort,
        couchbaseBucket: config.couchbaseBucket,
        debug: config.debug,
        enableSound: config.enableSound,
    };

    return {
        generatedAt: new Date().toISOString(),
        extensionVersion: vscode.extensions.getExtension('grok-coder.grok-coder')?.packageJSON?.version || 'unknown',
        vscodeVersion: vscode.version,
        platform: `${process.platform} ${process.arch}`,
        config: sanitizedConfig,
        connectionStatus,
        sessionInfo,
        recentLogs: logBuffer.slice(-100),
        recentErrors: getRecentErrors(20)
    };
}

export async function exportDiagnosticsReport(
    connectionStatus: { couchbase: boolean; grokApi: boolean },
    sessionInfo: { currentSessionId?: string; sessionCount?: number }
): Promise<string | null> {
    const report = await generateDiagnosticsReport(connectionStatus, sessionInfo);
    const content = JSON.stringify(report, null, 2);

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`grok-ai-diagnostics-${Date.now()}.json`),
        filters: { 'JSON': ['json'] }
    });

    if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        return uri.fsPath;
    }
    return null;
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
        couchbaseDeployment: config.get<'self-hosted' | 'capella'>('couchbaseDeployment') || 'self-hosted',
        couchbaseUrl: config.get<string>('couchbaseUrl') || 'http://localhost',
        capellaDataApiUrl: config.get<string>('capellaDataApiUrl') || '',
        couchbasePort: config.get<number>('couchbasePort') || 8091,
        couchbaseQueryPort: config.get<number>('couchbaseQueryPort') || 8093,
        couchbaseUsername: config.get<string>('couchbaseUsername') || 'Administrator',
        couchbasePassword: config.get<string>('couchbasePassword') || 'password',
        couchbaseBucket: config.get<string>('couchbaseBucket') || 'grokCoder',
        couchbaseScope: config.get<string>('couchbaseScope') || '_default',
        couchbaseCollection: config.get<string>('couchbaseCollection') || '_default',
        
        // Timeouts
        couchbaseTimeout: config.get<number>('couchbaseTimeout') || 30,
        apiTimeout: config.get<number>('apiTimeout') || 300,
        
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

// Scoped logger factory for component-specific logging
export function createScopedLogger(source: string) {
    return {
        debug: (message: string, data?: unknown) => debug(message, data, source),
        info: (message: string, data?: unknown) => info(message, data, source),
        warn: (message: string, data?: unknown) => warn(message, data, source),
        error: (message: string, data?: unknown) => error(message, data, source),
    };
}
