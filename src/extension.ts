import * as vscode from 'vscode';
import { ChatViewProvider } from './views/ChatViewProvider';
import { shutdownCouchbase } from './storage/couchbaseClient';
import { initLogger, info, debug, getConfig } from './utils/logger';
import { initStatusBar, showUsageSummary } from './usage/tokenTracker';

export function activate(context: vscode.ExtensionContext) {
    // Initialize logger first
    const outputChannel = initLogger();
    info('Grok AI Coder extension activated');
    
    const config = getConfig();
    debug('Configuration loaded:', config);

    // Initialize status bar for token tracking
    initStatusBar(context);

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

    info('All commands registered');
}

export async function deactivate() {
    await shutdownCouchbase();
}
