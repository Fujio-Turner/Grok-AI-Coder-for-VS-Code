import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { sendChatCompletion, GrokMessage, createVisionMessage, testApiConnection } from '../api/grokClient';
import { getCouchbaseClient } from '../storage/couchbaseClient';
import { 
    createSession, 
    getSession, 
    appendPair, 
    updateLastPairResponse,
    updateSessionSummary,
    updateSessionUsage,
    listSessions,
    ChatPair,
    ChatRequest,
    ChatResponse,
    ChatSessionDocument
} from '../storage/chatSessionRepository';
import { readAgentContext } from '../context/workspaceContext';
import { getModelName, ModelType, debug, info, error as logError, detectModelType } from '../utils/logger';
import { 
    parseCodeBlocksFromResponse, 
    applyEdits as doApplyEdits, 
    revertEdits, 
    ProposedEdit,
    getChangeTracker,
    revertToChangeSet,
    reapplyFromChangeSet,
    previewDiffStats
} from '../edits/codeActions';
import { updateUsage, setCurrentSession } from '../usage/tokenTracker';
import { ChangeSet } from '../edits/changeTracker';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'grokChatView';

    private _view?: vscode.WebviewView;
    private _currentSessionId?: string;
    private _abortController?: AbortController;
    private _isRequestInProgress = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        const tracker = getChangeTracker();
        tracker.onChange((changes, position) => {
            this._sendChangesUpdate(changes, position);
        });
    }

    public getCurrentSessionId(): string | undefined {
        return this._currentSessionId;
    }

    private _sendChangesUpdate(changes: ChangeSet[], position: number) {
        const tracker = getChangeTracker();
        this._postMessage({
            type: 'changesUpdate',
            changes: changes.map(cs => ({
                id: cs.id,
                timestamp: cs.timestamp.toISOString(),
                files: cs.files.map(f => ({
                    fileName: f.fileName,
                    filePath: f.filePath,
                    stats: f.stats,
                    isNewFile: f.isNewFile
                })),
                totalStats: cs.totalStats,
                cost: cs.cost,
                tokensUsed: cs.tokensUsed,
                duration: tracker.formatDuration(cs.durationMs),
                applied: cs.applied,
                description: cs.description
            })),
            currentPosition: position,
            canRewind: tracker.canRewind(),
            canForward: tracker.canForward()
        });
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            info('Received message from webview:', message.type);
            
            switch (message.type) {
                case 'sendMessage':
                    info('Processing sendMessage:', { text: message.text?.substring(0, 30), imageCount: message.images?.length || 0 });
                    await this.sendMessage(message.text, message.images);
                    break;
                case 'retryMessage':
                    await this.retryMessage(message.pairIndex);
                    break;
                case 'newSession':
                    await this.createNewSession();
                    break;
                case 'cancelRequest':
                    this.cancelCurrentRequest();
                    break;
                case 'applyEdits':
                    await this.applyEdits(message.editId);
                    break;
                case 'runCommand':
                    await this.runTerminalCommand(message.command);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'grok');
                    break;
                case 'ready':
                    await this._initializeSession();
                    this._sendInitialChanges();
                    this._testAndSendConnectionStatus();
                    break;
                case 'loadSession':
                    await this.loadSession(message.sessionId);
                    break;
                case 'getHistory':
                    await this._sendSessionHistory();
                    break;
                case 'rewindTo':
                    await this._rewindToChangeSet(message.changeSetId);
                    break;
                case 'forwardTo':
                    await this._forwardToChangeSet(message.changeSetId);
                    break;
                case 'rewindStep':
                    await this._rewindStep();
                    break;
                case 'forwardStep':
                    await this._forwardStep();
                    break;
                case 'getChanges':
                    this._sendInitialChanges();
                    break;
                case 'getConfig':
                    this._sendConfig();
                    break;
                case 'toggleAutoApply':
                    this.toggleAutoApply();
                    break;
                case 'setModelMode':
                    this.setModelMode(message.mode);
                    break;
                case 'testConnections':
                    this._testAndSendConnectionStatus();
                    break;
            }
        });
    }

    private _sendInitialChanges() {
        const tracker = getChangeTracker();
        const changes = tracker.getHistory();
        const position = tracker.getCurrentPosition();
        this._sendChangesUpdate(changes, position);
    }

    private _sendConfig() {
        const config = vscode.workspace.getConfiguration('grok');
        this._postMessage({
            type: 'config',
            enterToSend: config.get<boolean>('enterToSend', false),
            autoApply: config.get<boolean>('autoApply', true),
            modelMode: config.get<string>('modelMode', 'fast')
        });
    }

    public toggleAutoApply() {
        const config = vscode.workspace.getConfiguration('grok');
        const current = config.get<boolean>('autoApply', true);
        config.update('autoApply', !current, vscode.ConfigurationTarget.Global);
        this._sendConfig();
    }

    public setModelMode(mode: string) {
        const config = vscode.workspace.getConfiguration('grok');
        config.update('modelMode', mode, vscode.ConfigurationTarget.Global);
        this._sendConfig();
    }

    private async _testAndSendConnectionStatus() {
        try {
            // Test Couchbase
            const cbClient = getCouchbaseClient();
            const cbResult = await cbClient.ping();

            // Test Grok API
            const apiKey = await this._context.secrets.get('grokApiKey');
            let apiResult = false;
            if (apiKey) {
                const result = await testApiConnection(apiKey);
                apiResult = result.success;
            }

            this._postMessage({
                type: 'connectionStatus',
                couchbase: cbResult,
                api: apiResult
            });
        } catch (error) {
            this._postMessage({
                type: 'connectionStatus',
                couchbase: false,
                api: false
            });
        }
    }

    private async _rewindToChangeSet(changeSetId: string) {
        try {
            const success = await revertToChangeSet(changeSetId);
            if (success) {
                vscode.window.showInformationMessage('Reverted to previous state');
            } else {
                vscode.window.showErrorMessage('Failed to rewind');
            }
        } catch (error: any) {
            logError('Rewind failed:', error);
            vscode.window.showErrorMessage(`Rewind failed: ${error.message}`);
        }
    }

    private async _forwardToChangeSet(changeSetId: string) {
        try {
            const success = await reapplyFromChangeSet(changeSetId);
            if (success) {
                vscode.window.showInformationMessage('Reapplied changes');
            } else {
                vscode.window.showErrorMessage('Failed to forward');
            }
        } catch (error: any) {
            logError('Forward failed:', error);
            vscode.window.showErrorMessage(`Forward failed: ${error.message}`);
        }
    }

    private async _rewindStep() {
        const tracker = getChangeTracker();
        if (!tracker.canRewind()) {
            vscode.window.showInformationMessage('Nothing to rewind');
            return;
        }

        const current = tracker.getCurrentChange();
        if (current) {
            await this._rewindToChangeSet(current.id);
            tracker.rewind();
        }
    }

    private async _forwardStep() {
        const tracker = getChangeTracker();
        if (!tracker.canForward()) {
            vscode.window.showInformationMessage('Nothing to forward');
            return;
        }

        tracker.forward();
        const next = tracker.getCurrentChange();
        if (next) {
            await this._forwardToChangeSet(next.id);
        }
    }

    private async _sendSessionHistory() {
        try {
            const sessions = await listSessions(20);
            this._postMessage({
                type: 'historyList',
                sessions: sessions.map(s => ({
                    id: s.id,
                    summary: s.summary || this._getFirstMessagePreview(s),
                    updatedAt: s.updatedAt,
                    pairCount: (s as any).pairCount || 0
                })),
                currentSessionId: this._currentSessionId
            });
        } catch (error) {
            logError('Failed to get session history:', error);
        }
    }

    private _getFirstMessagePreview(session: ChatSessionDocument): string {
        if (session.pairs && session.pairs.length > 0) {
            const firstMsg = session.pairs[0].request.text;
            return firstMsg.length > 50 ? firstMsg.substring(0, 50) + '...' : firstMsg;
        }
        return 'New chat';
    }

    public async loadSession(sessionId: string) {
        try {
            const session = await getSession(sessionId);
            if (session) {
                this._currentSessionId = sessionId;
                setCurrentSession(sessionId);
                await this._context.globalState.update('grok.currentSessionId', sessionId);
                this._postMessage({
                    type: 'sessionChanged',
                    sessionId: session.id,
                    summary: session.summary,
                    history: session.pairs
                });
                info('Loaded session:', sessionId);
            }
        } catch (error) {
            logError('Failed to load session:', error);
            vscode.window.showErrorMessage('Failed to load session');
        }
    }

    private async _generateSessionSummary(userMessage: string, assistantResponse: string) {
        if (!this._currentSessionId) return;
        
        try {
            const apiKey = await this._context.secrets.get('grokApiKey');
            if (!apiKey) return;

            const summaryPrompt: GrokMessage[] = [
                { role: 'system', content: 'Generate a very short (max 8 words) summary of what this chat is about. Just the topic, no punctuation at the end.' },
                { role: 'user', content: `User asked: "${userMessage.substring(0, 200)}"` }
            ];

            const model = getModelName('fast');
            const response = await sendChatCompletion(summaryPrompt, model, apiKey);
            
            if (response.text) {
                const summary = response.text.trim().substring(0, 80);
                await updateSessionSummary(this._currentSessionId, summary);
                debug('Generated summary:', summary);
            }
        } catch (error) {
            logError('Failed to generate summary:', error);
        }
    }

    private async _initializeSession() {
        info('Initializing session...');
        
        const savedSessionId = this._context.globalState.get<string>('grok.currentSessionId');
        debug('Saved session ID:', savedSessionId);
        
        if (savedSessionId) {
            try {
                const session = await getSession(savedSessionId);
                if (session) {
                    this._currentSessionId = savedSessionId;
                    setCurrentSession(savedSessionId);
                    info('Loaded existing session:', savedSessionId);
                    this._postMessage({
                        type: 'init',
                        sessionId: session.id,
                        history: session.pairs
                    });
                    return;
                }
            } catch (error) {
                logError('Failed to load session:', error);
            }
        }

        info('Creating new session...');
        await this.createNewSession();
    }

    public async createNewSession() {
        try {
            debug('Creating new session in Couchbase...');
            const session = await createSession();
            this._currentSessionId = session.id;
            setCurrentSession(session.id);
            await this._context.globalState.update('grok.currentSessionId', session.id);
            info('Created new session:', session.id);
            vscode.window.showInformationMessage(`New chat session created`);
            
            this._postMessage({
                type: 'sessionChanged',
                sessionId: session.id,
                history: []
            });
        } catch (error: any) {
            logError('Failed to create session:', error);
            vscode.window.showErrorMessage(`Failed to create session: ${error.message || error}`);
            this._postMessage({
                type: 'error',
                message: `Failed to create session: ${error}. Is Couchbase running?`
            });
        }
    }

    public async sendMessage(text: string, images?: string[]) {
        const messageText = text || '';
        debug('sendMessage called with:', { text: messageText.substring(0, 50) || '(empty)', imageCount: images?.length || 0 });
        
        if (this._isRequestInProgress) {
            debug('Request already in progress, ignoring');
            return;
        }

        if (!messageText.trim() && (!images || images.length === 0)) {
            debug('Empty message, ignoring');
            return;
        }

        if (!this._currentSessionId) {
            debug('No session, creating new one');
            try {
                await this.createNewSession();
            } catch (err) {
                logError('Failed to create session:', err);
                this._postMessage({ type: 'error', message: 'Failed to create session. Check Couchbase connection.' });
                return;
            }
        }

        if (!this._currentSessionId) {
            logError('Still no session after creation attempt');
            this._postMessage({ type: 'error', message: 'No active session. Check Couchbase connection.' });
            return;
        }

        this._isRequestInProgress = true;
        vscode.commands.executeCommand('setContext', 'grok.requestInProgress', true);

        const hasImages = images && images.length > 0;
        const request: ChatRequest = {
            text: messageText,
            timestamp: new Date().toISOString(),
            contextFiles: [],
            images: hasImages ? images : undefined
        };

        const pendingResponse: ChatResponse = {
            status: 'pending'
        };

        const pair: ChatPair = { request, response: pendingResponse };

        try {
            info('Saving message to Couchbase...');
            await appendPair(this._currentSessionId, pair);
            info('Message saved to Couchbase');
            
            const session = await getSession(this._currentSessionId);
            const pairIndex = session ? session.pairs.length - 1 : 0;
            
            this._postMessage({
                type: 'newMessagePair',
                pair,
                pairIndex
            });

            const apiKey = await this._context.secrets.get('grokApiKey');
            if (!apiKey) {
                vscode.window.showErrorMessage('API key not set. Run "Grok: Set API Key" command.');
                throw new Error('API key not set. Run "Grok: Set API Key" command.');
            }
            
            if (!apiKey.startsWith('xai-')) {
                logError('API key format invalid', { expected: 'xai-', got: apiKey.substring(0, 4) + '...' });
                vscode.window.showErrorMessage('Invalid API key format. xAI keys should start with "xai-". Re-run "Grok: Set API Key".');
                throw new Error('Invalid API key format. xAI keys should start with "xai-"');
            }
            
            info('API key found (starts with xai-), calling Grok API...');
            debug('API key length:', apiKey.length);

            const messages = await this._buildMessages(messageText, hasImages ? images : undefined);

            this._abortController = new AbortController();

            const config = vscode.workspace.getConfiguration('grok');
            const modelMode = config.get<string>('modelMode', 'fast');
            
            let model: string;
            if (hasImages) {
                model = config.get<string>('modelVision', 'grok-4');
            } else if (modelMode === 'smart') {
                model = config.get<string>('modelReasoning', 'grok-4');
            } else if (modelMode === 'base') {
                model = config.get<string>('modelBase', 'grok-3');
            } else {
                model = config.get<string>('modelFast', 'grok-3-mini');
            }
            
            info('Using model: ' + model + ' (mode: ' + modelMode + ')');
            
            request.model = model;

            const grokResponse = await sendChatCompletion(
                messages,
                model,
                apiKey,
                this._abortController.signal,
                (chunk) => {
                    this._postMessage({
                        type: 'updateResponseChunk',
                        pairIndex,
                        deltaText: chunk
                    });
                }
            );

            const successResponse: ChatResponse = {
                text: grokResponse.text,
                timestamp: new Date().toISOString(),
                status: 'success',
                usage: grokResponse.usage
            };

            await updateLastPairResponse(this._currentSessionId, successResponse);

            if (grokResponse.usage) {
                updateUsage(this._currentSessionId, grokResponse.usage, model);
                await updateSessionUsage(
                    this._currentSessionId, 
                    grokResponse.usage.promptTokens, 
                    grokResponse.usage.completionTokens,
                    model
                );
            }

            if (pairIndex === 0) {
                await this._generateSessionSummary(messageText, grokResponse.text);
            }

            const edits = parseCodeBlocksFromResponse(grokResponse.text);
            let diffPreview: { file: string; stats: { added: number; removed: number; modified: number } }[] = [];
            if (edits.length > 0) {
                diffPreview = await previewDiffStats(edits);
            }

            this._postMessage({
                type: 'requestComplete',
                pairIndex,
                response: successResponse,
                diffPreview
            });

            vscode.window.showInformationMessage('Grok completed the request.');

        } catch (error: any) {
            logError('sendMessage error:', error.message);
            vscode.window.showErrorMessage(`Grok error: ${error.message}`);
            
            const errorResponse: ChatResponse = {
                timestamp: new Date().toISOString(),
                status: error.name === 'AbortError' ? 'cancelled' : 'error',
                errorMessage: error.message
            };

            try {
                await updateLastPairResponse(this._currentSessionId!, errorResponse);
            } catch (dbError) {
                logError('Failed to save error to Couchbase:', dbError);
            }

            this._postMessage({
                type: 'error',
                message: error.message
            });

        } finally {
            this._isRequestInProgress = false;
            this._abortController = undefined;
            vscode.commands.executeCommand('setContext', 'grok.requestInProgress', false);
        }
    }

    public cancelCurrentRequest() {
        if (this._abortController) {
            this._abortController.abort();
            this._postMessage({
                type: 'requestCancelled'
            });
        }
    }

    public async retryLastRequest() {
        if (!this._currentSessionId) return;

        try {
            const session = await getSession(this._currentSessionId);
            if (session && session.pairs.length > 0) {
                const lastPair = session.pairs[session.pairs.length - 1];
                await this.sendMessage(lastPair.request.text);
            }
        } catch (error) {
            console.error('Failed to retry:', error);
        }
    }

    public async retryMessage(pairIndex: number) {
        if (!this._currentSessionId) return;

        try {
            const session = await getSession(this._currentSessionId);
            if (session && session.pairs[pairIndex]) {
                await this.sendMessage(session.pairs[pairIndex].request.text);
            }
        } catch (error) {
            console.error('Failed to retry message:', error);
        }
    }

    private async applyEdits(editId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            const action = await vscode.window.showErrorMessage(
                'No folder open. Open a folder to apply code changes.',
                'Open Folder'
            );
            if (action === 'Open Folder') {
                vscode.commands.executeCommand('vscode.openFolder');
            }
            return;
        }

        if (!this._currentSessionId) {
            vscode.window.showErrorMessage('No active session');
            return;
        }

        try {
            const session = await getSession(this._currentSessionId);
            if (!session || session.pairs.length === 0) {
                vscode.window.showErrorMessage('No messages in session');
                return;
            }

            const lastSuccessPair = [...session.pairs].reverse().find(p => p.response.status === 'success' && p.response.text);
            if (!lastSuccessPair || !lastSuccessPair.response.text) {
                vscode.window.showErrorMessage('No code blocks found to apply');
                return;
            }

            debug('Parsing response text length:', lastSuccessPair.response.text.length);
            debug('Response text sample:', lastSuccessPair.response.text.substring(0, 200));
            
            const edits = parseCodeBlocksFromResponse(lastSuccessPair.response.text);
            
            if (edits.length === 0) {
                const hasEmoji = lastSuccessPair.response.text.includes('📄');
                const hasCodeBlock = lastSuccessPair.response.text.includes('```');
                logError('No edits found', { hasEmoji, hasCodeBlock });
                vscode.window.showWarningMessage(
                    `No code blocks with 📄 filename pattern found. ` +
                    `Ask Grok to format changes as: 📄 filename.py followed by a code block.`
                );
                return;
            }

            let editsToApply = edits;
            if (editId && editId !== 'all') {
                editsToApply = edits.filter(e => e.fileUri.fsPath.includes(editId));
            }

            if (editsToApply.length === 0) {
                vscode.window.showErrorMessage(`No edits found for: ${editId}`);
                return;
            }

            const editGroupId = `${this._currentSessionId}-${Date.now()}`;

            const cost = lastSuccessPair.response.usage 
                ? (lastSuccessPair.response.usage.promptTokens / 1_000_000) * 0.30 + 
                  (lastSuccessPair.response.usage.completionTokens / 1_000_000) * 0.50
                : 0;
            const tokensUsed = lastSuccessPair.response.usage?.totalTokens || 0;

            const result = await doApplyEdits(
                editsToApply, 
                editGroupId, 
                this._currentSessionId,
                cost,
                tokensUsed
            );

            if (!result.success) {
                vscode.window.showErrorMessage(`Failed to apply edits: ${result.error}`);
                return;
            }

            await this._context.globalState.update('grok.lastEditGroupId', editGroupId);

            vscode.window.showInformationMessage(`Applied ${editsToApply.length} edit(s)`);
            
            this._postMessage({
                type: 'editsApplied',
                editId,
                count: editsToApply.length,
                changeSet: result.changeSet ? {
                    id: result.changeSet.id,
                    totalStats: result.changeSet.totalStats,
                    cost: result.changeSet.cost,
                    duration: getChangeTracker().formatDuration(result.changeSet.durationMs)
                } : undefined
            });

        } catch (error: any) {
            logError('Failed to apply edits:', error);
            vscode.window.showErrorMessage(`Failed to apply edits: ${error.message}`);
        }
    }

    public async revertLastEdits() {
        try {
            const lastEditGroupId = this._context.globalState.get<string>('grok.lastEditGroupId');
            if (!lastEditGroupId) {
                vscode.window.showInformationMessage('No edits to revert');
                return;
            }

            await revertEdits(lastEditGroupId);
            await this._context.globalState.update('grok.lastEditGroupId', undefined);
            vscode.window.showInformationMessage('Edits reverted successfully');
        } catch (error: any) {
            logError('Failed to revert edits:', error);
            vscode.window.showErrorMessage(`Failed to revert: ${error.message}`);
        }
    }

    public async runTerminalCommand(command: string) {
        if (!command || command.trim().length === 0) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const cwd = workspaceFolders?.[0]?.uri.fsPath || process.cwd();

        info('Running terminal command:', command);

        try {
            const { exec } = require('child_process');
            
            const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                exec(command, { cwd, maxBuffer: 1024 * 1024, timeout: 30000 }, (error: any, stdout: string, stderr: string) => {
                    if (error && !stdout && !stderr) {
                        reject(error);
                    } else {
                        resolve({ stdout: stdout || '', stderr: stderr || '' });
                    }
                });
            });

            const output = (result.stdout + result.stderr).trim();
            
            this._postMessage({
                type: 'commandOutput',
                command,
                output: output.slice(0, 5000)
            });

            if (output) {
                await this.sendMessage(`I ran the command: \`${command}\`\n\nOutput:\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\`\n\nPlease analyze this output.`);
            }

        } catch (error: any) {
            logError('Command failed:', error);
            this._postMessage({
                type: 'commandOutput',
                command,
                output: `Error: ${error.message}`,
                isError: true
            });
        }
    }

    private async _buildMessages(userText: string, images?: string[]): Promise<GrokMessage[]> {
        const messages: GrokMessage[] = [];

        const agentContext = await readAgentContext();
        let systemPrompt = `You are Grok, an AI coding assistant integrated into VS Code. Help the user with their coding tasks.

IMPORTANT: When creating or modifying files, you MUST use this exact format so the IDE can apply changes automatically:

📄 filename.ext
\`\`\`language
// complete file contents here
\`\`\`

For example, to create a Python file:
📄 script.py
\`\`\`python
print("Hello World")
\`\`\`

Rules:
- Always use the 📄 emoji followed by the filename on its own line
- The code block must immediately follow the filename
- Include the full file content, not snippets
- You may include explanatory text before or after, but the 📄 filename + code block pattern is required for the Apply button to work

TERMINAL COMMANDS: You can suggest terminal commands for the user to run. Use this format:
🖥️ \`command here\`

For example:
🖥️ \`grep -r "TODO" src/\`
🖥️ \`python script.py\`

The user can click to execute these commands and see the output.

TODO LIST: For any task involving multiple steps or file changes, START your response with a TODO list in this exact format:
📋 TODOS
- [ ] First step description
- [ ] Second step description  
- [ ] Third step description

As you complete each step, the UI will track progress. Keep steps concise (under 50 chars each).
`;

        if (agentContext) {
            systemPrompt += `\n\nProject Context:\n${agentContext}`;
        }

        messages.push({ role: 'system', content: systemPrompt });

        if (this._currentSessionId) {
            try {
                const session = await getSession(this._currentSessionId);
                if (session) {
                    const recentPairs = session.pairs.slice(-10);
                    for (const pair of recentPairs) {
                        messages.push({ role: 'user', content: pair.request.text });
                        if (pair.response.text) {
                            messages.push({ role: 'assistant', content: pair.response.text });
                        }
                    }
                }
            } catch (error) {
                console.error('Failed to load history:', error);
            }
        }

        if (images && images.length > 0) {
            messages.push(createVisionMessage(userText, images));
        } else {
            messages.push({ role: 'user', content: userText });
        }

        return messages;
    }

    private _postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Grok</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);height:100vh;display:flex;flex-direction:column}
