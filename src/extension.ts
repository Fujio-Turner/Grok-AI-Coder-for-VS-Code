import * as vscode from 'vscode';
import { ChatViewProvider } from './views/ChatViewProvider';
import { initSetupWizard } from './views/SetupWizardProvider';
import { shutdownCouchbase, getCouchbaseClient } from './storage/couchbaseClient';
import { initLogger, info, debug, getConfig, showOutput, exportLogsToFile, exportDiagnosticsReport } from './utils/logger';
import { initStatusBar, showUsageSummary } from './usage/tokenTracker';
import { getChangeTracker } from './edits/codeActions';
import { testApiConnection } from './api/grokClient';
import { listSessions } from './storage/chatSessionRepository';
import { initializeStepTracking, getAgentStepTracker } from './agent/agentStepTracker';

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger first
    const outputChannel = initLogger();
    
    // Get and log extension version
    const extension = vscode.extensions.getExtension('fujio-turner.grok-ai-coder');
    const version = extension?.packageJSON?.version || 'unknown';
    info(`Grok AI Coder extension activated (v${version})`);
    
    const config = getConfig();
    debug('Configuration loaded:', config);

    // Initialize status bar for token tracking
    initStatusBar(context);
    
    // Initialize agent step tracking (for multi-step workflows)
    initializeStepTracking();

    // Register the chat view provider
    const chatViewProvider = new ChatViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatViewProvider
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('grok.setApiKey', async () => {
            const key = await vscode.window.showInputBox({
                prompt: 'Enter your xAI Grok API key',
                password: true,
                ignoreFocusOut: true,
                placeHolder: 'Get your API key at https://x.ai/api'
            });
            if (key) {
                await context.secrets.store('grokApiKey', key);
                vscode.window.showInformationMessage('Grok API key saved securely.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.newChatSession', () => {
            chatViewProvider.createNewSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.retryLastRequest', () => {
            chatViewProvider.retryLastRequest();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.cancelRequest', () => {
            chatViewProvider.cancelCurrentRequest();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.explainSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.document.getText(editor.selection);
                if (selection) {
                    chatViewProvider.sendMessage(`Explain this code:\n\`\`\`\n${selection}\n\`\`\``);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.fixSelection', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const selection = editor.document.getText(editor.selection);
                if (selection) {
                    chatViewProvider.sendMessage(`Fix this code:\n\`\`\`\n${selection}\n\`\`\``);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.revertLastEdits', () => {
            chatViewProvider.revertLastEdits();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.showUsage', () => {
            showUsageSummary();
        })
    );

    // Rewind/Forward commands
    context.subscriptions.push(
        vscode.commands.registerCommand('grok.rewindStep', async () => {
            const tracker = getChangeTracker();
            if (tracker.canRewind()) {
                const current = tracker.getCurrentChange();
                if (current) {
                    // The webview handles the actual revert via message
                    vscode.commands.executeCommand('workbench.view.extension.grokChatContainer');
                }
            } else {
                vscode.window.showInformationMessage('Nothing to rewind');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.forwardStep', async () => {
            const tracker = getChangeTracker();
            if (tracker.canForward()) {
                vscode.commands.executeCommand('workbench.view.extension.grokChatContainer');
            } else {
                vscode.window.showInformationMessage('Nothing to forward');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.clearChangeHistory', () => {
            const tracker = getChangeTracker();
            tracker.clear();
            vscode.window.showInformationMessage('Change history cleared');
        })
    );

    // Diagnostics commands
    context.subscriptions.push(
        vscode.commands.registerCommand('grok.showLogs', () => {
            showOutput();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.exportLogs', async () => {
            const path = await exportLogsToFile();
            if (path) {
                vscode.window.showInformationMessage(`Logs exported to: ${path}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.testConnections', async () => {
            const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            statusBarItem.text = '$(sync~spin) Testing connections...';
            statusBarItem.show();

            try {
                // Test Couchbase
                const cbClient = getCouchbaseClient();
                const cbResult = await cbClient.ping();

                // Test Grok API
                const apiKey = await context.secrets.get('grokApiKey');
                let apiResult: { success: boolean; error?: string; latencyMs?: number } = { success: false, error: 'No API key set' };
                if (apiKey) {
                    apiResult = await testApiConnection(apiKey);
                }

                statusBarItem.hide();
                statusBarItem.dispose();

                const message = [
                    `Couchbase: ${cbResult ? '✅ Connected' : '❌ Failed'}`,
                    `Grok API: ${apiResult.success ? `✅ Connected (${apiResult.latencyMs || 0}ms)` : `❌ ${apiResult.error || 'Failed'}`}`
                ].join('\n');

                vscode.window.showInformationMessage(message, { modal: true });
            } catch (error: any) {
                statusBarItem.hide();
                statusBarItem.dispose();
                vscode.window.showErrorMessage(`Connection test failed: ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('grok.exportDiagnostics', async () => {
            const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
            statusBarItem.text = '$(sync~spin) Generating diagnostics...';
            statusBarItem.show();

            try {
                // Gather connection status
                const cbClient = getCouchbaseClient();
                const cbResult = await cbClient.ping();
                
                const apiKey = await context.secrets.get('grokApiKey');
                let apiResult = { success: false };
                if (apiKey) {
                    apiResult = await testApiConnection(apiKey);
                }

                // Get session info
                let sessionCount = 0;
                try {
                    const sessions = await listSessions(100);
                    sessionCount = sessions.length;
                } catch {
                    // Ignore session count errors
                }

                statusBarItem.hide();
                statusBarItem.dispose();

                const path = await exportDiagnosticsReport(
                    { couchbase: cbResult, grokApi: apiResult.success },
                    { currentSessionId: chatViewProvider.getCurrentSessionId(), sessionCount }
                );

                if (path) {
                    vscode.window.showInformationMessage(`Diagnostics exported to: ${path}`);
                }
            } catch (error: any) {
                statusBarItem.hide();
                statusBarItem.dispose();
                vscode.window.showErrorMessage(`Failed to export diagnostics: ${error.message}`);
            }
        })
    );

    info('All commands registered');
    
    // Initialize setup wizard (shows on first run)
    initSetupWizard(context);
}

export async function deactivate() {
    await shutdownCouchbase();
}
