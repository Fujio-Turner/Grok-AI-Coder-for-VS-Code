import * as vscode from 'vscode';
import { GrokUsage } from '../api/grokClient';

export interface SessionUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
}

// In-memory usage tracking per session
const sessionUsageMap: Map<string, SessionUsage> = new Map();

// Status bar item
let statusBarItem: vscode.StatusBarItem | null = null;
let currentSessionId: string | null = null;

// Pricing per 1M tokens based on xAI pricing (as of 2024)
// grok-3-mini: $0.30/1M input, $0.50/1M output
// grok-4: $3/1M input, $15/1M output
const PRICING = {
    'grok-3-mini': { inputPer1M: 0.30, outputPer1M: 0.50 },
    'grok-4': { inputPer1M: 3.00, outputPer1M: 15.00 },
    'default': { inputPer1M: 0.30, outputPer1M: 0.50 }
};

export function updateUsage(sessionId: string, usage: GrokUsage, model?: string): SessionUsage {
    let sessionUsage = sessionUsageMap.get(sessionId);
    
    if (!sessionUsage) {
        sessionUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: 0,
            requestCount: 0
        };
    }

    sessionUsage.promptTokens += usage.promptTokens;
    sessionUsage.completionTokens += usage.completionTokens;
    sessionUsage.totalTokens += usage.totalTokens;
    sessionUsage.requestCount += 1;

    // Calculate cost based on model
    const pricing = PRICING[model as keyof typeof PRICING] || PRICING['default'];
    const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPer1M;
    sessionUsage.estimatedCostUsd += inputCost + outputCost;

    sessionUsageMap.set(sessionId, sessionUsage);
    currentSessionId = sessionId;
    
    // Update status bar
    updateStatusBar();
    
    return sessionUsage;
}

export function getSessionUsage(sessionId: string): SessionUsage | null {
    return sessionUsageMap.get(sessionId) || null;
}

export function formatUsageDisplay(usage: SessionUsage): string {
    const cost = usage.estimatedCostUsd.toFixed(4);
    return `${usage.totalTokens.toLocaleString()} tokens (~$${cost})`;
}

export function clearSessionUsage(sessionId: string): void {
    sessionUsageMap.delete(sessionId);
}

export function getAllUsage(): Map<string, SessionUsage> {
    return new Map(sessionUsageMap);
}

// Status bar functions
export function initStatusBar(context: vscode.ExtensionContext): void {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'grok.showUsage';
    statusBarItem.text = '$(dashboard) Grok: 0 tokens';
    statusBarItem.tooltip = 'Grok AI token usage for current session';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

function updateStatusBar(): void {
    if (!statusBarItem || !currentSessionId) return;
    
    const usage = sessionUsageMap.get(currentSessionId);
    if (usage) {
        const tokens = usage.totalTokens.toLocaleString();
        const cost = usage.estimatedCostUsd.toFixed(4);
        statusBarItem.text = `$(dashboard) Grok: ${tokens} tokens`;
        statusBarItem.tooltip = `Session tokens: ${tokens}\nPrompt: ${usage.promptTokens.toLocaleString()}\nCompletion: ${usage.completionTokens.toLocaleString()}\nRequests: ${usage.requestCount}\nEst. cost: $${cost}`;
    }
}

export function setCurrentSession(sessionId: string): void {
    currentSessionId = sessionId;
    updateStatusBar();
}

export function showUsageSummary(): void {
    if (!currentSessionId) {
        vscode.window.showInformationMessage('No active Grok session');
        return;
    }
    
    const usage = sessionUsageMap.get(currentSessionId);
    if (!usage) {
        vscode.window.showInformationMessage('No usage data for current session');
        return;
    }
    
    const message = `Grok Session Usage:
• Total tokens: ${usage.totalTokens.toLocaleString()}
• Prompt tokens: ${usage.promptTokens.toLocaleString()}
• Completion tokens: ${usage.completionTokens.toLocaleString()}
• Requests: ${usage.requestCount}
• Estimated cost: $${usage.estimatedCostUsd.toFixed(4)}`;
    
    vscode.window.showInformationMessage(message, { modal: true });
}
