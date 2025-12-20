import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { sendChatCompletion, GrokMessage, createVisionMessage } from '../api/grokClient';
import { 
    createSession, 
    getSession, 
    appendPair, 
    updateLastPairResponse,
    updateSessionSummary,
    listSessions,
    ChatPair,
    ChatRequest,
    ChatResponse,
    ChatSessionDocument
} from '../storage/chatSessionRepository';
import { readAgentContext } from '../context/workspaceContext';
import { getModelName, ModelType, debug, info, error as logError, detectModelType } from '../utils/logger';
import { parseCodeBlocksFromResponse, applyEdits as doApplyEdits, revertEdits, ProposedEdit } from '../edits/codeActions';
import { updateUsage, setCurrentSession } from '../usage/tokenTracker';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'grokChatView';

    private _view?: vscode.WebviewView;
    private _currentSessionId?: string;
    private _abortController?: AbortController;
    private _isRequestInProgress = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

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

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            info('Received message from webview:', message.type);
            
            switch (message.type) {
                case 'sendMessage':
                    info('Processing sendMessage:', message.text?.substring(0, 30), 'images:', message.images?.length || 0);
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
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'grok');
                    break;
                case 'ready':
                    await this._initializeSession();
                    break;
                case 'loadSession':
                    await this.loadSession(message.sessionId);
                    break;
                case 'getHistory':
                    await this._sendSessionHistory();
                    break;
            }
        });
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

            // Use a quick call to generate a short summary
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
        
        // Try to load existing session or create new one
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

        // Create new session
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
        debug('sendMessage called with:', text.substring(0, 50), 'images:', images?.length || 0);
        
        if (this._isRequestInProgress) {
            debug('Request already in progress, ignoring');
            return;
        }

        // Ensure we have a session
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

        // Create the request
        const hasImages = images && images.length > 0;
        const request: ChatRequest = {
            text,
            timestamp: new Date().toISOString(),
            contextFiles: [],
            images: hasImages ? images : undefined
        };

        // Create pending response
        const pendingResponse: ChatResponse = {
            status: 'pending'
        };

        const pair: ChatPair = { request, response: pendingResponse };

        try {
            info('Saving message to Couchbase...');
            // Save to Couchbase BEFORE API call
            await appendPair(this._currentSessionId, pair);
            info('Message saved to Couchbase');
            
            // Notify webview of new pending message
            const session = await getSession(this._currentSessionId);
            const pairIndex = session ? session.pairs.length - 1 : 0;
            
            this._postMessage({
                type: 'newMessagePair',
                pair,
                pairIndex
            });

            // Get API key
            const apiKey = await this._context.secrets.get('grokApiKey');
            if (!apiKey) {
                vscode.window.showErrorMessage('API key not set. Run "Grok: Set API Key" command.');
                throw new Error('API key not set. Run "Grok: Set API Key" command.');
            }
            
            // Validate API key format (xAI keys start with "xai-")
            if (!apiKey.startsWith('xai-')) {
                logError('API key format invalid. Expected key starting with "xai-", got:', apiKey.substring(0, 4) + '...');
                vscode.window.showErrorMessage('Invalid API key format. xAI keys should start with "xai-". Re-run "Grok: Set API Key".');
                throw new Error('Invalid API key format. xAI keys should start with "xai-"');
            }
            
            info('API key found (starts with xai-), calling Grok API...');
            debug('API key length:', apiKey.length);

            // Build messages for API
            const messages = await this._buildMessages(text, hasImages ? images : undefined);

            // Create abort controller for cancellation
            this._abortController = new AbortController();

            // Auto-detect model type based on prompt complexity and images
            const modelType = detectModelType(text, hasImages);
            const model = getModelName(modelType);
            debug('Auto-detected model type:', modelType, '→ Using model:', model, hasImages ? '(with images)' : '');
            
            // Update request with the model used
            request.model = model;

            const grokResponse = await sendChatCompletion(
                messages,
                model,
                apiKey,
                this._abortController.signal,
                (chunk) => {
                    // Stream chunks to webview
                    this._postMessage({
                        type: 'updateResponseChunk',
                        pairIndex,
                        deltaText: chunk
                    });
                }
            );

            // Update response in Couchbase
            const successResponse: ChatResponse = {
                text: grokResponse.text,
                timestamp: new Date().toISOString(),
                status: 'success',
                usage: grokResponse.usage
            };

            await updateLastPairResponse(this._currentSessionId, successResponse);

            // Track token usage
            if (grokResponse.usage) {
                updateUsage(this._currentSessionId, grokResponse.usage, model);
            }

            // Generate summary if this is the first message in the session
            if (pairIndex === 0) {
                await this._generateSessionSummary(text, grokResponse.text);
            }

            // Notify completion
            this._postMessage({
                type: 'requestComplete',
                pairIndex,
                response: successResponse
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
        // Check for workspace folder
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
            // Get the session to find the response with code blocks
            const session = await getSession(this._currentSessionId);
            if (!session || session.pairs.length === 0) {
                vscode.window.showErrorMessage('No messages in session');
                return;
            }

            // Find the response that contains this edit (for now, use last successful response)
            const lastSuccessPair = [...session.pairs].reverse().find(p => p.response.status === 'success' && p.response.text);
            if (!lastSuccessPair || !lastSuccessPair.response.text) {
                vscode.window.showErrorMessage('No code blocks found to apply');
                return;
            }

            // Parse code blocks from response
            debug('Parsing response text length:', lastSuccessPair.response.text.length);
            debug('Response text sample:', lastSuccessPair.response.text.substring(0, 200));
            
            const edits = parseCodeBlocksFromResponse(lastSuccessPair.response.text);
            
            if (edits.length === 0) {
                // Try to show what we found
                const hasEmoji = lastSuccessPair.response.text.includes('📄');
                const hasCodeBlock = lastSuccessPair.response.text.includes('```');
                logError('No edits found. Has emoji:', hasEmoji, 'Has code block:', hasCodeBlock);
                vscode.window.showWarningMessage(
                    `No code blocks with 📄 filename pattern found. ` +
                    `Ask Grok to format changes as: 📄 filename.py followed by a code block.`
                );
                return;
            }

            // If editId is a filename, filter to just that file
            let editsToApply = edits;
            if (editId && editId !== 'all') {
                editsToApply = edits.filter(e => e.fileUri.fsPath.includes(editId));
            }

            if (editsToApply.length === 0) {
                vscode.window.showErrorMessage(`No edits found for: ${editId}`);
                return;
            }

            // Generate a unique ID for this edit group (for revert)
            const editGroupId = `${this._currentSessionId}-${Date.now()}`;

            // Apply the edits
            await doApplyEdits(editsToApply, editGroupId);

            // Store the edit group ID for potential revert
            await this._context.globalState.update('grok.lastEditGroupId', editGroupId);

            vscode.window.showInformationMessage(`Applied ${editsToApply.length} edit(s)`);
            
            // Notify webview
            this._postMessage({
                type: 'editsApplied',
                editId,
                count: editsToApply.length
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

    private async _buildMessages(userText: string, images?: string[]): Promise<GrokMessage[]> {
        const messages: GrokMessage[] = [];

        // Add system message with AGENT.md context
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
`;

        if (agentContext) {
            systemPrompt += `\n\nProject Context:\n${agentContext}`;
        }

        messages.push({ role: 'system', content: systemPrompt });

        // Add conversation history (last 10 pairs for context)
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

        // Add current user message (with images if present)
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
body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);height:100vh;display:flex;flex-direction:column}
#hdr{padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);display:flex;justify-content:space-between;align-items:center;font-size:11px}
#hdr button{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:11px;padding:2px 6px}
#hdr button:hover{text-decoration:underline}
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
#chat{flex:1;overflow-y:auto;padding:8px}
.msg{margin-bottom:8px;padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.4;word-wrap:break-word}
.msg.u{background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin-left:15%}
.msg.a{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);margin-right:5%}
.msg.p{opacity:.7}
.msg.e{background:var(--vscode-inputValidation-errorBackground);border-color:var(--vscode-inputValidation-errorBorder)}
.think{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground);font-size:11px;padding:4px 0}
.spin{width:12px;height:12px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.plan{margin:6px 0;padding:6px;background:var(--vscode-textBlockQuote-background);border-radius:4px;font-size:11px}
.plan-t{font-weight:bold;margin-bottom:4px;color:var(--vscode-textLink-foreground)}
.step{display:flex;gap:6px;padding:2px 0}
.step-i{width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}
.step.done .step-i{background:var(--vscode-testing-iconPassed);color:#fff}
.step.done .step-x{text-decoration:line-through;opacity:.6}
.step.cur .step-i{background:var(--vscode-textLink-foreground);color:#fff}
.step.pend .step-i{border:1px solid var(--vscode-descriptionForeground)}
.diff{margin:6px 0;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden;font-size:11px}
.diff-h{background:var(--vscode-titleBar-activeBackground);padding:4px 8px;display:flex;justify-content:space-between;align-items:center}
.diff-c{font-family:var(--vscode-editor-font-family);font-size:11px;overflow-x:auto}
.diff-l{padding:1px 6px;white-space:pre}
.diff-l.add{background:rgba(80,200,80,.15)}
.diff-l.del{background:rgba(200,80,80,.15)}
pre{background:var(--vscode-textCodeBlock-background);padding:6px;border-radius:4px;overflow-x:auto;margin:4px 0;font-size:11px}
code{font-family:var(--vscode-editor-font-family)}
.btn{padding:3px 8px;border:none;border-radius:3px;cursor:pointer;font-size:10px}
.btn-p{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-s{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-ok{background:var(--vscode-testing-iconPassed);color:#fff}
.done{display:flex;align-items:center;gap:6px;margin-top:8px;padding:6px 8px;background:rgba(80,200,80,.1);border-radius:4px;border:1px solid var(--vscode-testing-iconPassed);font-size:11px}
.done-txt{font-weight:bold;color:var(--vscode-testing-iconPassed)}
#inp{padding:6px;border-top:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:6px}
#inp-row{display:flex;gap:6px;align-items:flex-end}
#msg{flex:1;padding:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;resize:none;min-height:32px;max-height:100px;font-family:inherit;font-size:12px}
#send{padding:6px 12px;border:none;border-radius:4px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:12px}
#stop{padding:6px 12px;border:none;border-radius:4px;cursor:pointer;background:#c44;color:#fff;display:none;font-size:12px}
#stop.vis{display:block}
#attach{padding:6px;border:none;border-radius:4px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:14px}
#attach:hover{background:var(--vscode-button-secondaryHoverBackground)}
#img-preview{display:none;gap:4px;flex-wrap:wrap;padding:4px 0}
#img-preview.show{display:flex}
.img-thumb{position:relative;width:48px;height:48px;border-radius:4px;overflow:hidden;border:1px solid var(--vscode-panel-border)}
.img-thumb img{width:100%;height:100%;object-fit:cover}
.img-thumb .rm{position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;background:#c44;color:#fff;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:none}
</style></head><body>
<div id="hdr"><div id="sess" title="Click to view chat history"><span>▼</span><span id="sess-text">New Chat</span></div><div><button id="new">+ New</button><button id="cfg">⚙</button></div></div>
<div id="hist"></div>
<div id="chat"></div>
<div id="inp">
<div id="img-preview"></div>
<div id="inp-row"><button id="attach" title="Attach image">📎</button><textarea id="msg" placeholder="Ask Grok..." rows="1"></textarea><button id="send">Send</button><button id="stop">Stop</button></div>
<input type="file" id="file-input" accept="image/*" multiple style="display:none">
</div>
<script>
const vs=acquireVsCodeApi(),chat=document.getElementById('chat'),msg=document.getElementById('msg'),send=document.getElementById('send'),stop=document.getElementById('stop'),sessEl=document.getElementById('sess'),sessTxt=document.getElementById('sess-text'),hist=document.getElementById('hist'),attachBtn=document.getElementById('attach'),fileInput=document.getElementById('file-input'),imgPreview=document.getElementById('img-preview');
let busy=0,curDiv=null,stream='',curSessId='',attachedImages=[];
msg.addEventListener('input',()=>{msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,100)+'px'});
function doSend(){const t=msg.value.trim();if((t||attachedImages.length)&&!busy){vs.postMessage({type:'sendMessage',text:t,images:attachedImages});msg.value='';msg.style.height='auto';stream='';attachedImages=[];imgPreview.innerHTML='';imgPreview.classList.remove('show');}}
attachBtn.onclick=()=>fileInput.click();
fileInput.onchange=async e=>{
const files=Array.from(e.target.files||[]);
for(const f of files){
if(!f.type.startsWith('image/'))continue;
const reader=new FileReader();
reader.onload=ev=>{
const b64=ev.target.result.split(',')[1];
attachedImages.push(b64);
const thumb=document.createElement('div');thumb.className='img-thumb';
thumb.innerHTML='<img src="'+ev.target.result+'"><button class="rm" data-i="'+(attachedImages.length-1)+'">×</button>';
thumb.querySelector('.rm').onclick=function(){const i=parseInt(this.dataset.i);attachedImages.splice(i,1);updateImgPreview();};
imgPreview.appendChild(thumb);
imgPreview.classList.add('show');
};
reader.readAsDataURL(f);
}
fileInput.value='';
};
function updateImgPreview(){imgPreview.innerHTML='';attachedImages.forEach((b64,i)=>{const thumb=document.createElement('div');thumb.className='img-thumb';thumb.innerHTML='<img src="data:image/png;base64,'+b64+'"><button class="rm" data-i="'+i+'">×</button>';thumb.querySelector('.rm').onclick=function(){attachedImages.splice(i,1);updateImgPreview();};imgPreview.appendChild(thumb);});imgPreview.classList.toggle('show',attachedImages.length>0);}
send.onclick=doSend;
msg.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}};
stop.onclick=()=>vs.postMessage({type:'cancelRequest'});
document.getElementById('new').onclick=()=>{hist.classList.remove('show');vs.postMessage({type:'newSession'});};
document.getElementById('cfg').onclick=()=>vs.postMessage({type:'openSettings'});
sessEl.onclick=()=>{if(hist.classList.contains('show')){hist.classList.remove('show');}else{vs.postMessage({type:'getHistory'});hist.classList.add('show');}};
document.addEventListener('click',e=>{if(!sessEl.contains(e.target)&&!hist.contains(e.target))hist.classList.remove('show');});
window.addEventListener('message',e=>{const m=e.data;
switch(m.type){
case'init':case'sessionChanged':
curSessId=m.sessionId;sessTxt.textContent=m.summary||('Session: '+m.sessionId.slice(0,8));sessTxt.title=m.summary||m.sessionId;
chat.innerHTML='';if(m.history)m.history.forEach((p,i)=>addPair(p,i,0));hist.classList.remove('show');break;
case'historyList':
hist.innerHTML='';m.sessions.forEach(s=>{const d=document.createElement('div');d.className='hist-item'+(s.id===m.currentSessionId?' active':'');
const sum=document.createElement('div');sum.className='hist-sum';sum.textContent=s.summary||'New chat';sum.title=s.summary||'';
const meta=document.createElement('div');meta.className='hist-meta';meta.textContent=timeAgo(s.updatedAt)+(s.pairCount?' · '+s.pairCount+' msgs':'');
d.appendChild(sum);d.appendChild(meta);d.onclick=()=>{vs.postMessage({type:'loadSession',sessionId:s.id});};hist.appendChild(d);});break;
case'newMessagePair':addPair(m.pair,m.pairIndex,1);busy=1;updUI();break;
case'updateResponseChunk':if(curDiv){stream+=m.deltaText;updStream();chat.scrollTop=chat.scrollHeight;}break;
case'requestComplete':if(curDiv){curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML=fmtFinal(m.response.text||'',m.response.usage);}busy=0;curDiv=null;stream='';updUI();break;
case'requestCancelled':if(curDiv){curDiv.classList.add('e');curDiv.querySelector('.c').innerHTML+='<div style="color:#c44;margin-top:4px">Cancelled</div>';}busy=0;curDiv=null;stream='';updUI();break;
case'error':if(curDiv){curDiv.classList.add('e');curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML='<div style="color:#c44">Error: '+esc(m.message)+'</div><button class="btn btn-s" style="margin-top:4px" onclick="vs.postMessage({type:\\'retryLastRequest\\'})">Retry</button>';}busy=0;curDiv=null;stream='';updUI();break;
}});
function timeAgo(d){const s=Math.floor((Date.now()-new Date(d))/1e3);if(s<60)return'now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function addPair(p,i,streaming){const u=document.createElement('div');u.className='msg u';u.textContent=p.request.text;chat.appendChild(u);
const a=document.createElement('div');a.className='msg a';a.dataset.i=i;
if(p.response.status==='pending'&&streaming){a.classList.add('p');a.innerHTML='<div class="c"><div class="think"><div class="spin"></div>Thinking...</div></div>';curDiv=a;}
else if(p.response.status==='error'){a.classList.add('e');a.innerHTML='<div class="c">Error: '+esc(p.response.errorMessage||'')+'</div>';}
else if(p.response.status==='cancelled'){a.innerHTML='<div class="c">'+fmtFinal(p.response.text||'',null)+'<div style="color:#c44;margin-top:4px">Cancelled</div></div>';}
else{a.innerHTML='<div class="c">'+fmtFinal(p.response.text||'',p.response.usage)+'</div>';}
chat.appendChild(a);chat.scrollTop=chat.scrollHeight;}
function updStream(){if(!curDiv)return;curDiv.querySelector('.c').innerHTML='<div class="think"><div class="spin"></div>Processing...</div><div style="font-size:11px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;max-height:200px;overflow:hidden">'+esc(stream.slice(-400))+'</div>';}
function fmtFinal(t,u){let h=fmtCode(t);h+='<div class="done"><span style="color:var(--vscode-testing-iconPassed)">✓</span><span class="done-txt">Done</span>'+(u?'<span style="font-size:10px;color:var(--vscode-descriptionForeground)">'+u.totalTokens+' tokens</span>':'')+'</div>';return h;}
function fmtCode(t){
let out=t;
const fileBlocks=[];
const bt=String.fromCharCode(96);
const pat=new RegExp('[📄🗎]\\\\s*([^\\\\s\\\\n(]+)\\\\s*(?:\\\\(lines?\\\\s*(\\\\d+)(?:-(\\\\d+))?\\\\))?[\\\\s\\\\n]*'+bt+bt+bt+'(\\\\w+)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt,'g');
let m;while((m=pat.exec(t))!==null){fileBlocks.push({full:m[0],file:m[1],code:m[5],lang:m[4]||''});}
fileBlocks.forEach(b=>{
const diffHtml='<div class="diff"><div class="diff-h"><span>📄 '+esc(b.file)+'</span><div><button class="btn btn-ok" onclick="applyFile(\\''+esc(b.file)+'\\')">Apply</button></div></div><div class="diff-c"><pre style="margin:0"><code>'+esc(b.code)+'</code></pre></div></div>';
out=out.replace(b.full,diffHtml);
});
return fmtMd(out);
}
function fmtMd(t){const bt=String.fromCharCode(96);const codeBlock=new RegExp(bt+bt+bt+'(\\\\w+)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt,'g');const inlineCode=new RegExp(bt+'([^'+bt+']+)'+bt,'g');return t.replace(codeBlock,'<pre><code>$2</code></pre>').replace(inlineCode,'<code>$1</code>').replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>').replace(/\\*(.+?)\\*/g,'<em>$1</em>').replace(/\\n/g,'<br>');}
function esc(t){const d=document.createElement('div');d.textContent=t||'';return d.innerHTML;}
function applyFile(f){vs.postMessage({type:'applyEdits',editId:f});}
function updUI(){stop.classList.toggle('vis',busy);send.disabled=busy;msg.disabled=busy;if(!busy)msg.focus();}
vs.postMessage({type:'ready'});
</script></body></html>`;
    }
}