#hdr{padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;justify-content:space-between;align-items:center;font-size:11px}
#hdr-btns{display:flex;gap:6px;align-items:center}
#auto-btn,#model-btn{border:none;border-radius:4px;padding:4px 8px;font-size:12px;font-weight:700;cursor:pointer;min-width:24px}
#auto-btn.auto{background:#2d7d46;color:#fff}
#auto-btn.manual{background:#333;color:#fff}
#model-btn.fast{background:#0099ff;color:#fff}
#model-btn.smart{background:#7c3aed;color:#fff}
#model-btn.base{background:#666;color:#fff}
#new{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:500;cursor:pointer}
#new:hover{background:var(--vscode-button-hoverBackground)}
#cfg{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;padding:4px 8px;font-size:16px;cursor:pointer}
#cfg:hover{background:var(--vscode-button-secondaryHoverBackground)}
#status-dot{font-size:12px;cursor:pointer;transition:color .3s}
#status-dot.ok{color:#4ec9b0}
#status-dot.warn{color:#dcdcaa}
#status-dot.err{color:#f14c4c}
#status-dot.checking{animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
#sess{cursor:pointer;display:flex;align-items:center;gap:4px;max-width:60%;overflow:hidden}
#sess-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sess:hover{color:var(--vscode-textLink-foreground)}
#hist{display:none;position:absolute;top:28px;left:0;right:0;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);max-height:300px;overflow-y:auto;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.3)}
#hist.show{display:block}
.hist-item{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:2px}
.hist-item:hover{background:var(--vscode-list-hoverBackground)}
.hist-item.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.hist-sum{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hist-meta{font-size:10px;color:var(--vscode-descriptionForeground)}

/* TODO Panel - Always visible */
#todo-bar{display:flex;padding:6px 10px;background:var(--vscode-titleBar-activeBackground);border-bottom:1px solid var(--vscode-panel-border);align-items:center;gap:8px;font-size:11px;cursor:pointer}
#todo-bar:hover{background:var(--vscode-list-hoverBackground)}
#todo-bar.has-todos{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;margin:4px 6px}
#todo-toggle{font-size:10px;transition:transform .2s}
#todo-toggle.open{transform:rotate(90deg)}
#todo-title{font-weight:600}
#todo-count{color:var(--vscode-descriptionForeground)}
#todo-count.active{color:var(--vscode-charts-green);font-weight:600}
#todo-list{display:none;padding:6px 10px 10px 24px;background:var(--vscode-editor-background);font-size:11px;margin:0 6px 4px 6px;border:1px solid var(--vscode-panel-border);border-top:none;border-radius:0 0 4px 4px}
#todo-list.show{display:block}
.todo-item{padding:3px 0;display:flex;align-items:center;gap:6px}
.todo-item.done{text-decoration:line-through;color:var(--vscode-descriptionForeground)}
.todo-item .check{color:var(--vscode-testing-iconPassed)}
.stat-add{color:#4ec9b0}
.stat-rem{color:#f14c4c}
.stat-mod{color:#dcdcaa}

/* Expanded Changes Panel (dropdown from stats bar) */
#changes-panel{display:none;position:absolute;bottom:80px;left:0;right:0;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);max-height:250px;overflow:hidden;flex-direction:column;z-index:99;box-shadow:0 -4px 12px rgba(0,0,0,.3)}
#changes-panel.show{display:flex}
#changes-hdr{padding:6px 10px;background:var(--vscode-titleBar-activeBackground);display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:600}
#changes-list{overflow-y:auto;flex:1}
.change-item{padding:8px 10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:4px;cursor:pointer;transition:background .2s}
.change-item:hover{background:var(--vscode-list-hoverBackground)}
.change-item.current{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.change-item.applied{border-left:3px solid var(--vscode-testing-iconPassed)}
.change-item.reverted{border-left:3px solid var(--vscode-descriptionForeground);opacity:.7}
.change-files{display:flex;flex-wrap:wrap;gap:4px;font-size:11px}
.change-file{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:2px 6px;border-radius:3px;font-size:10px}
.change-stats{display:flex;gap:8px;align-items:center;font-size:11px}
.change-meta{display:flex;gap:8px;font-size:10px;color:var(--vscode-descriptionForeground)}
.change-cost{color:var(--vscode-charts-green)}

#chat{flex:1;overflow-y:auto;padding:10px;scroll-behavior:smooth}
.msg{margin-bottom:10px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.5;word-wrap:break-word}
.msg.u{background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-left:20%;border-radius:12px 12px 4px 12px}
.msg.a{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);margin-right:5%;border-radius:12px 12px 12px 4px}
.msg.p{opacity:.7}
.msg.e{background:var(--vscode-inputValidation-errorBackground);border-color:var(--vscode-inputValidation-errorBorder)}
.msg .c{line-height:1.6}
.msg .c p{margin:8px 0}
.msg .c ul,.msg .c ol{margin:8px 0 8px 20px}
.msg .c li{margin:4px 0}
.msg .c h1,.msg .c h2,.msg .c h3{margin:12px 0 8px 0;color:var(--vscode-textLink-foreground)}
.msg .c h1{font-size:16px}.msg .c h2{font-size:14px}.msg .c h3{font-size:13px}
.think{display:flex;align-items:center;gap:8px;color:var(--vscode-descriptionForeground);font-size:12px;padding:6px 0}
.spin{width:14px;height:14px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.diff{margin:10px 0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}
.diff-h{background:var(--vscode-titleBar-activeBackground);padding:6px 10px;display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:500}
.diff-stats{display:flex;gap:6px;font-size:11px}
.diff-c{font-family:var(--vscode-editor-font-family);font-size:12px;overflow-x:auto;max-height:300px;overflow-y:auto}
.diff-c pre{margin:0;padding:10px;background:var(--vscode-textCodeBlock-background)}
.diff-c code{font-size:12px;line-height:1.4}
pre{background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:6px;overflow-x:auto;margin:8px 0;font-size:12px;line-height:1.4;border:1px solid var(--vscode-panel-border)}
code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:2px 5px;border-radius:3px;font-size:12px}
pre code{background:none;padding:0}
.btn{padding:4px 10px;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:500}
.btn-p{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-ok{background:var(--vscode-testing-iconPassed);color:#fff}
.done{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 10px;background:rgba(80,200,80,.1);border-radius:6px;border:1px solid var(--vscode-testing-iconPassed);font-size:12px}
.done-txt{font-weight:600;color:var(--vscode-testing-iconPassed)}
#inp{padding:8px;border-top:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:6px}
#stats{display:flex;justify-content:space-between;font-size:10px;color:var(--vscode-descriptionForeground);padding:0 4px;cursor:pointer}
#stats:hover{background:var(--vscode-list-hoverBackground);margin:0 -4px;padding:2px 8px;border-radius:4px}
#stats-left{display:flex;align-items:center;gap:8px}
#stats-left .changes-info{display:flex;gap:6px}
#stats-right{display:flex;align-items:center;gap:8px}
#stats .cost{color:var(--vscode-charts-green);font-weight:600}
#stats .pct{display:flex;align-items:center;gap:4px}
#inp-row{display:flex;gap:6px;align-items:flex-end}
#msg{flex:1;padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:6px;resize:none;min-height:36px;max-height:120px;font-family:inherit;font-size:13px;line-height:1.4}
#send{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:13px;font-weight:500}
#stop{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;background:#c44;color:#fff;display:none;font-size:13px;font-weight:500}
#stop.vis{display:block}
#attach{padding:8px;border:none;border-radius:6px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:16px}
#attach:hover{background:var(--vscode-button-secondaryHoverBackground)}
#img-preview{display:none;gap:6px;flex-wrap:wrap;padding:4px 0}
#img-preview.show{display:flex}
.img-thumb{position:relative;width:52px;height:52px;border-radius:6px;overflow:hidden;border:1px solid var(--vscode-panel-border)}
.img-thumb img{width:100%;height:100%;object-fit:cover}
.img-thumb .rm{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#c44;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:none}

.apply-all{margin:10px 0;padding:8px 12px;background:var(--vscode-testing-iconPassed);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%}
.apply-all:hover{opacity:.9}
.term-out{margin:10px 0;background:#1e1e1e;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}
.term-hdr{background:#333;padding:6px 10px;font-size:11px;color:#aaa;display:flex;justify-content:space-between;align-items:center}
.term-body{padding:10px;font-family:var(--vscode-editor-font-family);font-size:11px;color:#d4d4d4;white-space:pre-wrap;max-height:200px;overflow-y:auto}
.term-cmd{color:#569cd6}
</style></head><body>
<div id="hdr"><div id="sess" title="Click to view chat history"><span>▼</span><span id="sess-text">New Chat</span></div><div id="hdr-btns"><span id="status-dot" title="Connection status">●</span><button id="model-btn" class="fast" title="Model: F=Fast, S=Smart, B=Base&#10;Click to cycle">F</button><button id="auto-btn" class="auto" title="Auto/Manual apply">A</button><button id="new">+ New Chat</button><button id="cfg">⚙️</button></div></div>
<div id="hist"></div>

<div id="chat"></div>

<!-- Expanded Changes Panel (dropdown from stats bar) -->
<div id="changes-panel">
    <div id="changes-hdr"><span>📁 Change History</span><span id="changes-close" style="cursor:pointer">✕</span></div>
    <div id="changes-list"></div>
</div>

<div id="inp">
<!-- TODO Panel - above stats bar -->
<div id="todo-bar"><span id="todo-toggle">▶</span><span id="todo-title">TODOs</span><span id="todo-count">(0/0)</span></div>
<div id="todo-list"></div>

<div id="stats">
    <div id="stats-left"><span id="stats-changes">0 files</span><span class="changes-info"><span class="stat-add">+0</span><span class="stat-rem">-0</span><span class="stat-mod">~0</span></span></div>
    <div id="stats-right"><span class="cost" id="stats-cost">$0.00</span><span class="pct">○ <span id="stats-pct">0%</span></span></div>
</div>
<div id="img-preview"></div>
<div id="inp-row"><button id="attach" title="Attach image">📎</button><textarea id="msg" placeholder="Ask Grok..." rows="1"></textarea><button id="send">Send</button><button id="stop">Stop</button></div>
<input type="file" id="file-input" accept="image/*" multiple style="display:none">
</div>
<script>
const vs=acquireVsCodeApi(),chat=document.getElementById('chat'),msg=document.getElementById('msg'),send=document.getElementById('send'),stop=document.getElementById('stop'),sessEl=document.getElementById('sess'),sessTxt=document.getElementById('sess-text'),hist=document.getElementById('hist'),attachBtn=document.getElementById('attach'),fileInput=document.getElementById('file-input'),imgPreview=document.getElementById('img-preview'),statsEl=document.getElementById('stats');
const changesPanel=document.getElementById('changes-panel'),changesList=document.getElementById('changes-list'),changesClose=document.getElementById('changes-close');
const todoBar=document.getElementById('todo-bar'),todoToggle=document.getElementById('todo-toggle'),todoCount=document.getElementById('todo-count'),todoList=document.getElementById('todo-list');
const autoBtn=document.getElementById('auto-btn');
const modelBtn=document.getElementById('model-btn');
let busy=0,curDiv=null,stream='',curSessId='',attachedImages=[],totalTokens=0,totalCost=0;
let changeHistory=[],currentChangePos=-1,enterToSend=false,autoApply=true,modelMode='fast';
let currentTodos=[],todosCompleted=0,todoExpanded=false;
const CTX_LIMIT=128000;

// Status indicator
const statusDot=document.getElementById('status-dot');
let connectionStatus={couchbase:null,api:null};
function updateStatusDot(){
    const cb=connectionStatus.couchbase,api=connectionStatus.api;
    if(cb===null||api===null){statusDot.className='checking';statusDot.title='Checking connections...';}
    else if(cb&&api){statusDot.className='ok';statusDot.title='All connections OK';}
    else if(cb||api){statusDot.className='warn';statusDot.title=(cb?'':'Couchbase: Failed\\n')+(api?'':'API: Failed');}
    else{statusDot.className='err';statusDot.title='All connections failed';}
}
statusDot.onclick=()=>vs.postMessage({type:'testConnections'});
updateStatusDot();

// Auto/Manual toggle
autoBtn.onclick=()=>vs.postMessage({type:'toggleAutoApply'});

// Model mode toggle (F=Fast, S=Smart, O=Old)
modelBtn.onclick=()=>{
    const modes=['fast','smart','base'];
    const idx=(modes.indexOf(modelMode)+1)%modes.length;
    modelMode=modes[idx];
    updateModelBtn();
    vs.postMessage({type:'setModelMode',mode:modelMode});
};
function updateModelBtn(){
    const labels={fast:'F',smart:'S',base:'B'};
    const titles={fast:'Fast - Quick responses, cost-efficient',smart:'Smart - Reasoning model for complex tasks',base:'Base - Standard model'};
    modelBtn.textContent=labels[modelMode]||'F';
    modelBtn.className=modelMode||'fast';
    modelBtn.title='Model: '+titles[modelMode]+'\\nClick to cycle: F→S→B';
}

// TODO bar toggle
todoBar.onclick=()=>{todoExpanded=!todoExpanded;todoToggle.classList.toggle('open',todoExpanded);todoList.classList.toggle('show',todoExpanded);};

// Stats bar click -> show changes panel
statsEl.onclick=()=>changesPanel.classList.toggle('show');
changesClose.onclick=e=>{e.stopPropagation();changesPanel.classList.remove('show');};
document.addEventListener('click',e=>{if(!statsEl.contains(e.target)&&!changesPanel.contains(e.target))changesPanel.classList.remove('show');});

function updateAutoBtn(){autoBtn.textContent=autoApply?'A':'M';autoBtn.className=autoApply?'auto':'manual';autoBtn.title=autoApply?'Auto Apply (click for Manual)':'Manual Apply (click for Auto)';}

function renderTodos(){
    if(currentTodos.length===0){
        todoBar.classList.remove('has-todos');
        todoCount.classList.remove('active');
        todoCount.textContent='(no tasks)';
        todoList.innerHTML='<div style="color:var(--vscode-descriptionForeground);font-style:italic">No active tasks. AI will populate this when given multi-step work.</div>';
        return;
    }
    todoBar.classList.add('has-todos');
    const allDone=todosCompleted>=currentTodos.length;
    todoCount.classList.toggle('active',!allDone);
    todoCount.textContent=allDone?'✓ Complete':'('+todosCompleted+'/'+currentTodos.length+')';
    todoList.innerHTML=currentTodos.map((t,i)=>'<div class="todo-item'+(i<todosCompleted?' done':'')+'"><span class="check">'+(i<todosCompleted?'✓':'○')+'</span>'+esc(t)+'</div>').join('');
}

function parseTodos(text){
    const match=text.match(/📋\\s*TODOS?\\s*\\n([\\s\\S]*?)(?=\\n\\n|📄|$)/i);
    if(match){
        const lines=match[1].split('\\n').filter(l=>l.trim().match(/^-\\s*\\[.?\\]/));
        return lines.map(l=>l.replace(/^-\\s*\\[.?\\]\\s*/,'').trim()).filter(t=>t);
    }
    return [];
}

function renderChanges(){
    // Calculate totals from all changes
    let totalFiles=0,totalAdd=0,totalRem=0,totalMod=0;
    changeHistory.forEach(cs=>{if(cs.applied){totalFiles+=cs.files.length;totalAdd+=cs.totalStats.added;totalRem+=cs.totalStats.removed;totalMod+=cs.totalStats.modified;}});
    // Update stats bar left side
    document.getElementById('stats-changes').textContent=totalFiles+' file'+(totalFiles!==1?'s':'');
    const statsInfo=document.querySelector('#stats-left .changes-info');
    statsInfo.innerHTML='<span class="stat-add">+'+totalAdd+'</span><span class="stat-rem">-'+totalRem+'</span>'+(totalMod>0?'<span class="stat-mod">~'+totalMod+'</span>':'');
    // Render expanded list
    changesList.innerHTML='';
    changeHistory.forEach((cs,i)=>{
        const div=document.createElement('div');div.className='change-item'+(i===currentChangePos?' current':'')+(cs.applied?' applied':' reverted');
        div.dataset.id=cs.id;div.dataset.pos=i;
        const files=cs.files.map(f=>'<span class="change-file">'+esc(f.fileName)+'</span>').join('');
        const stats='<span class="stat-add">+'+cs.totalStats.added+'</span><span class="stat-rem">-'+cs.totalStats.removed+'</span>'+(cs.totalStats.modified>0?'<span class="stat-mod">~'+cs.totalStats.modified+'</span>':'');
        div.innerHTML='<div class="change-files">'+files+'</div><div class="change-stats">'+stats+'</div><div class="change-meta"><span>'+cs.duration+'</span><span class="change-cost">$'+cs.cost.toFixed(4)+'</span><span>'+timeAgo(cs.timestamp)+'</span></div>';
        div.onclick=()=>{const pos=parseInt(div.dataset.pos);if(pos<currentChangePos)vs.postMessage({type:'rewindTo',changeSetId:cs.id});else if(pos>currentChangePos)vs.postMessage({type:'forwardTo',changeSetId:cs.id});};
        changesList.appendChild(div);
    });
}

msg.addEventListener('input',()=>{msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,120)+'px'});
function updStats(usage){if(usage){totalTokens+=usage.totalTokens||0;const p=usage.promptTokens||0,c=usage.completionTokens||0;totalCost+=(p/1e6)*0.30+(c/1e6)*0.50;}const pct=Math.min(100,Math.round(totalTokens/CTX_LIMIT*100));document.getElementById('stats-cost').textContent='$'+totalCost.toFixed(2);document.getElementById('stats-pct').textContent=pct+'%';}
function doSend(){const t=msg.value.trim();if((t||attachedImages.length)&&!busy){vs.postMessage({type:'sendMessage',text:t,images:attachedImages});msg.value='';msg.style.height='auto';stream='';attachedImages=[];imgPreview.innerHTML='';imgPreview.classList.remove('show');}}
attachBtn.onclick=()=>fileInput.click();
fileInput.onchange=async e=>{const files=Array.from(e.target.files||[]);for(const f of files){if(!f.type.startsWith('image/'))continue;const reader=new FileReader();reader.onload=ev=>{const b64=ev.target.result.split(',')[1];attachedImages.push(b64);const thumb=document.createElement('div');thumb.className='img-thumb';thumb.innerHTML='<img src="'+ev.target.result+'"><button class="rm" data-i="'+(attachedImages.length-1)+'">×</button>';thumb.querySelector('.rm').onclick=function(){const i=parseInt(this.dataset.i);attachedImages.splice(i,1);updateImgPreview();};imgPreview.appendChild(thumb);imgPreview.classList.add('show');};reader.readAsDataURL(f);}fileInput.value='';};
function updateImgPreview(){imgPreview.innerHTML='';attachedImages.forEach((b64,i)=>{const thumb=document.createElement('div');thumb.className='img-thumb';thumb.innerHTML='<img src="data:image/png;base64,'+b64+'"><button class="rm" data-i="'+i+'">×</button>';thumb.querySelector('.rm').onclick=function(){attachedImages.splice(i,1);updateImgPreview();};imgPreview.appendChild(thumb);});imgPreview.classList.toggle('show',attachedImages.length>0);}
send.onclick=doSend;
// Enter key behavior: configurable via enterToSend setting
msg.onkeydown=e=>{
    if(enterToSend){
        if(e.key==='Enter'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();doSend();}
    }else{
        if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();doSend();}
    }
};
stop.onclick=()=>vs.postMessage({type:'cancelRequest'});
document.getElementById('new').onclick=()=>{hist.classList.remove('show');totalTokens=0;totalCost=0;currentTodos=[];todosCompleted=0;renderTodos();updStats(null);vs.postMessage({type:'newSession'});};
document.getElementById('cfg').onclick=()=>vs.postMessage({type:'openSettings'});
sessEl.onclick=()=>{if(hist.classList.contains('show')){hist.classList.remove('show');}else{vs.postMessage({type:'getHistory'});hist.classList.add('show');}};
document.addEventListener('click',e=>{if(!sessEl.contains(e.target)&&!hist.contains(e.target))hist.classList.remove('show');});
function scrollToBottom(){setTimeout(()=>{chat.scrollTop=chat.scrollHeight;},50);}
window.addEventListener('message',e=>{const m=e.data;
switch(m.type){
case'init':case'sessionChanged':
curSessId=m.sessionId;sessTxt.textContent=m.summary||('Session: '+m.sessionId.slice(0,8));sessTxt.title=m.summary||m.sessionId;
chat.innerHTML='';totalTokens=0;totalCost=0;if(m.history){m.history.forEach((p,i)=>{addPair(p,i,0);if(p.response.usage)updStats(p.response.usage);});}hist.classList.remove('show');scrollToBottom();break;
case'historyList':
hist.innerHTML='';m.sessions.forEach(s=>{const d=document.createElement('div');d.className='hist-item'+(s.id===m.currentSessionId?' active':'');
const sum=document.createElement('div');sum.className='hist-sum';sum.textContent=s.summary||'New chat';sum.title=s.summary||'';
const meta=document.createElement('div');meta.className='hist-meta';meta.textContent=timeAgo(s.updatedAt)+(s.pairCount?' · '+s.pairCount+' msgs':'');
d.appendChild(sum);d.appendChild(meta);d.onclick=()=>{vs.postMessage({type:'loadSession',sessionId:s.id});};hist.appendChild(d);});break;
case'newMessagePair':addPair(m.pair,m.pairIndex,1);busy=1;updUI();scrollToBottom();break;
case'updateResponseChunk':if(curDiv){stream+=m.deltaText;updStream();scrollToBottom();}break;
case'requestComplete':
if(curDiv){curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML=fmtFinal(m.response.text||'',m.response.usage,m.diffPreview);updStats(m.response.usage);}
// Parse TODOs from response
const todos=parseTodos(m.response.text||'');if(todos.length>0){currentTodos=todos;todosCompleted=0;renderTodos();}
// Auto-apply if enabled and has code blocks
if(autoApply&&m.diffPreview&&m.diffPreview.length>0){vs.postMessage({type:'applyEdits',editId:'all'});}
busy=0;curDiv=null;stream='';updUI();scrollToBottom();break;
case'requestCancelled':if(curDiv){curDiv.classList.add('e');curDiv.querySelector('.c').innerHTML+='<div style="color:#c44;margin-top:6px">⏹ Cancelled</div>';}busy=0;curDiv=null;stream='';updUI();break;
case'error':if(curDiv){curDiv.classList.add('e');curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML='<div style="color:#c44">⚠️ Error: '+esc(m.message)+'</div><button class="btn btn-s" style="margin-top:6px" onclick="vs.postMessage({type:\\'retryLastRequest\\'})">Retry</button>';}busy=0;curDiv=null;stream='';updUI();break;
case'usageUpdate':updStats(m.usage);break;
case'commandOutput':showCmdOutput(m.command,m.output,m.isError);break;
case'changesUpdate':changeHistory=m.changes;currentChangePos=m.currentPosition;renderChanges();break;
case'editsApplied':if(m.changeSet){vs.postMessage({type:'getChanges'});todosCompleted=Math.min(todosCompleted+1,currentTodos.length);renderTodos();}break;
case'config':enterToSend=m.enterToSend||false;autoApply=m.autoApply!==false;modelMode=m.modelMode||'fast';updateAutoBtn();updateModelBtn();break;
case'connectionStatus':connectionStatus.couchbase=m.couchbase;connectionStatus.api=m.api;updateStatusDot();break;
}});
function showCmdOutput(cmd,out,isErr){const div=document.createElement('div');div.className='msg a';div.innerHTML='<div class="c"><div class="term-out"><div class="term-hdr"><span class="term-cmd">$ '+esc(cmd)+'</span><span style="color:'+(isErr?'#c44':'#6a9')+'">'+( isErr?'Failed':'Done')+'</span></div><div class="term-body">'+esc(out)+'</div></div></div>';chat.appendChild(div);scrollToBottom();}
function timeAgo(d){const s=Math.floor((Date.now()-new Date(d))/1e3);if(s<60)return'now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function addPair(p,i,streaming){const u=document.createElement('div');u.className='msg u';u.textContent=p.request.text;chat.appendChild(u);
const a=document.createElement('div');a.className='msg a';a.dataset.i=i;
if(p.response.status==='pending'&&streaming){a.classList.add('p');a.innerHTML='<div class="c"><div class="think"><div class="spin"></div>Thinking...</div></div>';curDiv=a;}
else if(p.response.status==='error'){a.classList.add('e');a.innerHTML='<div class="c">⚠️ Error: '+esc(p.response.errorMessage||'')+'</div>';}
else if(p.response.status==='cancelled'){a.innerHTML='<div class="c">'+fmtFinal(p.response.text||'',null,null)+'<div style="color:#c44;margin-top:6px">⏹ Cancelled</div></div>';}
else{a.innerHTML='<div class="c">'+fmtFinal(p.response.text||'',p.response.usage,null)+'</div>';}
chat.appendChild(a);}
function updStream(){if(!curDiv)return;curDiv.querySelector('.c').innerHTML='<div class="think"><div class="spin"></div>Generating...</div><div style="font-size:12px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;max-height:200px;overflow:hidden;line-height:1.5;margin-top:8px">'+fmtMd(stream.slice(-600))+'</div>';}
function fmtFinal(t,u,diffPreview){let h=fmtCode(t,diffPreview);const uInfo=u?'<span style="margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground)">'+u.totalTokens.toLocaleString()+' tokens</span>':'';h+='<div class="done"><span style="color:var(--vscode-testing-iconPassed);font-size:14px">✓</span><span class="done-txt">Done</span>'+uInfo+'</div>';return h;}
function fmtCode(t,diffPreview){
let out=t;const fileBlocks=[];const bt=String.fromCharCode(96);
const pat=new RegExp('[📄🗎]\\\\s*([^\\\\s\\\\n(]+)\\\\s*(?:\\\\(lines?\\\\s*(\\\\d+)(?:-(\\\\d+))?\\\\))?[\\\\s\\\\n]*'+bt+bt+bt+'(\\\\w+)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt,'g');
let m;while((m=pat.exec(t))!==null){fileBlocks.push({full:m[0],file:m[1],code:m[5],lang:m[4]||''});}
if(fileBlocks.length>1){out='<button class="apply-all" onclick="applyAll()">✅ Apply All '+fileBlocks.length+' Files</button>'+out;}
const previewMap={};if(diffPreview){diffPreview.forEach(dp=>{previewMap[dp.file]=dp.stats;});}
fileBlocks.forEach(b=>{
const stats=previewMap[b.file]||{added:0,removed:0,modified:0};
const statsHtml='<span class="stat-add">+'+stats.added+'</span> <span class="stat-rem">-'+stats.removed+'</span>'+(stats.modified>0?' <span class="stat-mod">~'+stats.modified+'</span>':'');
const diffHtml='<div class="diff"><div class="diff-h"><span>📄 '+esc(b.file)+'</span><div class="diff-stats">'+statsHtml+'</div><button class="btn btn-ok" onclick="applyFile(\\''+esc(b.file)+'\\')">Apply</button></div><div class="diff-c"><pre><code>'+esc(b.code)+'</code></pre></div></div>';out=out.replace(b.full,diffHtml);});
return fmtMd(out);}
function fmtMd(t){const bt=String.fromCharCode(96);
t=t.replace(new RegExp(bt+bt+bt+'(\\\\w+)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt,'g'),'<pre><code>$2</code></pre>');
t=t.replace(new RegExp('🖥️\\\\s*'+bt+'([^'+bt+']+)'+bt,'g'),'<div class="term-out"><div class="term-hdr"><span class="term-cmd">$ $1</span><button class="btn btn-s" onclick="runCmd(\\'$1\\')">▶ Run</button></div></div>');
t=t.replace(new RegExp(bt+'([^'+bt+'\\\\n]+)'+bt,'g'),'<code>$1</code>');
t=t.replace(/^### (.+)$/gm,'<h3>$1</h3>');
t=t.replace(/^## (.+)$/gm,'<h2>$1</h2>');
t=t.replace(/^# (.+)$/gm,'<h1>$1</h1>');
t=t.replace(/^- (.+)$/gm,'<li>$1</li>');
t=t.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
t=t.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
t=t.replace(/\\n\\n/g,'</p><p>');
t=t.replace(/\\n/g,'<br>');
return '<p>'+t+'</p>';}
function esc(t){const d=document.createElement('div');d.textContent=t||'';return d.innerHTML;}
function applyFile(f){vs.postMessage({type:'applyEdits',editId:f});}
function applyAll(){vs.postMessage({type:'applyEdits',editId:'all'});}
function runCmd(c){vs.postMessage({type:'runCommand',command:c});}
function updUI(){stop.classList.toggle('vis',busy);send.disabled=busy;msg.disabled=busy;if(!busy)msg.focus();}
vs.postMessage({type:'ready'});
vs.postMessage({type:'getConfig'});
</script></body></html>`;
    }
}
