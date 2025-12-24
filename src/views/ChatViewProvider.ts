import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import { sendChatCompletion, GrokMessage, createVisionMessage, testApiConnection, fetchLanguageModels, GrokModelInfo } from '../api/grokClient';
import { getCouchbaseClient } from '../storage/couchbaseClient';
import { 
    createSession, 
    getSession, 
    appendPair, 
    updateLastPairResponse,
    updateSessionSummary,
    updateSessionUsage,
    updateSessionModelUsage,
    updateSessionHandoff,
    updateSessionTodos,
    updateSessionChangeHistory,
    getSessionChangeHistory,
    appendSessionBug,
    listSessions,
    ChatPair,
    ChatRequest,
    ChatResponse,
    ChatSessionDocument,
    TodoItem,
    ChangeHistoryData,
    BugType,
    BugReporter
} from '../storage/chatSessionRepository';
import { readAgentContext } from '../context/workspaceContext';
import { buildSystemPrompt, getWorkspaceInfo } from '../prompts/systemPrompt';
import { parseResponse, GrokStructuredResponse } from '../prompts/responseParser';
import { parseWithCleanup } from '../prompts/jsonCleaner';
import { getModelName, ModelType, debug, info, error as logError, detectModelType } from '../utils/logger';
import { 
    parseCodeBlocksFromResponse, 
    applyEdits as doApplyEdits, 
    revertEdits, 
    ProposedEdit,
    getChangeTracker,
    revertToChangeSet,
    reapplyFromChangeSet,
    previewDiffStats,
    applySimpleDiff,
    validateFileChange,
    resolveFilePathToUri
} from '../edits/codeActions';
import { updateUsage, setCurrentSession, startStepTimer, endStepTimer, recordStep } from '../usage/tokenTracker';
import { ChangeSet } from '../edits/changeTracker';
import { runAgentWorkflow } from '../agent/agentOrchestrator';
import { findFiles } from '../agent/workspaceFiles';
import { fetchUrl } from '../agent/httpFetcher';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'grokChatView';

    private _view?: vscode.WebviewView;
    private _currentSessionId?: string;
    private _abortController?: AbortController;
    private _isRequestInProgress = false;
    private _modelInfoCache: Map<string, GrokModelInfo> = new Map();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        const tracker = getChangeTracker();
        tracker.onChange((changes, position) => {
            this._sendChangesUpdate(changes, position);
            this._persistChangeHistory();
        });
    }

    private async _persistChangeHistory() {
        if (!this._currentSessionId) return;
        
        try {
            const tracker = getChangeTracker();
            const serializable = tracker.toSerializable() as ChangeHistoryData;
            await updateSessionChangeHistory(this._currentSessionId, serializable);
            debug('Persisted change history for session:', this._currentSessionId);
        } catch (error) {
            logError('Failed to persist change history:', error);
        }
    }

    private async _restoreChangeHistory(sessionId: string) {
        try {
            const changeHistory = await getSessionChangeHistory(sessionId);
            if (changeHistory) {
                const tracker = getChangeTracker();
                tracker.fromSerializable(changeHistory);
                debug(`Restored change history for session: ${sessionId} - entries: ${changeHistory.history.length}`);
            } else {
                const tracker = getChangeTracker();
                tracker.clear();
                debug('No change history found for session, starting fresh:', sessionId);
            }
        } catch (error) {
            logError('Failed to restore change history:', error);
        }
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
                    this._sendFullConfig();
                    break;
                case 'saveSettings':
                    this._saveSettings(message.settings);
                    break;
                case 'ready':
                    await this._initializeSession();
                    this._sendInitialChanges();
                    this._testAndSendConnectionStatus();
                    this._fetchAndCacheModelInfo();
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
                case 'searchFiles':
                    this._searchWorkspaceFiles(message.query);
                    break;
                case 'handoff':
                    this._handleHandoff(message.sessionId, message.todos);
                    break;
                case 'saveTodos':
                    this._saveTodos(message.todos);
                    break;
                case 'fetchChartData':
                    this._fetchChartData(message.timeRange);
                    break;
                case 'reportBug':
                    this._reportBug(message.pairIndex, message.bugType, message.description, message.by);
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
        const modelMode = config.get<string>('modelMode', 'fast');
        // Send the actual model name based on mode
        let activeModel: string;
        if (modelMode === 'smart') {
            activeModel = config.get<string>('modelReasoning', 'grok-4');
        } else if (modelMode === 'base') {
            activeModel = config.get<string>('modelBase', 'grok-3');
        } else {
            activeModel = config.get<string>('modelFast', 'grok-3-mini');
        }
        this._postMessage({
            type: 'config',
            enterToSend: config.get<boolean>('enterToSend', false),
            autoApply: config.get<boolean>('autoApply', true),
            modelMode: modelMode,
            activeModel: activeModel
        });
    }

    private async _sendFullConfig() {
        const config = vscode.workspace.getConfiguration('grok');
        const apiKey = await this._context.secrets.get('grokApiKey');
        
        this._postMessage({
            type: 'fullConfig',
            settings: {
                // Database (Couchbase)
                couchbaseDeployment: config.get<string>('couchbaseDeployment', 'self-hosted'),
                couchbaseUrl: config.get<string>('couchbaseUrl', 'http://localhost'),
                capellaDataApiUrl: config.get<string>('capellaDataApiUrl', ''),
                couchbasePort: config.get<number>('couchbasePort', 8091),
                couchbaseQueryPort: config.get<number>('couchbaseQueryPort', 8093),
                couchbaseUsername: config.get<string>('couchbaseUsername', 'Administrator'),
                couchbasePassword: config.get<string>('couchbasePassword', 'password'),
                couchbaseBucket: config.get<string>('couchbaseBucket', 'grokCoder'),
                couchbaseScope: config.get<string>('couchbaseScope', '_default'),
                couchbaseCollection: config.get<string>('couchbaseCollection', '_default'),
                couchbaseTimeout: config.get<number>('couchbaseTimeout', 30),
                
                // Models
                apiBaseUrl: config.get<string>('apiBaseUrl', 'https://api.x.ai/v1'),
                apiKey: apiKey ? '••••••••' + apiKey.slice(-4) : '',
                hasApiKey: !!apiKey,
                modelFast: config.get<string>('modelFast', 'grok-3-mini'),
                modelReasoning: config.get<string>('modelReasoning', 'grok-4'),
                modelVision: config.get<string>('modelVision', 'grok-4'),
                modelBase: config.get<string>('modelBase', 'grok-3'),
                modelMode: config.get<string>('modelMode', 'fast'),
                apiTimeout: config.get<number>('apiTimeout', 300),
                
                // Chat
                enterToSend: config.get<boolean>('enterToSend', false),
                autoApply: config.get<boolean>('autoApply', true),
                maxPayloadSizeMB: config.get<number>('maxPayloadSizeMB', 15),
                
                // Optimize
                requestFormat: config.get<string>('requestFormat', 'json'),
                responseFormat: config.get<string>('responseFormat', 'json'),
                jsonCleanup: config.get<string>('jsonCleanup', 'auto'),
                
                // Debug
                debug: config.get<boolean>('debug', false),
                enableSound: config.get<boolean>('enableSound', false)
            }
        });
    }

    private async _saveSettings(settings: Record<string, any>) {
        const config = vscode.workspace.getConfiguration('grok');
        
        try {
            // Handle API key separately (stored in secrets)
            if (settings.apiKey && !settings.apiKey.startsWith('••••')) {
                await this._context.secrets.store('grokApiKey', settings.apiKey);
                info('API key updated');
            }
            
            // Update each setting
            const settingsMap: Record<string, string> = {
                // Database
                couchbaseDeployment: 'couchbaseDeployment',
                couchbaseUrl: 'couchbaseUrl',
                capellaDataApiUrl: 'capellaDataApiUrl',
                couchbasePort: 'couchbasePort',
                couchbaseQueryPort: 'couchbaseQueryPort',
                couchbaseUsername: 'couchbaseUsername',
                couchbasePassword: 'couchbasePassword',
                couchbaseBucket: 'couchbaseBucket',
                couchbaseScope: 'couchbaseScope',
                couchbaseCollection: 'couchbaseCollection',
                couchbaseTimeout: 'couchbaseTimeout',
                
                // Models
                apiBaseUrl: 'apiBaseUrl',
                modelFast: 'modelFast',
                modelReasoning: 'modelReasoning',
                modelVision: 'modelVision',
                modelBase: 'modelBase',
                modelMode: 'modelMode',
                apiTimeout: 'apiTimeout',
                
                // Chat
                enterToSend: 'enterToSend',
                autoApply: 'autoApply',
                maxPayloadSizeMB: 'maxPayloadSizeMB',
                
                // Optimize
                requestFormat: 'requestFormat',
                responseFormat: 'responseFormat',
                jsonCleanup: 'jsonCleanup',
                
                // Debug
                debug: 'debug',
                enableSound: 'enableSound'
            };
            
            for (const [key, configKey] of Object.entries(settingsMap)) {
                if (key in settings && key !== 'apiKey' && key !== 'hasApiKey') {
                    await config.update(configKey, settings[key], vscode.ConfigurationTarget.Global);
                }
            }
            
            vscode.window.showInformationMessage('Settings saved successfully');
            this._sendConfig();
            this._testAndSendConnectionStatus();
            
        } catch (error: any) {
            logError('Failed to save settings:', error);
            vscode.window.showErrorMessage(`Failed to save settings: ${error.message}`);
        }
    }

    private async _fetchChartData(timeRange: 'hour' | 'day' | 'week' | 'month') {
        try {
            const cbClient = getCouchbaseClient();
            const config = vscode.workspace.getConfiguration('grok');
            const bucket = config.get<string>('couchbaseBucket', 'grokCoder');
            
            // Calculate date threshold based on time range
            const now = new Date();
            let startDate: Date;
            let dateFormat: string;
            
            // Couchbase DATE_FORMAT_STR uses strftime format specifiers
            switch (timeRange) {
                case 'hour':
                    startDate = new Date(now.getTime() - 60 * 60 * 1000);
                    dateFormat = '%H:%M';  // e.g., "14:30"
                    break;
                case 'day':
                    startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    dateFormat = '%H:00';  // e.g., "14:00"
                    break;
                case 'week':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    dateFormat = '%Y-%m-%d';  // e.g., "2025-12-23"
                    break;
                case 'month':
                default:
                    startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                    dateFormat = '%Y-%m-%d';  // e.g., "2025-12-23"
                    break;
            }
            
            const startDateStr = startDate.toISOString();
            
            // Query 1: Summary stats using root-level fields (tokensIn, tokensOut, cost)
            // Uses index: find_chats_v1 ON grokCoder(projectId, updatedAt DESC) WHERE docType = "chat"
            const summaryQuery = `
                SELECT 
                    COUNT(1) as sessionCount,
                    SUM(IFMISSINGORNULL(tokensIn, 0)) as totalTokensIn,
                    SUM(IFMISSINGORNULL(tokensOut, 0)) as totalTokensOut,
                    SUM(IFMISSINGORNULL(cost, 0)) as totalCost
                FROM \`${bucket}\`
                WHERE docType = "chat" 
                AND projectId IS NOT MISSING
                AND updatedAt >= $startDate
            `;
            
            // Query 2: Usage over time using root-level fields
            const timeSeriesQuery = `
                SELECT 
                    DATE_FORMAT_STR(updatedAt, "${dateFormat}") as period,
                    SUM(IFMISSINGORNULL(tokensIn, 0)) as tokensIn,
                    SUM(IFMISSINGORNULL(tokensOut, 0)) as tokensOut,
                    SUM(IFMISSINGORNULL(cost, 0)) as cost,
                    COUNT(1) as sessions
                FROM \`${bucket}\`
                WHERE docType = "chat" 
                AND projectId IS NOT MISSING
                AND updatedAt >= $startDate
                GROUP BY DATE_FORMAT_STR(updatedAt, "${dateFormat}")
                ORDER BY period ASC
            `;
            
            // Query 3: Model usage from root-level modelUsed[] array (fast, no UNNEST)
            const modelUsageQuery = `
                SELECT 
                    m.model as model,
                    SUM(IFMISSINGORNULL(m.text, 0) + IFMISSINGORNULL(m.img, 0)) as count,
                    SUM(IFMISSINGORNULL(m.text, 0)) as textCalls,
                    SUM(IFMISSINGORNULL(m.img, 0)) as imgCalls
                FROM \`${bucket}\` d
                UNNEST d.modelUsed as m
                WHERE d.docType = "chat" 
                AND d.projectId IS NOT MISSING
                AND d.updatedAt IS NOT MISSING
                AND d.updatedAt >= $startDate
                AND d.modelUsed IS NOT MISSING
                GROUP BY m.model
                ORDER BY count DESC
                LIMIT 10
            `;
            
            // Execute queries in parallel
            const [summaryResults, timeSeriesResults, modelResults] = await Promise.all([
                cbClient.query<{ sessionCount: number; totalTokensIn: number; totalTokensOut: number; totalCost: number }>(
                    summaryQuery, { startDate: startDateStr }
                ),
                cbClient.query<{ period: string; tokensIn: number; tokensOut: number; cost: number; sessions: number }>(
                    timeSeriesQuery, { startDate: startDateStr }
                ),
                cbClient.query<{ model: string; count: number; textCalls: number; imgCalls: number }>(
                    modelUsageQuery, { startDate: startDateStr }
                )
            ]);
            
            const summary = summaryResults[0] || { sessionCount: 0, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 };
            
            this._postMessage({
                type: 'chartData',
                timeRange,
                summary: {
                    sessionCount: summary.sessionCount || 0,
                    totalTokensIn: summary.totalTokensIn || 0,
                    totalTokensOut: summary.totalTokensOut || 0,
                    totalCost: summary.totalCost || 0
                },
                timeSeries: timeSeriesResults || [],
                modelUsage: modelResults || []
            });
            
            debug('Chart data fetched:', { timeRange, summaryResults: summaryResults.length, timeSeriesResults: timeSeriesResults.length, modelResults: modelResults.length });
            
        } catch (error: any) {
            logError('Failed to fetch chart data:', error);
            this._postMessage({
                type: 'chartData',
                error: error.message || 'Failed to fetch chart data'
            });
        }
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

    private async _reportBug(pairIndex: number, bugType: string, description: string, by: string) {
        if (!this._currentSessionId) {
            vscode.window.showErrorMessage('No active session');
            return;
        }
        
        try {
            const bug = await appendSessionBug(this._currentSessionId, {
                type: bugType as BugType,
                pairIndex,
                by: by as BugReporter,
                description
            });
            
            info(`Bug reported: ${bug.id} - ${bugType} at pair ${pairIndex}`);
            vscode.window.showInformationMessage(`Bug reported: ${bugType} issue at response #${pairIndex + 1}`);
        } catch (error: any) {
            logError('Failed to report bug:', error);
            vscode.window.showErrorMessage(`Failed to report bug: ${error.message}`);
        }
    }

    public async reportBugFromScript(pairIndex: number, bugType: BugType, description: string) {
        return this._reportBug(pairIndex, bugType, description, 'script');
    }

    private static readonly MODEL_CACHE_KEY = 'grok.modelInfoCache';
    private static readonly MODEL_CACHE_TIMESTAMP_KEY = 'grok.modelInfoCacheTimestamp';
    private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    private async _fetchAndCacheModelInfo() {
        try {
            const apiKey = await this._context.secrets.get('grokApiKey');
            if (!apiKey) return;

            // Check if cached data exists and is still valid
            const cachedTimestamp = this._context.globalState.get<number>(ChatViewProvider.MODEL_CACHE_TIMESTAMP_KEY);
            const cachedData = this._context.globalState.get<Record<string, GrokModelInfo>>(ChatViewProvider.MODEL_CACHE_KEY);
            
            const now = Date.now();
            const cacheValid = cachedTimestamp && cachedData && (now - cachedTimestamp < ChatViewProvider.CACHE_TTL_MS);
            
            if (cacheValid && cachedData) {
                // Use cached data
                for (const [id, model] of Object.entries(cachedData)) {
                    this._modelInfoCache.set(id, model);
                }
                info(`Using cached model info (${Object.keys(cachedData).length} models, expires in ${Math.round((ChatViewProvider.CACHE_TTL_MS - (now - cachedTimestamp!)) / 3600000)}h)`);
                this._sendModelInfo();
                return;
            }

            // Fetch fresh data from API
            info('Fetching fresh model info from API (cache expired or missing)');
            const models = await fetchLanguageModels(apiKey);
            
            if (models.length > 0) {
                // Update in-memory cache
                for (const model of models) {
                    this._modelInfoCache.set(model.id, model);
                }
                
                // Persist to globalState
                const cacheObj: Record<string, GrokModelInfo> = {};
                for (const model of models) {
                    cacheObj[model.id] = model;
                }
                await this._context.globalState.update(ChatViewProvider.MODEL_CACHE_KEY, cacheObj);
                await this._context.globalState.update(ChatViewProvider.MODEL_CACHE_TIMESTAMP_KEY, now);
                
                info(`Cached ${models.length} model info entries (expires in 24h)`);
            }
            
            // Send updated model info to webview
            this._sendModelInfo();
        } catch (error) {
            debug('Failed to fetch model info:', error);
            
            // Try to use stale cache as fallback
            const cachedData = this._context.globalState.get<Record<string, GrokModelInfo>>(ChatViewProvider.MODEL_CACHE_KEY);
            if (cachedData) {
                for (const [id, model] of Object.entries(cachedData)) {
                    this._modelInfoCache.set(id, model);
                }
                info('Using stale cached model info as fallback');
                this._sendModelInfo();
            }
        }
    }

    private _sendModelInfo() {
        const modelInfo: Record<string, { contextLength: number; inputPrice: number; outputPrice: number }> = {};
        for (const [id, info] of this._modelInfoCache.entries()) {
            modelInfo[id] = {
                contextLength: info.contextLength,
                inputPrice: info.inputPricePer1M,
                outputPrice: info.outputPricePer1M
            };
        }
        this._postMessage({
            type: 'modelInfo',
            models: modelInfo
        });
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

    private async _searchWorkspaceFiles(query: string) {
        try {
            const pattern = `**/*${query}*`;
            const files = await findFiles(pattern, 15);
            this._postMessage({
                type: 'fileSearchResults',
                files: files
            });
        } catch (error) {
            debug('File search error:', error);
            this._postMessage({
                type: 'fileSearchResults',
                files: []
            });
        }
    }

    private async _handleHandoff(sessionId: string, todos: Array<{text: string, completed: boolean}>) {
        try {
            const oldSession = await getSession(sessionId);
            if (!oldSession) {
                vscode.window.showErrorMessage('Session not found');
                return;
            }

            // Generate handoff summary
            const todoSummary = todos.length > 0 
                ? todos.map(t => `${t.completed ? '✓' : '○'} ${t.text}`).join('\n')
                : 'No TODOs tracked';
            
            const completedCount = todos.filter(t => t.completed).length;
            const pendingCount = todos.length - completedCount;
            
            const handoffText = [
                `## Handoff from Session ${sessionId.slice(0, 6)}`,
                '',
                `**Summary:** ${oldSession.summary || 'No summary available'}`,
                '',
                `**Progress:** ${completedCount}/${todos.length} tasks completed`,
                pendingCount > 0 ? `**Remaining:** ${pendingCount} task(s) pending` : '',
                '',
                '**TODOs:**',
                todoSummary,
                '',
                `**Context:** ${oldSession.pairs.length} message(s) exchanged, ${oldSession.tokensIn + oldSession.tokensOut} tokens used`
            ].filter(Boolean).join('\n');

            // Create new session with parent reference
            const newSession = await createSession(sessionId);
            
            // Update old session with handoff info
            await updateSessionHandoff(sessionId, handoffText, newSession.id);
            
            // Switch to new session
            this._currentSessionId = newSession.id;
            setCurrentSession(newSession.id);

            // Send init message with handoff context
            this._postMessage({
                type: 'sessionChanged',
                sessionId: newSession.id,
                summary: `Handoff from @${sessionId.slice(0, 6)}`,
                history: [],
                parentSessionId: sessionId
            });

            // Pre-fill the input with handoff context so user can see and edit it
            const pendingTodos = todos.filter(t => !t.completed).map(t => `- ${t.text}`).join('\n');
            const prefillText = [
                `[Handoff from session @${sessionId.slice(0, 6)}]`,
                '',
                `Previous work: ${oldSession.summary || 'No summary'}`,
                pendingTodos ? `\nPending tasks:\n${pendingTodos}` : '',
                '',
                'Please continue where we left off.'
            ].filter(Boolean).join('\n');
            
            this._postMessage({
                type: 'prefillInput',
                text: prefillText
            });

            vscode.window.showInformationMessage(`Handed off to new session. Parent: ${sessionId.slice(0, 6)}`);
            
        } catch (error: any) {
            logError('Handoff failed:', error);
            vscode.window.showErrorMessage(`Handoff failed: ${error.message}`);
        }
    }

    private async _saveTodos(todos: Array<{text: string, completed: boolean}>) {
        if (!this._currentSessionId) {
            return;
        }
        try {
            const todoItems: TodoItem[] = todos.map(t => ({ text: t.text, completed: t.completed }));
            await updateSessionTodos(this._currentSessionId, todoItems);
            debug('Saved todos to session:', this._currentSessionId);
        } catch (error: any) {
            logError('Failed to save todos:', error);
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
                
                // Restore change history from Couchbase
                await this._restoreChangeHistory(sessionId);
                
                this._postMessage({
                    type: 'sessionChanged',
                    sessionId: session.id,
                    summary: session.summary,
                    history: session.pairs,
                    todos: session.todos || []
                });
                
                // Send the restored changes to the UI
                this._sendInitialChanges();
                
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
                    
                    // Restore change history from Couchbase
                    await this._restoreChangeHistory(savedSessionId);
                    
                    this._postMessage({
                        type: 'init',
                        sessionId: session.id,
                        history: session.pairs,
                        todos: session.todos || []
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

            this._abortController = new AbortController();

            const config = vscode.workspace.getConfiguration('grok');
            const modelMode = config.get<string>('modelMode', 'fast');
            const fastModel = config.get<string>('modelFast', 'grok-3-mini');
            
            let model: string;
            if (hasImages) {
                model = config.get<string>('modelVision', 'grok-4');
            } else if (modelMode === 'smart') {
                model = config.get<string>('modelReasoning', 'grok-4');
            } else if (modelMode === 'base') {
                model = config.get<string>('modelBase', 'grok-3');
            } else {
                model = fastModel;
            }
            
            info('Using model: ' + model + ' (mode: ' + modelMode + ')');
            
            request.model = model;

            // Agent workflow: analyze if files are needed and load them
            let finalMessageText = messageText;
            if (!hasImages) {
                try {
                    this._postMessage({ type: 'updateResponseChunk', pairIndex, deltaText: '🔍 Analyzing request...\n' });
                    
                    const agentResult = await runAgentWorkflow(
                        messageText,
                        apiKey,
                        fastModel,
                        (progress) => {
                            this._postMessage({ type: 'updateResponseChunk', pairIndex, deltaText: `📂 ${progress}\n` });
                        }
                    );
                    
                    // Record planning step metrics
                    if (agentResult.stepMetrics) {
                        const { planning, execute } = agentResult.stepMetrics;
                        recordStep(
                            this._currentSessionId!, 
                            'planning', 
                            planning.timeMs, 
                            planning.tokensIn, 
                            planning.tokensOut
                        );
                        if (execute.timeMs > 0) {
                            recordStep(this._currentSessionId!, 'execute', execute.timeMs, 0, 0);
                        }
                    }
                    
                    const hasFiles = agentResult.filesLoaded.length > 0;
                    const hasUrls = agentResult.urlsLoaded > 0;
                    
                    if (hasFiles || hasUrls) {
                        const parts: string[] = [];
                        if (hasFiles) parts.push(`${agentResult.filesLoaded.length} file(s)`);
                        if (hasUrls) parts.push(`${agentResult.urlsLoaded} URL(s)`);
                        
                        this._postMessage({ 
                            type: 'updateResponseChunk', 
                            pairIndex, 
                            deltaText: `✅ Loaded ${parts.join(', ')}\n\n` 
                        });
                        finalMessageText = agentResult.augmentedMessage;
                        info(`Agent loaded ${parts.join(', ')}`);
                    } else if (!agentResult.skipped) {
                        this._postMessage({ type: 'updateResponseChunk', pairIndex, deltaText: '⚠️ No matching files or URLs found\n\n' });
                    }
                } catch (agentError) {
                    debug('Agent workflow error (continuing without files):', agentError);
                }
            }

            const messages = await this._buildMessages(finalMessageText, hasImages ? images : undefined);

            // Track main response step timing
            const mainStepStart = startStepTimer();
            
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
            
            const mainStepTime = endStepTimer(mainStepStart);
            
            // Record main step metrics
            recordStep(
                this._currentSessionId!,
                'main',
                mainStepTime,
                grokResponse.usage?.promptTokens || 0,
                grokResponse.usage?.completionTokens || 0
            );

            // SAVE EARLY: Save raw response immediately to prevent data loss if parsing fails
            const rawResponse: ChatResponse = {
                text: grokResponse.text,
                timestamp: new Date().toISOString(),
                status: 'success',
                usage: grokResponse.usage
            };
            try {
                await updateLastPairResponse(this._currentSessionId!, rawResponse);
                debug('Saved raw response to Couchbase');
            } catch (saveErr) {
                logError('Failed to save raw response:', saveErr);
            }

            // Parse structured JSON response with configurable AI cleanup
            // Modes: "auto" (AI on failure), "off" (never AI), "on" (always AI)
            const cleanupMode = config.get<string>('jsonCleanup', 'auto');
            let structured: GrokStructuredResponse = { summary: '', message: grokResponse.text };
            let usedCleanup = false;
            let parsingSucceeded = false;
            
            const processCleanupResult = async (forceAI: boolean): Promise<GrokStructuredResponse | null> => {
                debug(`Starting parseWithCleanup, fastModel: ${fastModel}, forceAI: ${forceAI}`);
                const cleanupResult = await parseWithCleanup(
                    grokResponse.text,
                    apiKey,
                    fastModel,
                    forceAI
                );
                debug('parseWithCleanup result:', { hasStructured: !!cleanupResult.structured, usedCleanup: cleanupResult.usedCleanup });
                
                if (cleanupResult.structured) {
                    usedCleanup = cleanupResult.usedCleanup;
                    
                    // Warn if response was truncated
                    if (cleanupResult.wasTruncated) {
                        const recoveredCount = cleanupResult.truncatedFileChangesCount || 0;
                        const warningMsg = `⚠️ Response was truncated! Only ${recoveredCount} file change(s) were recovered. Consider breaking the task into smaller steps.`;
                        vscode.window.showWarningMessage(warningMsg);
                        this._postMessage({ type: 'updateResponseChunk', pairIndex, deltaText: `\n${warningMsg}\n` });
                    }
                    
                    if (usedCleanup) {
                        const isToon = grokResponse.text.trim().startsWith('```toon') || 
                                       (grokResponse.text.includes('summary:') && !grokResponse.text.includes('"summary"'));
                        const cleanupType = isToon ? 'TOON→JSON' : 'JSON';
                        info(`Used model cleanup to fix ${cleanupType}`);
                        this._postMessage({ type: 'updateResponseChunk', pairIndex, deltaText: `\n🔧 ${cleanupType} cleaned up\n` });
                        
                        // Record cleanup step metrics if model was used
                        if (cleanupResult.cleanupMetrics) {
                            recordStep(
                                this._currentSessionId!,
                                'cleanup',
                                cleanupResult.cleanupMetrics.timeMs,
                                cleanupResult.cleanupMetrics.tokensIn,
                                cleanupResult.cleanupMetrics.tokensOut
                            );
                        }
                    }
                    return cleanupResult.structured;
                }
                return null;
            };

            try {
                if (cleanupMode === 'on') {
                    // Always use AI cleanup
                    const result = await processCleanupResult(true);
                    structured = result || parseResponse(grokResponse.text);
                    parsingSucceeded = !!result;
                } else if (cleanupMode === 'off') {
                    // Never use AI cleanup, always use logic-based parsing
                    structured = parseResponse(grokResponse.text);
                    parsingSucceeded = !!(structured.summary || structured.message);
                } else {
                    // Auto mode: try logic first, use AI if it fails
                    try {
                        structured = parseResponse(grokResponse.text);
                        // Check if parsing actually got useful data
                        const hasUsefulData = !!(structured.summary || structured.message || 
                                             (structured.fileChanges && structured.fileChanges.length > 0) ||
                                             (structured.todos && structured.todos.length > 0));
                        parsingSucceeded = hasUsefulData;
                        if (!hasUsefulData) {
                            debug('Logic parsing returned no useful data, trying AI cleanup');
                            const result = await processCleanupResult(true);
                            if (result) {
                                structured = result;
                                parsingSucceeded = true;
                            }
                        }
                    } catch (parseError) {
                        debug('Logic parsing failed, trying AI cleanup:', parseError);
                        const result = await processCleanupResult(true);
                        structured = result || { summary: '', message: grokResponse.text };
                        parsingSucceeded = !!result;
                    }
                }
            } catch (parsingException: any) {
                logError('Response parsing failed completely:', parsingException);
                // Ensure we still save the raw response text
                structured = { summary: 'Parsing failed', message: grokResponse.text };
                parsingSucceeded = false;
                
                // Auto-report parsing exception as bug
                try {
                    await appendSessionBug(this._currentSessionId!, {
                        type: 'JSON',
                        pairIndex,
                        by: 'script',
                        description: `Auto-detected: Response parsing failed - ${parsingException.message || 'Unknown error'}`
                    });
                    debug('Auto-reported parsing bug for pair:', pairIndex);
                } catch (bugErr) {
                    debug('Failed to auto-report bug:', bugErr);
                }
            }
            
            debug('Parsed structured response:', { 
                hasTodos: !!structured.todos?.length,
                hasFileChanges: !!structured.fileChanges?.length,
                hasCommands: !!structured.commands?.length,
                usedCleanup
            });

            // Filter out empty commands (command field must be non-empty)
            const validCommands = structured.commands?.filter(
                (cmd: { command?: string }) => cmd.command && cmd.command.trim().length > 0
            );

            const successResponse: ChatResponse = {
                text: grokResponse.text,
                timestamp: new Date().toISOString(),
                status: 'success',
                usage: grokResponse.usage,
                structured: {
                    summary: structured.summary,
                    message: structured.message,
                    sections: structured.sections,
                    todos: structured.todos,
                    fileChanges: structured.fileChanges,
                    commands: validCommands,
                    codeBlocks: structured.codeBlocks,
                    nextSteps: structured.nextSteps
                }
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
                // Track model usage aggregate at root level
                await updateSessionModelUsage(this._currentSessionId, model, hasImages);
            }

            if (pairIndex === 0) {
                await this._generateSessionSummary(messageText, structured.message || grokResponse.text);
            }

            // Convert structured fileChanges to edits for apply functionality
            let edits: ProposedEdit[] = [];
            const blockedChanges: string[] = [];
            const suspiciousChanges: string[] = [];
            
            if (structured.fileChanges && structured.fileChanges.length > 0) {
                const editPromises = structured.fileChanges.map(async (fc, idx) => {
                    const fileUri = resolveFilePathToUri(fc.path);
                    if (!fileUri) {
                        logError(`Unable to resolve file path: ${fc.path}`);
                        vscode.window.showErrorMessage(`Cannot apply change: Unable to resolve path "${fc.path}". It may be outside the workspace or invalid.`);
                        return null;
                    }
                    
                    // Warn if file is outside workspace
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const isOutsideWorkspace = workspaceFolders 
                        ? !fileUri.fsPath.startsWith(workspaceFolders[0].uri.fsPath) 
                        : true;
                    if (isOutsideWorkspace) {
                        debug(`File is outside workspace: ${fc.path}`);
                    }
                    
                    let newText = fc.content;
                    
                    // If isDiff is true, apply the diff to the existing file content
                    if (fc.isDiff) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            const originalContent = doc.getText();
                            newText = applySimpleDiff(originalContent, fc.content);
                            debug(`Applied diff to ${fc.path}: ${fc.content.split('\\n').length} diff lines -> ${newText.split('\\n').length} result lines`);
                        } catch (err) {
                            // File doesn't exist, use content as-is (strip +/- prefixes)
                            newText = fc.content.split('\n')
                                .filter(line => !line.startsWith('-'))
                                .map(line => line.startsWith('+') ? line.substring(1) : line)
                                .join('\n');
                            debug(`File ${fc.path} not found, extracting + lines from diff`);
                        }
                    } else {
                        // SAFETY CHECK: Validate non-diff file changes to prevent corruption
                        const validation = await validateFileChange(fileUri, newText, fc.isDiff || false);
                        
                        if (!validation.isValid) {
                            // Block this change - it looks like truncated content
                            blockedChanges.push(`${fc.path}: ${validation.warning}`);
                            logError(`BLOCKED file change: ${validation.warning}`);
                            return null; // Skip this edit
                        }
                        
                        if (validation.isSuspicious && validation.warning) {
                            suspiciousChanges.push(`${fc.path}: ${validation.warning}`);
                            debug(`Suspicious file change detected: ${validation.warning}`);
                        }
                    }
                    
                    return {
                        id: `edit-${idx}`,
                        fileUri,
                        range: fc.lineRange ? new vscode.Range(fc.lineRange.start - 1, 0, fc.lineRange.end, 0) : undefined,
                        newText
                    };
                });
                
                // Filter out blocked edits (null values)
                const results = await Promise.all(editPromises);
                edits = results.filter((edit): edit is NonNullable<typeof edit> => edit !== null) as ProposedEdit[];
                
                // Notify user about blocked/suspicious changes
                if (blockedChanges.length > 0) {
                    // Check if we can offer to restore from GitHub
                    const gitRemoteUrl = await this._getGitRemoteUrl();
                    const canRestoreFromGitHub = gitRemoteUrl && gitRemoteUrl.includes('github.com');
                    
                    const buttons = canRestoreFromGitHub 
                        ? ['Show Details', 'Restore from GitHub'] 
                        : ['Show Details'];
                    
                    vscode.window.showErrorMessage(
                        `Blocked ${blockedChanges.length} file change(s) that appeared truncated. ` +
                        `The AI may have an outdated view of the file.`,
                        ...buttons
                    ).then(async selection => {
                        if (selection === 'Show Details') {
                            logError('Blocked file changes:\n' + blockedChanges.join('\n'));
                            logError('TIP: The AI\'s context may contain truncated file content. ' +
                                'Try asking: "Read the current content of <filename> and then make the change"');
                        } else if (selection === 'Restore from GitHub' && gitRemoteUrl) {
                            // Offer to restore specific files from GitHub
                            await this._offerGitHubRestore(blockedChanges, gitRemoteUrl);
                        }
                    });
                }
                
                if (suspiciousChanges.length > 0) {
                    vscode.window.showWarningMessage(
                        `${suspiciousChanges.length} file change(s) may be incomplete. Review carefully before applying.`
                    );
                }
            } else {
                // Fallback to legacy parsing if no structured fileChanges
                edits = parseCodeBlocksFromResponse(grokResponse.text);
            }

            let diffPreview: { file: string; stats: { added: number; removed: number; modified: number } }[] = [];
            if (edits.length > 0) {
                diffPreview = await previewDiffStats(edits);
            }

            // Update stored response with diffPreview for history restoration
            if (diffPreview.length > 0) {
                successResponse.diffPreview = diffPreview;
                await updateLastPairResponse(this._currentSessionId, successResponse);
            }

            this._postMessage({
                type: 'requestComplete',
                pairIndex,
                response: successResponse,
                diffPreview,
                usedCleanup,
                structured: {
                    todos: structured.todos || [],
                    summary: structured.summary || '',
                    message: structured.message,
                    sections: structured.sections || [],
                    codeBlocks: structured.codeBlocks || [],
                    fileChanges: structured.fileChanges || [],
                    commands: validCommands || [],
                    nextSteps: structured.nextSteps || []
                }
            });

            vscode.window.showInformationMessage('Grok completed the request.');

        } catch (error: any) {
            logError('sendMessage error:', error.message);
            vscode.window.showErrorMessage(`Grok error: ${error.message}`);
            
            const isAborted = error.name === 'AbortError';
            const errorResponse: ChatResponse = {
                timestamp: new Date().toISOString(),
                status: isAborted ? 'cancelled' : 'error',
                errorMessage: error.message
            };

            try {
                await updateLastPairResponse(this._currentSessionId!, errorResponse);
                
                // Auto-report non-abort errors as bugs
                if (!isAborted && this._currentSessionId) {
                    const session = await getSession(this._currentSessionId);
                    const currentPairIndex = session ? session.pairs.length - 1 : 0;
                    await appendSessionBug(this._currentSessionId, {
                        type: 'Other',
                        pairIndex: currentPairIndex,
                        by: 'script',
                        description: `Auto-detected: API error - ${error.message}`
                    });
                    debug('Auto-reported API error bug for pair:', currentPairIndex);
                }
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
            
            // Try structured fileChanges first, then fallback to legacy parsing
            let edits: ProposedEdit[] = [];
            const structured = lastSuccessPair.response.structured;
            
            if (structured?.fileChanges && structured.fileChanges.length > 0) {
                const validFileChanges = structured.fileChanges
                    .filter((fc: { path: string; content: string }) => {
                        // Validate path is not empty
                        if (!fc.path || fc.path.trim() === '') {
                            logError('Skipping fileChange with empty path', { content: fc.content?.substring(0, 100) });
                            return false;
                        }
                        return true;
                    });
                
                const editResults = await Promise.all(validFileChanges.map(async (fc: { path: string; content: string; lineRange?: { start: number; end: number }; isDiff?: boolean }, idx: number) => {
                    const filePath = fc.path.trim();
                    const fileUri = resolveFilePathToUri(filePath);
                    if (!fileUri) {
                        logError(`Unable to resolve file path: ${filePath}`);
                        vscode.window.showErrorMessage(`Cannot apply change: Unable to resolve path "${filePath}". It may be outside the workspace or invalid.`);
                        return null;
                    }
                    
                    // Warn if file is outside workspace
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    const isOutsideWorkspace = workspaceFolders 
                        ? !fileUri.fsPath.startsWith(workspaceFolders[0].uri.fsPath) 
                        : true;
                    if (isOutsideWorkspace) {
                        debug(`File is outside workspace: ${filePath}`);
                    }
                    
                    let newText = fc.content;
                    
                    // If isDiff is true, apply the diff to the existing file content
                    if (fc.isDiff) {
                        try {
                            const doc = await vscode.workspace.openTextDocument(fileUri);
                            const originalContent = doc.getText();
                            newText = applySimpleDiff(originalContent, fc.content);
                            debug(`Applied diff to ${filePath}`);
                        } catch (err) {
                            // File doesn't exist, extract + lines from diff
                            newText = fc.content.split('\n')
                                .filter(line => !line.startsWith('-'))
                                .map(line => line.startsWith('+') ? line.substring(1) : line)
                                .join('\n');
                            debug(`File ${filePath} not found, extracting + lines from diff`);
                        }
                    }
                    
                    debug(`Processing fileChange: path="${filePath}", content length=${newText?.length}`);
                    
                    return {
                        id: `edit-${idx}`,
                        fileUri,
                        range: fc.lineRange ? new vscode.Range(fc.lineRange.start - 1, 0, fc.lineRange.end, 0) : undefined,
                        newText
                    };
                }));
                edits = editResults.filter((edit): edit is NonNullable<typeof edit> => edit !== null) as ProposedEdit[];
                debug('Using structured fileChanges:', edits.length);
            }
            
            // Fallback to legacy emoji parsing
            if (edits.length === 0) {
                edits = parseCodeBlocksFromResponse(lastSuccessPair.response.text);
                debug('Using legacy parsing, found:', edits.length);
            }
            
            if (edits.length === 0) {
                const hasEmoji = lastSuccessPair.response.text.includes('📄');
                const hasCodeBlock = lastSuccessPair.response.text.includes('```');
                const hasStructured = !!(structured?.fileChanges?.length);
                logError('No edits found', { hasEmoji, hasCodeBlock, hasStructured });
                vscode.window.showWarningMessage(
                    `No code changes found to apply. ` +
                    `Ensure the response contains fileChanges or 📄 filename patterns.`
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

        // Use hardcoded system prompt with workspace info (project-agnostic)
        const workspaceInfo = await getWorkspaceInfo();
        let systemPrompt = buildSystemPrompt(workspaceInfo);

        // Check if this is a handoff session and inject parent context
        if (this._currentSessionId) {
            try {
                const session = await getSession(this._currentSessionId);
                if (session) {
                    // If this session has a parent (handoff) and this is the first message, fetch the handoff context
                    // Note: pairs.length === 1 because appendPair is called before _buildMessages
                    if (session.parentSessionId && session.pairs.length === 1) {
                        const parentSession = await getSession(session.parentSessionId);
                        if (parentSession?.handoffText) {
                            info('Injecting handoff context from parent session:', session.parentSessionId.slice(0, 6));
                            systemPrompt += `\n\n## Handoff Context\nThis session is a continuation from a previous session. Here is the context:\n\n${parentSession.handoffText}`;
                        }
                    }
                    
                    // System message must come FIRST before history
                    messages.push({ role: 'system', content: systemPrompt });
                    
                    // Then add conversation history
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

        // If no session or session load failed, add system message now
        if (messages.length === 0 || messages[0].role !== 'system') {
            messages.unshift({ role: 'system', content: systemPrompt });
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
#todo-list{display:block;padding:6px 10px 10px 24px;background:var(--vscode-editor-background);font-size:11px;margin:0 6px 4px 6px;border:1px solid var(--vscode-panel-border);border-top:none;border-radius:0 0 4px 4px;max-height:120px;overflow-y:auto}
#todo-list.hide{display:none}
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
.msg.u{background:linear-gradient(135deg,rgba(56,139,213,0.12) 0%,rgba(56,139,213,0.06) 100%);color:var(--vscode-foreground);margin-left:15%;border-radius:16px 16px 4px 16px;border:1px solid rgba(56,139,213,0.25);position:relative}
.msg.u::before{content:'';position:absolute;top:0;right:0;width:4px;height:100%;background:var(--vscode-button-background);border-radius:0 16px 4px 0}
.msg.u code{background:rgba(56,139,213,0.2);padding:1px 5px;border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:12px}
.msg.a{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);margin-right:5%;border-radius:12px 12px 12px 4px}
.msg.p{opacity:.7}
.msg.e{background:var(--vscode-inputValidation-errorBackground);border-color:var(--vscode-inputValidation-errorBorder)}
.msg .c{line-height:1.4}
.msg .c p{margin:4px 0}
.msg .c ul,.msg .c ol{margin:4px 0 4px 16px;padding-left:0}
.msg .c li{margin:2px 0;line-height:1.4}
.msg .c h1,.msg .c h2,.msg .c h3{margin:8px 0 4px 0;color:var(--vscode-textLink-foreground)}
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
.done{display:flex;align-items:center;gap:8px;margin-top:8px;padding:8px 12px;background:rgba(80,200,80,.08);border-radius:4px;border-left:3px solid var(--vscode-testing-iconPassed);font-size:12px}
.done-check{color:var(--vscode-testing-iconPassed);font-weight:600}
.done-txt{font-weight:500;color:var(--vscode-testing-iconPassed)}
.done-icon{font-size:11px}
.done-actions{display:flex;gap:6px;margin-left:8px}
.done-action{font-size:10px;padding:2px 8px;border-radius:3px;border:none}
.done-applied{background:rgba(128,128,128,0.15);color:var(--vscode-foreground)}
.done-pending{background:var(--vscode-testing-iconPassed);color:#fff;cursor:pointer;font-weight:500}
.done-pending:hover{opacity:0.9}
.done-tokens{margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground)}
.msg-actions{display:flex;justify-content:flex-end;margin-bottom:4px}
.bug-btn{background:none;border:none;cursor:pointer;opacity:0.4;padding:2px 4px;margin-left:4px;transition:opacity .15s;display:inline-flex;align-items:center}
.bug-btn:hover{opacity:1}
.bug-btn.reported{opacity:1}
.bug-btn.reported svg{stroke:var(--vscode-testing-iconFailed)}
.bug-btn svg{stroke:var(--vscode-descriptionForeground)}
#bug-modal{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:1000}
#bug-modal.show{display:flex}
.bug-modal-content{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;padding:16px;width:90%;max-width:400px;box-shadow:0 4px 12px rgba(0,0,0,0.3)}
.bug-modal-title{font-size:14px;font-weight:600;margin:0 0 12px 0;display:flex;align-items:center;gap:6px}
.bug-modal-row{margin-bottom:12px}
.bug-modal-row label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px}
.bug-modal-row select,.bug-modal-row textarea{width:100%;padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;font-size:12px;font-family:inherit}
.bug-modal-row textarea{min-height:80px;resize:vertical}
.bug-modal-btns{display:flex;gap:8px;justify-content:flex-end}
.bug-modal-btns button{padding:6px 14px;border-radius:4px;border:none;cursor:pointer;font-size:12px}
.bug-modal-cancel{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.bug-modal-submit{background:var(--vscode-testing-iconFailed);color:#fff}
.summary{font-size:13px;font-weight:500;color:var(--vscode-foreground);margin:0 0 12px 0;line-height:1.5}
.section{margin-bottom:16px}
.section h3{font-size:13px;font-weight:600;color:var(--vscode-textLink-foreground);margin:0 0 8px 0;padding-bottom:4px;border-bottom:1px solid var(--vscode-panel-border)}
.section p{font-size:12px;line-height:1.5;margin:0 0 8px 0;color:var(--vscode-foreground)}
.code-caption{font-size:11px;color:var(--vscode-descriptionForeground);margin:8px 0 4px 0;font-style:italic}
.todos-panel{margin-bottom:12px;padding:10px;background:var(--vscode-textBlockQuote-background);border-radius:6px;border-left:3px solid var(--vscode-charts-blue)}
.todos-hdr{font-size:12px;font-weight:600;color:var(--vscode-foreground);margin-bottom:6px;display:flex;align-items:center;gap:8px}
.todos-prog{font-size:10px;color:var(--vscode-descriptionForeground);font-weight:normal}
.todos-list{list-style:none;margin:0;padding:0}
.todo-item{display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:12px;color:var(--vscode-foreground)}
.todo-item.done{color:var(--vscode-descriptionForeground);text-decoration:line-through}
.todo-box{color:var(--vscode-charts-blue);font-size:13px}
.next-steps{margin-top:12px;padding:10px;background:var(--vscode-textBlockQuote-background);border-radius:6px;border-left:3px solid var(--vscode-textLink-foreground)}
.next-steps-hdr{font-size:11px;font-weight:600;color:var(--vscode-textLink-foreground);margin-bottom:8px}
.next-steps-btns{display:flex;flex-wrap:wrap;gap:6px}
.next-step-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:12px;font-size:11px;cursor:pointer;transition:all .15s}
.next-step-btn:hover{opacity:.85}
/* Checklists */
.checklist{list-style:none;display:flex;align-items:flex-start;gap:6px;margin:4px 0}
.checklist .check-box{color:var(--vscode-descriptionForeground);font-size:14px}
.checklist.done{color:var(--vscode-descriptionForeground);text-decoration:line-through}
.checklist.done .check-box{color:var(--vscode-testing-iconPassed)}
/* Markdown tables */
table{border-collapse:collapse;margin:10px 0;font-size:12px;width:100%}
th,td{border:1px solid var(--vscode-panel-border);padding:6px 10px;text-align:left}
th{background:var(--vscode-titleBar-activeBackground);font-weight:600}
tr:nth-child(even){background:var(--vscode-editor-background)}
/* Better code blocks - lighter background */
pre{background:var(--vscode-editor-background);padding:12px;border-radius:6px;overflow-x:auto;margin:8px 0;font-size:12px;line-height:1.6;border:1px solid var(--vscode-panel-border)}
pre code{background:none;padding:0;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);display:block}
code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:3px;font-size:11px;color:var(--vscode-textPreformat-foreground)}
/* Diff line highlighting */
.diff-add{background:rgba(40,167,69,.15);color:#2ea043;display:block;margin:0 -12px;padding:0 12px}
.diff-rem{background:rgba(248,81,73,.15);color:#f85149;display:block;margin:0 -12px;padding:0 12px;text-decoration:line-through;text-decoration-color:rgba(248,81,73,.5)}
.diff-add::before{content:'+';margin-right:6px;font-weight:700}
.diff-rem::before{content:'-';margin-right:6px;font-weight:700}
#inp{padding:8px;border-top:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;gap:6px}
#stats{display:flex;justify-content:space-between;font-size:10px;color:var(--vscode-descriptionForeground);padding:0 4px;cursor:pointer}
#stats:hover{background:var(--vscode-list-hoverBackground);margin:0 -4px;padding:2px 8px;border-radius:4px}
#stats-left{display:flex;align-items:center;gap:8px}
#stats-left .changes-info{display:flex;gap:6px}
#stats-right{display:flex;align-items:center;gap:8px}
#stats .cost{color:var(--vscode-charts-green);font-weight:600}
#stats .pct{display:flex;align-items:center;gap:4px;position:relative;cursor:pointer}
#stats .pct.green{color:#888}
#stats .pct.orange{color:#e69500}
#stats .pct.red{color:#f85149}
#handoff-popup{position:absolute;bottom:100%;right:0;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border);border-radius:6px;padding:10px;min-width:200px;display:none;z-index:101;box-shadow:0 -2px 8px rgba(0,0,0,.3)}
#handoff-popup.show{display:block}
#handoff-popup p{margin:0 0 8px 0;font-size:11px;color:var(--vscode-editor-foreground)}
#handoff-popup ul{color:var(--vscode-editor-foreground)}
#handoff-popup li{color:var(--vscode-editor-foreground)}
#handoff-popup .handoff-btns{display:flex;gap:6px;justify-content:flex-end}
#handoff-popup button{padding:4px 10px;border:none;border-radius:4px;font-size:11px;cursor:pointer}
#handoff-popup .handoff-yes{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
#handoff-popup .handoff-no{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#inp-row{display:flex;gap:6px;align-items:flex-end}
#msg{flex:1;padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:6px;resize:none;min-height:36px;max-height:120px;font-family:inherit;font-size:13px;line-height:1.4}
#send{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:13px;font-weight:500}
#stop{padding:8px 14px;border:none;border-radius:6px;cursor:pointer;background:#c44;color:#fff;display:none;font-size:13px;font-weight:500}
#stop.vis{display:block}
#attach{padding:8px;border:none;border-radius:6px;cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-size:16px}
#attach:hover{background:var(--vscode-button-secondaryHoverBackground)}
#img-preview{display:none;gap:6px;flex-wrap:wrap;padding:4px 0}
#img-preview.show{display:flex}
#autocomplete{position:absolute;bottom:50px;left:40px;right:60px;max-height:150px;overflow-y:auto;background:var(--vscode-editorSuggestWidget-background);border:1px solid var(--vscode-editorSuggestWidget-border);border-radius:6px;display:none;z-index:100;box-shadow:0 -2px 8px rgba(0,0,0,.2)}
#autocomplete.show{display:block}
.ac-item{padding:6px 10px;cursor:pointer;font-size:12px;font-family:var(--vscode-editor-font-family);display:flex;align-items:center;gap:8px}
.ac-item:hover,.ac-item.sel{background:var(--vscode-list-hoverBackground)}
.ac-item .ac-icon{opacity:.6}
.ac-item .ac-path{color:var(--vscode-descriptionForeground);font-size:11px;margin-left:auto}
.img-thumb{position:relative;width:52px;height:52px;border-radius:6px;overflow:hidden;border:1px solid var(--vscode-panel-border)}
.img-thumb img{width:100%;height:100%;object-fit:cover}
.img-thumb .rm{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:#c44;color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;border:none}

.apply-all{margin:10px 0;padding:8px 12px;background:var(--vscode-testing-iconPassed);color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:6px;width:100%}
.apply-all:hover{opacity:.9}
.term-out{margin:10px 0;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-testing-iconPassed);border-radius:6px;overflow:hidden}
.term-hdr{padding:8px 10px;display:flex;justify-content:space-between;align-items:center;gap:10px}
.term-content{flex:1;min-width:0}
.term-cmd{color:var(--vscode-foreground);font-weight:500;font-family:var(--vscode-editor-font-family);font-size:12px;word-break:break-word}
.term-desc{color:var(--vscode-descriptionForeground);font-size:11px;margin-top:4px;font-family:var(--vscode-font-family)}
.term-body{padding:10px;font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-foreground);white-space:pre-wrap;max-height:200px;overflow-y:auto}
.term-btns{display:flex;gap:6px;align-items:center}
.term-run{background:var(--vscode-testing-iconPassed);color:#fff;border:none;border-radius:4px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
.term-run:hover{opacity:.9}
.term-copy{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;padding:6px 8px;font-size:12px;cursor:pointer;white-space:nowrap}
.term-copy:hover{opacity:.9}
.term-copy.copied{background:var(--vscode-testing-iconPassed);color:#fff}
.actions-summary{margin:12px 0 4px 0;padding:10px 12px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border);border-radius:6px}
.actions-summary.status-done{border-left:3px solid var(--vscode-testing-iconPassed)}
.actions-summary.status-pending{border-left:3px solid var(--vscode-charts-yellow);background:rgba(255,193,7,0.06)}
.actions-summary.status-input{border-left:3px solid var(--vscode-charts-blue);background:rgba(33,150,243,0.06)}
.actions-summary-header{margin-bottom:6px}
.status-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:3px 10px;border-radius:12px}
.status-done .status-badge{background:var(--vscode-testing-iconPassed);color:#fff}
.status-pending .status-badge{background:var(--vscode-charts-yellow);color:#000}
.status-input .status-badge{background:var(--vscode-charts-blue);color:#fff}
.actions-summary-items{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.action-item{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:4px 10px;border-radius:4px}
.action-item.pending{background:var(--vscode-testing-iconPassed);color:#fff;font-weight:600;cursor:pointer}
.action-item.pending:hover{opacity:0.9}
.action-item.done{background:var(--vscode-button-secondaryBackground);color:var(--vscode-descriptionForeground)}
.action-item.input-needed{background:var(--vscode-charts-blue);color:#fff;font-weight:600}
.nav-link-container{margin:4px 0 8px 0}
.nav-link{font-size:11px;color:var(--vscode-textLink-foreground);text-decoration:none;cursor:pointer}
.nav-link:hover{text-decoration:underline}
.response-summary{margin:12px 0;padding:10px 12px;background:var(--vscode-textBlockQuote-background);border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-charts-blue);border-radius:6px}
.response-summary-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.response-summary-title{font-size:12px;font-weight:600;color:var(--vscode-foreground)}
.response-summary-text{font-size:11px;color:var(--vscode-foreground);line-height:1.4}
.summary-list{margin:0;padding:0 0 0 16px;font-size:11px;line-height:1.6}
.summary-list li{margin:2px 0}
.summary-list .file-item{color:var(--vscode-textLink-foreground);padding-left:8px;list-style:none}
.summary-list .cmd-item{color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);padding-left:8px;list-style:none}

/* Settings Panel */
#settings-view{display:none;flex:1;overflow-y:auto;padding:12px;background:var(--vscode-sideBar-background)}
#settings-view.show{display:block}
#chat.hide,#inp.hide,#todo-bar.hide,#todo-list.hide{display:none!important}
.settings-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--vscode-panel-border)}
.settings-header h2{font-size:16px;font-weight:600;margin:0;color:var(--vscode-foreground)}
.settings-close{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px}
.settings-close:hover{background:var(--vscode-button-secondaryHoverBackground)}
.settings-tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
.settings-tab{padding:6px 12px;border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:500;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);transition:all .15s}
.settings-tab:hover{background:var(--vscode-button-secondaryHoverBackground)}
.settings-tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.settings-section{display:none}
.settings-section.active{display:block}
.settings-group{margin-bottom:20px}
.settings-group h3{font-size:13px;font-weight:600;color:var(--vscode-textLink-foreground);margin:0 0 12px 0;padding-bottom:6px;border-bottom:1px solid var(--vscode-panel-border)}
.setting-row{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.setting-row label{font-size:11px;font-weight:500;color:var(--vscode-foreground)}
.setting-row .desc{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}
.setting-row input[type="text"],.setting-row input[type="password"],.setting-row input[type="number"],.setting-row select{padding:6px 10px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-radius:4px;font-size:12px;width:100%}
.setting-row input[type="checkbox"]{width:auto;margin-right:8px}
.setting-row .checkbox-row{display:flex;align-items:center}
.setting-row .checkbox-row label{margin:0}
.settings-actions{display:flex;gap:8px;margin-top:20px;padding-top:16px;border-top:1px solid var(--vscode-panel-border)}
.settings-actions button{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:500}
.settings-save{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.settings-save:hover{background:var(--vscode-button-hoverBackground)}
.settings-test{background:var(--vscode-testing-iconPassed);color:#fff}
.settings-test:hover{opacity:.9}
.test-result{margin-top:8px;padding:8px;border-radius:4px;font-size:11px}
.test-result.success{background:rgba(40,167,69,.15);color:var(--vscode-testing-iconPassed)}
.test-result.error{background:rgba(248,81,73,.15);color:var(--vscode-testing-iconFailed)}
.api-key-row{display:flex;gap:6px}
.api-key-row input{flex:1}
.api-key-row button{padding:6px 10px;font-size:11px;white-space:nowrap}
.future-badge{display:inline-block;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:9px;padding:2px 6px;border-radius:3px;margin-left:6px;vertical-align:middle}

/* Chart Styles */
.chart-time-filter{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.chart-radio{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;padding:4px 8px;border-radius:4px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));color:var(--vscode-input-foreground)}
.chart-radio:hover{background:var(--vscode-list-hoverBackground)}
.chart-radio input{margin:0}
.chart-refresh-btn{padding:4px 12px;font-size:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;margin-left:auto}
.chart-refresh-btn:hover{background:var(--vscode-button-hoverBackground)}
.chart-loading{padding:20px;text-align:center;color:var(--vscode-descriptionForeground);display:none}
.chart-loading.show{display:block}
.chart-error{padding:10px;background:rgba(248,81,73,.15);color:var(--vscode-testing-iconFailed);border-radius:4px;margin-bottom:12px;display:none;font-size:11px}
.chart-error.show{display:block}
.chart-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
.summary-card{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;text-align:center}
.summary-card.cost{border-color:var(--vscode-charts-green)}
.summary-value{font-size:18px;font-weight:700;color:var(--vscode-foreground)}
.summary-card.cost .summary-value{color:var(--vscode-charts-green)}
.summary-label{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px}
.chart-container{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;margin-bottom:12px}
.chart-container h4{font-size:12px;font-weight:600;margin:0 0 12px 0;color:var(--vscode-foreground)}
.bar-chart{height:120px;display:flex;align-items:flex-end;gap:2px;padding-bottom:20px;padding-top:16px;position:relative}
.bar-group{display:flex;gap:1px;flex:1;align-items:flex-end;position:relative;height:100px}
.bar{min-width:4px;max-width:20px;border-radius:2px 2px 0 0;transition:height .3s;flex:1}
.bar.tokens-in{background:var(--vscode-charts-blue)}
.bar.tokens-out{background:var(--vscode-charts-purple)}
.bar.cost-bar{background:var(--vscode-charts-green)}
.bar-label{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);font-size:8px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.bar-value{position:absolute;top:-14px;left:50%;transform:translateX(-50%);font-size:8px;color:var(--vscode-foreground);white-space:nowrap;font-weight:500}
.chart-legend{display:flex;gap:12px;justify-content:center;margin-top:8px}
.legend-item{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--vscode-descriptionForeground)}
.legend-dot{width:8px;height:8px;border-radius:2px}
.legend-dot.tokens-in{background:var(--vscode-charts-blue)}
.legend-dot.tokens-out{background:var(--vscode-charts-purple)}
.pie-chart-wrapper{display:flex;gap:16px;align-items:center}
.pie-chart{width:100px;height:100px;border-radius:50%;position:relative;flex-shrink:0}
.pie-legend{flex:1;font-size:11px}
.pie-legend-item{display:flex;align-items:center;gap:6px;padding:4px 0}
.pie-legend-dot{width:10px;height:10px;border-radius:2px;flex-shrink:0}
.pie-legend-text{flex:1;color:var(--vscode-foreground)}
.pie-legend-value{color:var(--vscode-descriptionForeground);font-size:10px}
.no-data{padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
</style></head><body>
<div id="hdr"><div id="sess" title="Click to view chat history"><span>▼</span><span id="sess-text">New Chat</span></div><div id="hdr-btns"><span id="status-dot" title="Connection status">●</span><button id="model-btn" class="fast" title="Model: F=Fast, S=Smart, B=Base&#10;Click to cycle">F</button><button id="auto-btn" class="auto" title="Auto/Manual apply">A</button><button id="new">+ New Chat</button><button id="cfg">⚙️</button></div></div>
<div id="hist"></div>

<!-- Settings View -->
<div id="settings-view">
    <div class="settings-header">
        <h2>⚙️ Settings</h2>
        <button class="settings-close" id="settings-close">← Back to Chat</button>
    </div>
    <div class="settings-tabs">
        <button class="settings-tab active" data-tab="database">Database</button>
        <button class="settings-tab" data-tab="models">Models</button>
        <button class="settings-tab" data-tab="chat">Chat</button>
        <button class="settings-tab" data-tab="optimize">Optimize</button>
        <button class="settings-tab" data-tab="debug">Debug</button>
        <button class="settings-tab" data-tab="chart">Usage</button>
    </div>
    
    <!-- Database Section -->
    <div class="settings-section active" id="section-database">
        <div class="settings-group">
            <h3>Couchbase Connection</h3>
            <div class="setting-row">
                <label>Deployment Type</label>
                <select id="set-couchbaseDeployment">
                    <option value="self-hosted">Self-hosted</option>
                    <option value="capella">Couchbase Capella</option>
                </select>
                <div class="desc">Choose between self-hosted Couchbase Server or Couchbase Capella DBaaS</div>
            </div>
            <div class="setting-row" id="row-couchbaseUrl">
                <label>Server URL</label>
                <input type="text" id="set-couchbaseUrl" placeholder="http://localhost">
                <div class="desc">Base URL for self-hosted Couchbase (e.g., http://localhost)</div>
            </div>
            <div class="setting-row" id="row-capellaDataApiUrl" style="display:none">
                <label>Capella Data API URL</label>
                <input type="text" id="set-capellaDataApiUrl" placeholder="https://your-cluster.data.cloud.couchbase.com">
                <div class="desc">Capella Data API endpoint URL</div>
            </div>
            <div class="setting-row" id="row-ports">
                <label>Ports</label>
                <div style="display:flex;gap:8px">
                    <div style="flex:1"><input type="number" id="set-couchbasePort" placeholder="8091"><div class="desc">REST API</div></div>
                    <div style="flex:1"><input type="number" id="set-couchbaseQueryPort" placeholder="8093"><div class="desc">Query Service</div></div>
                </div>
            </div>
            <div class="setting-row">
                <label>Username</label>
                <input type="text" id="set-couchbaseUsername" placeholder="Administrator">
            </div>
            <div class="setting-row">
                <label>Password</label>
                <input type="password" id="set-couchbasePassword" placeholder="password">
            </div>
            <div class="setting-row">
                <label>Bucket</label>
                <input type="text" id="set-couchbaseBucket" placeholder="grokCoder">
            </div>
            <div class="setting-row">
                <label>Scope / Collection</label>
                <div style="display:flex;gap:8px">
                    <input type="text" id="set-couchbaseScope" placeholder="_default" style="flex:1">
                    <input type="text" id="set-couchbaseCollection" placeholder="_default" style="flex:1">
                </div>
            </div>
            <div class="setting-row">
                <label>Timeout (seconds)</label>
                <input type="number" id="set-couchbaseTimeout" placeholder="30">
            </div>
            <div id="db-test-result"></div>
        </div>
    </div>
    
    <!-- Models Section -->
    <div class="settings-section" id="section-models">
        <div class="settings-group">
            <h3>API Configuration</h3>
            <div class="setting-row">
                <label>API Base URL</label>
                <input type="text" id="set-apiBaseUrl" placeholder="https://api.x.ai/v1">
            </div>
            <div class="setting-row">
                <label>API Key</label>
                <div class="api-key-row">
                    <input type="password" id="set-apiKey" placeholder="xai-...">
                    <button id="toggle-api-key" class="settings-close">Show</button>
                </div>
                <div class="desc">Your xAI API key (starts with xai-)</div>
            </div>
            <div class="setting-row">
                <label>API Timeout (seconds)</label>
                <input type="number" id="set-apiTimeout" placeholder="300">
                <div class="desc">Timeout for API requests (default 5 minutes for complex responses)</div>
            </div>
        </div>
        <div class="settings-group">
            <h3>Model Selection</h3>
            <div class="setting-row">
                <label>Default Mode</label>
                <select id="set-modelMode">
                    <option value="fast">Fast (F) - Quick, cost-efficient</option>
                    <option value="smart">Smart (S) - Complex reasoning</option>
                    <option value="base">Base (B) - Standard</option>
                </select>
            </div>
            <div class="setting-row">
                <label>Fast Model</label>
                <input type="text" id="set-modelFast" placeholder="grok-3-mini">
                <div class="desc">Used for quick tasks and file analysis</div>
            </div>
            <div class="setting-row">
                <label>Reasoning Model</label>
                <input type="text" id="set-modelReasoning" placeholder="grok-4">
                <div class="desc">Used for complex, multi-step tasks</div>
            </div>
            <div class="setting-row">
                <label>Vision Model</label>
                <input type="text" id="set-modelVision" placeholder="grok-4">
                <div class="desc">Used when images are attached</div>
            </div>
            <div class="setting-row">
                <label>Base Model</label>
                <input type="text" id="set-modelBase" placeholder="grok-3">
            </div>
            <div id="api-test-result"></div>
        </div>
    </div>
    
    <!-- Chat Section -->
    <div class="settings-section" id="section-chat">
        <div class="settings-group">
            <h3>Chat Behavior</h3>
            <div class="setting-row">
                <div class="checkbox-row">
                    <input type="checkbox" id="set-enterToSend">
                    <label>Enter to Send</label>
                </div>
                <div class="desc">When enabled: Enter sends, Ctrl+Enter for new line. Otherwise reversed.</div>
            </div>
            <div class="setting-row">
                <div class="checkbox-row">
                    <input type="checkbox" id="set-autoApply">
                    <label>Auto Apply Changes</label>
                </div>
                <div class="desc">Automatically apply code changes from AI responses</div>
            </div>
            <div class="setting-row">
                <label>Max Payload Size (MB)</label>
                <input type="number" id="set-maxPayloadSizeMB" placeholder="15">
                <div class="desc">Maximum size for Couchbase documents (limit: 20MB)</div>
            </div>
        </div>
    </div>
    
    <!-- Optimize Section -->
    <div class="settings-section" id="section-optimize">
        <div class="settings-group">
            <h3>Token Optimization</h3>
            <div class="setting-row">
                <label>Request Format</label>
                <select id="set-requestFormat">
                    <option value="json">JSON - Standard format</option>
                    <option value="toon">TOON - Token-efficient (30-60% fewer tokens)</option>
                </select>
            </div>
            <div class="setting-row">
                <label>Response Format</label>
                <select id="set-responseFormat">
                    <option value="json">JSON - Reliable parsing</option>
                    <option value="toon">TOON - Fewer tokens, less reliable</option>
                </select>
            </div>
            <div class="setting-row">
                <label>JSON Cleanup</label>
                <select id="set-jsonCleanup">
                    <option value="auto">Auto - AI cleanup on parse failure</option>
                    <option value="off">Off - Logic-based parsing only</option>
                    <option value="on">On - Always use AI cleanup</option>
                </select>
                <div class="desc">Control when AI is used to fix malformed responses</div>
            </div>
        </div>
    </div>
    
    <!-- Debug Section -->
    <div class="settings-section" id="section-debug">
        <div class="settings-group">
            <h3>Debugging</h3>
            <div class="setting-row">
                <div class="checkbox-row">
                    <input type="checkbox" id="set-debug">
                    <label>Enable Debug Logging</label>
                </div>
                <div class="desc">Output detailed logs to the Output channel</div>
            </div>
            <div class="setting-row">
                <div class="checkbox-row">
                    <input type="checkbox" id="set-enableSound">
                    <label>Enable Sound</label>
                </div>
                <div class="desc">Play sound when task completes</div>
            </div>
        </div>
    </div>
    
    <!-- Chart Section -->
    <div class="settings-section" id="section-chart">
        <div class="settings-group">
            <h3>Usage Analytics</h3>
            <div class="chart-time-filter">
                <label class="chart-radio"><input type="radio" name="chartTime" value="hour"> Last Hour</label>
                <label class="chart-radio"><input type="radio" name="chartTime" value="day"> Last 24h</label>
                <label class="chart-radio"><input type="radio" name="chartTime" value="week" checked> Last Week</label>
                <label class="chart-radio"><input type="radio" name="chartTime" value="month"> Last Month</label>
                <button id="chart-refresh" class="chart-refresh-btn">Refresh</button>
            </div>
            <div id="chart-loading" class="chart-loading">Loading charts...</div>
            <div id="chart-error" class="chart-error"></div>
            
            <!-- Summary Cards -->
            <div class="chart-summary" id="chart-summary">
                <div class="summary-card">
                    <div class="summary-value" id="sum-sessions">0</div>
                    <div class="summary-label">Sessions</div>
                </div>
                <div class="summary-card">
                    <div class="summary-value" id="sum-tokens-in">0</div>
                    <div class="summary-label">Tokens Requests</div>
                </div>
                <div class="summary-card">
                    <div class="summary-value" id="sum-tokens-out">0</div>
                    <div class="summary-label">Tokens Responses</div>
                </div>
                <div class="summary-card cost">
                    <div class="summary-value" id="sum-cost">$0.00</div>
                    <div class="summary-label">Total Cost</div>
                </div>
            </div>
            
            <!-- Token Usage Over Time (Bar Chart) -->
            <div class="chart-container">
                <h4>Token Usage Over Time</h4>
                <div class="bar-chart" id="tokens-chart"></div>
                <div class="chart-legend">
                    <span class="legend-item"><span class="legend-dot tokens-in"></span> Requests</span>
                    <span class="legend-item"><span class="legend-dot tokens-out"></span> Responses</span>
                </div>
            </div>
            
            <!-- Cost Over Time (Bar Chart) -->
            <div class="chart-container">
                <h4>Cost Over Time</h4>
                <div class="bar-chart" id="cost-chart"></div>
            </div>
            
            <!-- Model Usage (Pie Chart) -->
            <div class="chart-container">
                <h4>Model Usage Distribution</h4>
                <div class="pie-chart-wrapper">
                    <div class="pie-chart" id="model-chart"></div>
                    <div class="pie-legend" id="model-legend"></div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="settings-actions">
        <button class="settings-save" id="settings-save">💾 Save Settings</button>
        <button class="settings-test" id="settings-test">🔌 Test Connections</button>
    </div>
</div>

<div id="chat"></div>

<!-- Bug Report Modal -->
<div id="bug-modal">
    <div class="bug-modal-content">
        <div class="bug-modal-title">🐛 Report Bug</div>
        <div class="bug-modal-row">
            <label>Bug Type</label>
            <select id="bug-type">
                <option value="HTML">HTML</option>
                <option value="CSS">CSS</option>
                <option value="JSON">JSON</option>
                <option value="JS">JavaScript</option>
                <option value="TypeScript">TypeScript</option>
                <option value="Markdown">Markdown</option>
                <option value="SQL">SQL</option>
                <option value="Other">Other</option>
            </select>
        </div>
        <div class="bug-modal-row">
            <label>Description</label>
            <textarea id="bug-desc" placeholder="Describe what went wrong..."></textarea>
        </div>
        <div class="bug-modal-btns">
            <button class="bug-modal-cancel" id="bug-cancel">Cancel</button>
            <button class="bug-modal-submit" id="bug-submit">Report Bug</button>
        </div>
    </div>
</div>

<!-- Expanded Changes Panel (dropdown from stats bar) -->
<div id="changes-panel">
    <div id="changes-hdr"><span>📁 Change History</span><span id="changes-close" style="cursor:pointer">✕</span></div>
    <div id="changes-list"></div>
</div>

<div id="inp" style="position:relative">
<div id="autocomplete"></div>
<!-- TODO Panel - above stats bar -->
<div id="todo-bar"><span id="todo-toggle" class="open">▼</span><span id="todo-title">TODOs</span><span id="todo-count">(0/0)</span></div>
<div id="todo-list"></div>

<div id="stats">
    <div id="stats-left"><span id="stats-changes">0 files</span><span class="changes-info"><span class="stat-add">+0</span><span class="stat-rem">-0</span><span class="stat-mod">~0</span></span></div>
    <div id="stats-right"><span class="cost" id="stats-cost">$0.00</span><span class="pct" id="pct-wrap">○ <span id="stats-pct">0%</span><div id="handoff-popup"><p><strong>🔄 Session Handoff</strong></p><p>Creates a new session with context from this one:</p><ul style="margin:4px 0 8px 16px;padding:0;font-size:10px"><li>Summary of work done</li><li>TODO progress (completed/pending)</li><li>Reference to continue where you left off</li></ul><p style="font-size:10px;color:var(--vscode-descriptionForeground)">Use when nearing token limit or to start fresh with context.</p><div class="handoff-btns"><button class="handoff-no">Cancel</button><button class="handoff-yes">🔄 Hand Off</button></div></div></span></div>
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
let currentTodos=[],todosCompleted=0,todoExpanded=true;
// Model info: context limits and pricing (fallback values, updated from API)
let modelInfo={
    'grok-4-1-fast-reasoning-latest':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-4-1-fast-non-reasoning-latest':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-4-1-fast-reasoning':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-4-1-fast-non-reasoning':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-4-fast-reasoning':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-4-fast-non-reasoning':{ctx:2000000,inPrice:0.20,outPrice:0.50},
    'grok-code-fast-1':{ctx:256000,inPrice:0.20,outPrice:1.50},
    'grok-4-0709':{ctx:256000,inPrice:3.00,outPrice:15.00},
    'grok-4':{ctx:256000,inPrice:3.00,outPrice:15.00},
    'grok-3-mini':{ctx:131072,inPrice:0.30,outPrice:0.50},
    'grok-3':{ctx:131072,inPrice:3.00,outPrice:15.00}
};
let currentModel='grok-3-mini';
function getCtxLimit(){return (modelInfo[currentModel]||{ctx:131072}).ctx;}
function getModelPricing(){return modelInfo[currentModel]||{inPrice:0.30,outPrice:0.50};}
const autocomplete=document.getElementById('autocomplete');
let acFiles=[],acIndex=-1,acWordStart=-1,acWordEnd=-1,acDebounce=null;

// Settings view
const settingsView=document.getElementById('settings-view');
const settingsClose=document.getElementById('settings-close');
const settingsSave=document.getElementById('settings-save');
const settingsTest=document.getElementById('settings-test');
const settingsTabs=document.querySelectorAll('.settings-tab');
const inp=document.getElementById('inp');
let currentSettings={};

// Bug reporting
const bugModal=document.getElementById('bug-modal');
const bugType=document.getElementById('bug-type');
const bugDesc=document.getElementById('bug-desc');
const bugCancel=document.getElementById('bug-cancel');
const bugSubmit=document.getElementById('bug-submit');
let bugPairIndex=-1;

function showBugModal(pairIndex){
    bugPairIndex=pairIndex;
    bugType.value='Other';
    bugDesc.value='';
    bugModal.classList.add('show');
    bugDesc.focus();
}
function hideBugModal(){
    bugModal.classList.remove('show');
    bugPairIndex=-1;
}
bugCancel.addEventListener('click',hideBugModal);
bugModal.addEventListener('click',e=>{if(e.target===bugModal)hideBugModal();});
bugSubmit.addEventListener('click',()=>{
    if(bugPairIndex<0)return;
    const desc=bugDesc.value.trim();
    if(!desc){bugDesc.focus();return;}
    vs.postMessage({type:'reportBug',pairIndex:bugPairIndex,bugType:bugType.value,description:desc,by:'user'});
    // Mark button as reported
    const btn=document.querySelector('.msg.a[data-i="'+bugPairIndex+'"] .bug-btn');
    if(btn){btn.classList.add('reported');btn.title='Bug reported';}
    hideBugModal();
});
function reportBug(pairIndex){showBugModal(pairIndex);}

function showSettings(){
    settingsView.classList.add('show');
    chat.classList.add('hide');
    inp.classList.add('hide');
    todoBar.classList.add('hide');
    todoList.classList.add('hide');
    vs.postMessage({type:'openSettings'});
}
function hideSettings(){
    settingsView.classList.remove('show');
    chat.classList.remove('hide');
    inp.classList.remove('hide');
    todoBar.classList.remove('hide');
    if(todoExpanded)todoList.classList.remove('hide');
}
document.getElementById('cfg').onclick=showSettings;
settingsClose.onclick=hideSettings;

// Settings tabs
let chartDataLoaded=false;
settingsTabs.forEach(tab=>{
    tab.onclick=()=>{
        const tabName=tab.dataset.tab;
        settingsTabs.forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.settings-section').forEach(s=>s.classList.remove('active'));
        document.getElementById('section-'+tabName).classList.add('active');
        
        // Fetch chart data when Chart tab is clicked (only first time or on refresh)
        if(tabName==='chart'&&!chartDataLoaded){
            fetchChartData();
        }
    };
});

// Chart functionality
function getSelectedTimeRange(){
    const selected=document.querySelector('input[name="chartTime"]:checked');
    return selected?selected.value:'week';
}

function fetchChartData(){
    const timeRange=getSelectedTimeRange();
    document.getElementById('chart-loading').classList.add('show');
    document.getElementById('chart-error').classList.remove('show');
    vs.postMessage({type:'fetchChartData',timeRange});
}

document.getElementById('chart-refresh').onclick=()=>{
    chartDataLoaded=false;
    fetchChartData();
};

document.querySelectorAll('input[name="chartTime"]').forEach(radio=>{
    radio.onchange=()=>{
        chartDataLoaded=false;
        fetchChartData();
    };
});

function formatNumber(n){
    if(n>=1000000)return (n/1000000).toFixed(1)+'M';
    if(n>=1000)return (n/1000).toFixed(1)+'K';
    return n.toString();
}

const chartColors=['#4ec9b0','#569cd6','#ce9178','#dcdcaa','#c586c0','#9cdcfe','#4fc1ff','#d7ba7d'];

function renderCharts(data){
    chartDataLoaded=true;
    document.getElementById('chart-loading').classList.remove('show');
    
    if(data.error){
        document.getElementById('chart-error').textContent=data.error;
        document.getElementById('chart-error').classList.add('show');
        return;
    }
    
    // Summary cards
    document.getElementById('sum-sessions').textContent=formatNumber(data.summary.sessionCount||0);
    document.getElementById('sum-tokens-in').textContent=formatNumber(data.summary.totalTokensIn||0);
    document.getElementById('sum-tokens-out').textContent=formatNumber(data.summary.totalTokensOut||0);
    document.getElementById('sum-cost').textContent='$'+(data.summary.totalCost||0).toFixed(2);
    
    // Token usage bar chart
    const tokensChart=document.getElementById('tokens-chart');
    const timeSeries=data.timeSeries||[];
    
    if(timeSeries.length===0){
        tokensChart.innerHTML='<div class="no-data">No data for selected period</div>';
    }else{
        const maxTokens=Math.max(...timeSeries.map(d=>Math.max(d.tokensIn||0,d.tokensOut||0)),1);
        tokensChart.innerHTML=timeSeries.map(d=>{
            const inH=Math.max(2,((d.tokensIn||0)/maxTokens)*100);
            const outH=Math.max(2,((d.tokensOut||0)/maxTokens)*100);
            const inVal=formatNumber(d.tokensIn||0);
            return '<div class="bar-group"><span class="bar-value">'+inVal+'</span><div class="bar tokens-in" style="height:'+inH+'%" title="Requests: '+inVal+'"></div><div class="bar tokens-out" style="height:'+outH+'%" title="Responses: '+formatNumber(d.tokensOut||0)+'"></div><span class="bar-label">'+d.period+'</span></div>';
        }).join('');
    }
    
    // Cost bar chart
    const costChart=document.getElementById('cost-chart');
    if(timeSeries.length===0){
        costChart.innerHTML='<div class="no-data">No data for selected period</div>';
    }else{
        const maxCost=Math.max(...timeSeries.map(d=>d.cost||0),0.01);
        costChart.innerHTML=timeSeries.map(d=>{
            const h=Math.max(2,((d.cost||0)/maxCost)*100);
            const costVal='$'+(d.cost||0).toFixed(2);
            return '<div class="bar-group"><span class="bar-value">'+costVal+'</span><div class="bar cost-bar" style="height:'+h+'%" title="'+costVal+'"></div><span class="bar-label">'+d.period+'</span></div>';
        }).join('');
    }
    
    // Model usage pie chart
    const modelChart=document.getElementById('model-chart');
    const modelLegend=document.getElementById('model-legend');
    const modelUsage=data.modelUsage||[];
    
    if(modelUsage.length===0){
        modelChart.innerHTML='<div class="no-data" style="display:flex;align-items:center;justify-content:center;height:100%">No data</div>';
        modelLegend.innerHTML='';
    }else{
        const total=modelUsage.reduce((sum,m)=>sum+(m.count||0),0);
        let cumulative=0;
        const gradientStops=modelUsage.map((m,i)=>{
            const pct=(m.count||0)/total*100;
            const start=cumulative;
            cumulative+=pct;
            return chartColors[i%chartColors.length]+' '+start+'% '+cumulative+'%';
        }).join(', ');
        modelChart.style.background='conic-gradient('+gradientStops+')';
        
        modelLegend.innerHTML=modelUsage.map((m,i)=>{
            const pct=((m.count||0)/total*100).toFixed(1);
            const name=(m.model||'unknown').replace('grok-','');
            return '<div class="pie-legend-item"><span class="pie-legend-dot" style="background:'+chartColors[i%chartColors.length]+'"></span><span class="pie-legend-text">'+name+'</span><span class="pie-legend-value">'+pct+'%</span></div>';
        }).join('');
    }
}

// Toggle deployment type fields
function updateDeploymentFields(){
    const deployment=document.getElementById('set-couchbaseDeployment').value;
    const isSelfHosted=deployment==='self-hosted';
    document.getElementById('row-couchbaseUrl').style.display=isSelfHosted?'flex':'none';
    document.getElementById('row-capellaDataApiUrl').style.display=isSelfHosted?'none':'flex';
    document.getElementById('row-ports').style.display=isSelfHosted?'flex':'none';
}
document.getElementById('set-couchbaseDeployment').onchange=updateDeploymentFields;

// Toggle API key visibility
document.getElementById('toggle-api-key').onclick=function(){
    const input=document.getElementById('set-apiKey');
    if(input.type==='password'){input.type='text';this.textContent='Hide';}
    else{input.type='password';this.textContent='Show';}
};

// Populate settings form
function populateSettings(s){
    currentSettings=s;
    // Database
    document.getElementById('set-couchbaseDeployment').value=s.couchbaseDeployment||'self-hosted';
    document.getElementById('set-couchbaseUrl').value=s.couchbaseUrl||'';
    document.getElementById('set-capellaDataApiUrl').value=s.capellaDataApiUrl||'';
    document.getElementById('set-couchbasePort').value=s.couchbasePort||8091;
    document.getElementById('set-couchbaseQueryPort').value=s.couchbaseQueryPort||8093;
    document.getElementById('set-couchbaseUsername').value=s.couchbaseUsername||'';
    document.getElementById('set-couchbasePassword').value=s.couchbasePassword||'';
    document.getElementById('set-couchbaseBucket').value=s.couchbaseBucket||'';
    document.getElementById('set-couchbaseScope').value=s.couchbaseScope||'';
    document.getElementById('set-couchbaseCollection').value=s.couchbaseCollection||'';
    document.getElementById('set-couchbaseTimeout').value=s.couchbaseTimeout||30;
    // Models
    document.getElementById('set-apiBaseUrl').value=s.apiBaseUrl||'';
    document.getElementById('set-apiKey').value=s.apiKey||'';
    document.getElementById('set-apiKey').placeholder=s.hasApiKey?'(API key set)':'xai-...';
    document.getElementById('set-apiTimeout').value=s.apiTimeout||300;
    document.getElementById('set-modelFast').value=s.modelFast||'';
    document.getElementById('set-modelReasoning').value=s.modelReasoning||'';
    document.getElementById('set-modelVision').value=s.modelVision||'';
    document.getElementById('set-modelBase').value=s.modelBase||'';
    document.getElementById('set-modelMode').value=s.modelMode||'fast';
    // Chat
    document.getElementById('set-enterToSend').checked=s.enterToSend||false;
    document.getElementById('set-autoApply').checked=s.autoApply!==false;
    document.getElementById('set-maxPayloadSizeMB').value=s.maxPayloadSizeMB||15;
    // Optimize
    document.getElementById('set-requestFormat').value=s.requestFormat||'json';
    document.getElementById('set-responseFormat').value=s.responseFormat||'json';
    document.getElementById('set-jsonCleanup').value=s.jsonCleanup||'auto';
    // Debug
    document.getElementById('set-debug').checked=s.debug||false;
    document.getElementById('set-enableSound').checked=s.enableSound||false;
    
    updateDeploymentFields();
}

// Collect settings from form
function collectSettings(){
    return {
        // Database
        couchbaseDeployment:document.getElementById('set-couchbaseDeployment').value,
        couchbaseUrl:document.getElementById('set-couchbaseUrl').value,
        capellaDataApiUrl:document.getElementById('set-capellaDataApiUrl').value,
        couchbasePort:parseInt(document.getElementById('set-couchbasePort').value)||8091,
        couchbaseQueryPort:parseInt(document.getElementById('set-couchbaseQueryPort').value)||8093,
        couchbaseUsername:document.getElementById('set-couchbaseUsername').value,
        couchbasePassword:document.getElementById('set-couchbasePassword').value,
        couchbaseBucket:document.getElementById('set-couchbaseBucket').value,
        couchbaseScope:document.getElementById('set-couchbaseScope').value,
        couchbaseCollection:document.getElementById('set-couchbaseCollection').value,
        couchbaseTimeout:parseInt(document.getElementById('set-couchbaseTimeout').value)||30,
        // Models
        apiBaseUrl:document.getElementById('set-apiBaseUrl').value,
        apiKey:document.getElementById('set-apiKey').value,
        apiTimeout:parseInt(document.getElementById('set-apiTimeout').value)||300,
        modelFast:document.getElementById('set-modelFast').value,
        modelReasoning:document.getElementById('set-modelReasoning').value,
        modelVision:document.getElementById('set-modelVision').value,
        modelBase:document.getElementById('set-modelBase').value,
        modelMode:document.getElementById('set-modelMode').value,
        // Chat
        enterToSend:document.getElementById('set-enterToSend').checked,
        autoApply:document.getElementById('set-autoApply').checked,
        maxPayloadSizeMB:parseInt(document.getElementById('set-maxPayloadSizeMB').value)||15,
        // Optimize
        requestFormat:document.getElementById('set-requestFormat').value,
        responseFormat:document.getElementById('set-responseFormat').value,
        jsonCleanup:document.getElementById('set-jsonCleanup').value,
        // Debug
        debug:document.getElementById('set-debug').checked,
        enableSound:document.getElementById('set-enableSound').checked
    };
}

settingsSave.onclick=()=>{
    const settings=collectSettings();
    vs.postMessage({type:'saveSettings',settings});
};

settingsTest.onclick=()=>{
    vs.postMessage({type:'testConnections'});
    document.getElementById('db-test-result').innerHTML='<div class="test-result">Testing connections...</div>';
    document.getElementById('api-test-result').innerHTML='<div class="test-result">Testing connections...</div>';
};

// Handoff popup
const pctWrap=document.getElementById('pct-wrap');
const handoffPopup=document.getElementById('handoff-popup');
pctWrap.onclick=e=>{e.stopPropagation();handoffPopup.classList.toggle('show');};
handoffPopup.querySelector('.handoff-no').onclick=e=>{e.stopPropagation();handoffPopup.classList.remove('show');};
handoffPopup.querySelector('.handoff-yes').onclick=e=>{e.stopPropagation();handoffPopup.classList.remove('show');vs.postMessage({type:'handoff',sessionId:curSessId,todos:currentTodos});};
document.addEventListener('click',e=>{if(!pctWrap.contains(e.target))handoffPopup.classList.remove('show');});

function updatePctColor(pct){
    pctWrap.classList.remove('green','orange','red');
    if(pct>=86){pctWrap.classList.add('red');}
    else if(pct>=76){pctWrap.classList.add('orange');}
    else{pctWrap.classList.add('green');}
}

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
todoBar.onclick=()=>{todoExpanded=!todoExpanded;todoToggle.classList.toggle('open',todoExpanded);todoList.classList.toggle('hide',!todoExpanded);};

// Stats bar click -> show changes panel
statsEl.onclick=()=>changesPanel.classList.toggle('show');
changesClose.onclick=e=>{e.stopPropagation();changesPanel.classList.remove('show');};
document.addEventListener('click',e=>{if(!statsEl.contains(e.target)&&!changesPanel.contains(e.target))changesPanel.classList.remove('show');});

function updateAutoBtn(){autoBtn.textContent=autoApply?'A':'M';autoBtn.className=autoApply?'auto':'manual';autoBtn.title=autoApply?'Auto (A): Applies AI response actions automatically\\nClick for Manual mode':'Manual (M): Waits for user to apply actions\\nClick for Auto mode';}

function renderTodos(){
    if(currentTodos.length===0){
        todoBar.classList.remove('has-todos');
        todoCount.classList.remove('active');
        todoCount.textContent='(no tasks)';
        todoList.innerHTML='<div style="color:var(--vscode-descriptionForeground);font-style:italic">No active tasks. AI will populate this when given multi-step work.</div>';
        return;
    }
    todoBar.classList.add('has-todos');
    const completedCount=currentTodos.filter(t=>t.completed).length;
    const allDone=completedCount>=currentTodos.length;
    todoCount.classList.toggle('active',!allDone);
    todoCount.textContent=allDone?'✓ Complete':'('+completedCount+'/'+currentTodos.length+')';
    todoList.innerHTML=currentTodos.map((t,i)=>'<div class="todo-item'+(t.completed?' done':'')+'"><span class="check">'+(t.completed?'✓':'○')+'</span>'+esc(t.text)+'</div>').join('');
    // Save todos to session
    saveTodosToSession();
}
function saveTodosToSession(){
    if(currentTodos.length>0){vs.postMessage({type:'saveTodos',todos:currentTodos});}
}

function parseTodosFromStructured(structured){
    if(structured&&structured.todos&&structured.todos.length>0){
        return structured.todos.map(t=>({text:t.text,completed:t.completed}));
    }
    return [];
}
function parseTodos(text){
    const match=text.match(/📋\\s*TODOS?\\s*\\n([\\s\\S]*?)(?=\\n\\n|📄|$)/i);
    if(match){
        const lines=match[1].split('\\n').filter(l=>l.trim().match(/^-\\s*\\[.?\\]/));
        return lines.map(l=>({text:l.replace(/^-\\s*\\[.?\\]\\s*/,'').trim(),completed:false})).filter(t=>t.text);
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

// Restore saved state (input text + cached chat HTML)
const savedState=vs.getState()||{};
if(savedState.inputText){msg.value=savedState.inputText;msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,120)+'px';}
if(savedState.chatHtml&&savedState.sessionId){
    chat.innerHTML=savedState.chatHtml;
    curSessId=savedState.sessionId;
    totalTokens=savedState.totalTokens||0;
    totalCost=savedState.totalCost||0;
    if(savedState.todos)currentTodos=savedState.todos;
    renderTodos();
    const ctxLimit=getCtxLimit();
    const pct=Math.min(100,Math.round(totalTokens/ctxLimit*100));
    document.getElementById('stats-cost').textContent='$'+totalCost.toFixed(2);
    document.getElementById('stats-pct').textContent=pct+'%';
    updatePctColor(pct);
    setTimeout(()=>{chat.scrollTop=chat.scrollHeight;},10);
}

// Save state for persistence across view switches
function saveInputState(){vs.setState({...vs.getState(),inputText:msg.value});}
function saveChatState(){vs.setState({...vs.getState(),chatHtml:chat.innerHTML,sessionId:curSessId,totalTokens,totalCost,todos:currentTodos});}

// Autocomplete functions - triggers on backtick + 3 chars (e.g. \`04_c)
function getBacktickWord(){
    const text=msg.value,pos=msg.selectionStart;
    let start=pos-1;
    while(start>=0&&text[start]!=='\\\`'&&!/\\s/.test(text[start]))start--;
    if(start<0||text[start]!=='\\\`')return null;
    const word=text.slice(start+1,pos);
    return{word,start,end:pos};
}
function showAutocomplete(files){
    acFiles=files;acIndex=-1;
    if(files.length===0){autocomplete.classList.remove('show');return;}
    autocomplete.innerHTML=files.map((f,i)=>'<div class="ac-item" data-i="'+i+'"><span class="ac-icon">📄</span><span class="ac-path">'+esc(f.relativePath)+'</span></div>').join('');
    autocomplete.classList.add('show');
}
function hideAutocomplete(){autocomplete.classList.remove('show');acFiles=[];acIndex=-1;}
function selectAutocomplete(idx){
    if(idx<0||idx>=acFiles.length)return;
    const file=acFiles[idx];
    const text=msg.value;
    const newText=text.slice(0,acWordStart)+'\\\`'+file.relativePath+'\\\`'+text.slice(acWordEnd);
    msg.value=newText;
    const newPos=acWordStart+file.relativePath.length+2;
    msg.setSelectionRange(newPos,newPos);
    hideAutocomplete();
    saveInputState();
}
autocomplete.onclick=e=>{const item=e.target.closest('.ac-item');if(item)selectAutocomplete(parseInt(item.dataset.i));};

msg.addEventListener('input',()=>{
    msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,120)+'px';
    saveInputState();
    // Autocomplete trigger: backtick + 3+ chars (e.g. \`04_c)
    const match=getBacktickWord();
    if(match&&match.word.length>=3){
        acWordStart=match.start;acWordEnd=match.end;
        clearTimeout(acDebounce);
        acDebounce=setTimeout(()=>{vs.postMessage({type:'searchFiles',query:match.word});},150);
    }else{hideAutocomplete();}
});
let handoffShownThisSession=false;
function updStats(usage){if(usage){totalTokens+=usage.totalTokens||0;const p=usage.promptTokens||0,c=usage.completionTokens||0;const pricing=getModelPricing();totalCost+=(p/1e6)*pricing.inPrice+(c/1e6)*pricing.outPrice;}const ctxLimit=getCtxLimit();const pct=Math.min(100,Math.round(totalTokens/ctxLimit*100));document.getElementById('stats-cost').textContent='$'+totalCost.toFixed(2);document.getElementById('stats-pct').textContent=pct+'%';updatePctColor(pct);if(pct>=75&&!handoffShownThisSession&&!busy){handoffShownThisSession=true;handoffPopup.classList.add('show');}}
function doSend(){const t=msg.value.trim();if((t||attachedImages.length)&&!busy){vs.postMessage({type:'sendMessage',text:t,images:attachedImages});msg.value='';msg.style.height='auto';stream='';attachedImages=[];imgPreview.innerHTML='';imgPreview.classList.remove('show');hideAutocomplete();saveInputState();}}
attachBtn.onclick=()=>fileInput.click();
fileInput.onchange=async e=>{const files=Array.from(e.target.files||[]);for(const f of files){if(!f.type.startsWith('image/'))continue;const reader=new FileReader();reader.onload=ev=>{const b64=ev.target.result.split(',')[1];attachedImages.push(b64);const thumb=document.createElement('div');thumb.className='img-thumb';thumb.innerHTML='<img src="'+ev.target.result+'"><button class="rm" data-i="'+(attachedImages.length-1)+'">×</button>';thumb.querySelector('.rm').onclick=function(){const i=parseInt(this.dataset.i);attachedImages.splice(i,1);updateImgPreview();};imgPreview.appendChild(thumb);imgPreview.classList.add('show');};reader.readAsDataURL(f);}fileInput.value='';};
function updateImgPreview(){imgPreview.innerHTML='';attachedImages.forEach((b64,i)=>{const thumb=document.createElement('div');thumb.className='img-thumb';thumb.innerHTML='<img src="data:image/png;base64,'+b64+'"><button class="rm" data-i="'+i+'">×</button>';thumb.querySelector('.rm').onclick=function(){attachedImages.splice(i,1);updateImgPreview();};imgPreview.appendChild(thumb);});imgPreview.classList.toggle('show',attachedImages.length>0);}
send.onclick=doSend;
// Enter key behavior: configurable via enterToSend setting + autocomplete navigation
msg.onkeydown=e=>{
    // Autocomplete navigation
    if(autocomplete.classList.contains('show')){
        if(e.key==='ArrowDown'){e.preventDefault();acIndex=Math.min(acIndex+1,acFiles.length-1);updateAcSelection();return;}
        if(e.key==='ArrowUp'){e.preventDefault();acIndex=Math.max(acIndex-1,0);updateAcSelection();return;}
        if(e.key==='Enter'||e.key==='Tab'){if(acIndex>=0){e.preventDefault();selectAutocomplete(acIndex);return;}}
        if(e.key==='Escape'){hideAutocomplete();return;}
    }
    if(enterToSend){
        if(e.key==='Enter'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();doSend();}
    }else{
        if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();doSend();}
    }
};
function updateAcSelection(){
    autocomplete.querySelectorAll('.ac-item').forEach((el,i)=>{el.classList.toggle('sel',i===acIndex);if(i===acIndex)el.scrollIntoView({block:'nearest'});});
}
stop.onclick=()=>vs.postMessage({type:'cancelRequest'});
document.getElementById('new').onclick=()=>{hist.classList.remove('show');totalTokens=0;totalCost=0;currentTodos=[];todosCompleted=0;renderTodos();updStats(null);vs.postMessage({type:'newSession'});};
sessEl.onclick=()=>{if(hist.classList.contains('show')){hist.classList.remove('show');}else{vs.postMessage({type:'getHistory'});hist.classList.add('show');}};
document.addEventListener('click',e=>{if(!sessEl.contains(e.target)&&!hist.contains(e.target))hist.classList.remove('show');});
function scrollToBottom(){setTimeout(()=>{chat.scrollTop=chat.scrollHeight;},50);}
window.addEventListener('message',e=>{const m=e.data;
switch(m.type){
case'init':case'sessionChanged':
curSessId=m.sessionId;sessTxt.textContent=m.summary||('Session: '+m.sessionId.slice(0,8));sessTxt.title=(m.summary||m.sessionId)+'\\n['+m.sessionId.slice(0,6)+']';
chat.innerHTML='';totalTokens=0;totalCost=0;handoffShownThisSession=false;updatePctColor(0);if(m.history){m.history.forEach((p,i)=>{addPair(p,i,0);if(p.response.usage)updStats(p.response.usage);});}
// Restore TODOs from session
if(m.todos&&m.todos.length>0){currentTodos=m.todos;renderTodos();}else{currentTodos=[];renderTodos();}
hist.classList.remove('show');scrollToBottom();saveChatState();break;
case'historyList':
hist.innerHTML='';m.sessions.forEach(s=>{const d=document.createElement('div');d.className='hist-item'+(s.id===m.currentSessionId?' active':'');
const sum=document.createElement('div');sum.className='hist-sum';sum.textContent=s.summary||'New chat';sum.title=s.summary||'';
const meta=document.createElement('div');meta.className='hist-meta';meta.textContent=timeAgo(s.updatedAt)+(s.pairCount?' · '+s.pairCount+' msgs':'');
d.appendChild(sum);d.appendChild(meta);d.onclick=()=>{vs.postMessage({type:'loadSession',sessionId:s.id});};hist.appendChild(d);});break;
case'newMessagePair':addPair(m.pair,m.pairIndex,1);busy=1;updUI();scrollToBottom();break;
case'updateResponseChunk':if(curDiv){stream+=m.deltaText;updStream();scrollToBottom();}break;
case'requestComplete':
if(curDiv){curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML=fmtFinalStructured(m.structured,m.response.usage,m.diffPreview,m.usedCleanup);updStats(m.response.usage);}
// Use structured TODOs if available, fallback to legacy parsing
let todos=[];
if(m.structured&&m.structured.todos&&m.structured.todos.length>0){todos=parseTodosFromStructured(m.structured);}
else{todos=parseTodos(m.response.text||'');}
if(todos.length>0){currentTodos=todos;renderTodos();}
// Auto-apply if enabled and has file changes (check both diffPreview and structured.fileChanges)
const hasFileChanges=(m.diffPreview&&m.diffPreview.length>0)||(m.structured&&m.structured.fileChanges&&m.structured.fileChanges.length>0);
console.log('[Grok] Auto-apply check: autoApply='+autoApply+', diffPreview='+JSON.stringify(m.diffPreview)+', fileChanges='+(m.structured?.fileChanges?.length||0));
if(autoApply&&hasFileChanges){console.log('[Grok] Triggering auto-apply');vs.postMessage({type:'applyEdits',editId:'all'});}
busy=0;curDiv=null;stream='';updUI();scrollToBottom();saveChatState();break;
case'requestCancelled':if(curDiv){curDiv.classList.add('e');curDiv.querySelector('.c').innerHTML+='<div style="color:#c44;margin-top:6px">⏹ Cancelled</div>';}busy=0;curDiv=null;stream='';updUI();break;
case'error':if(curDiv){curDiv.classList.add('e');curDiv.classList.remove('p');curDiv.querySelector('.c').innerHTML='<div style="color:#c44">⚠️ Error: '+esc(m.message)+'</div><button class="btn btn-s" style="margin-top:6px" onclick="vs.postMessage({type:\\'retryLastRequest\\'})">Retry</button>';}busy=0;curDiv=null;stream='';updUI();break;
case'usageUpdate':updStats(m.usage);break;
case'commandOutput':showCmdOutput(m.command,m.output,m.isError);updateActionSummary('commands',1);break;
case'changesUpdate':changeHistory=m.changes;currentChangePos=m.currentPosition;renderChanges();break;
case'editsApplied':if(m.changeSet){vs.postMessage({type:'getChanges'});
// Mark next uncompleted todo as done
const nextIdx=currentTodos.findIndex(t=>!t.completed);
if(nextIdx>=0){currentTodos[nextIdx].completed=true;}
renderTodos();updateActionSummary('applies',m.count||1);}break;
case'config':enterToSend=m.enterToSend||false;autoApply=m.autoApply!==false;modelMode=m.modelMode||'fast';if(m.activeModel)currentModel=m.activeModel;updateAutoBtn();updateModelBtn();break;
case'fullConfig':if(m.settings)populateSettings(m.settings);break;
case'connectionStatus':
    connectionStatus.couchbase=m.couchbase;connectionStatus.api=m.api;updateStatusDot();
    // Update settings panel test results
    const dbResult=document.getElementById('db-test-result');
    const apiResult=document.getElementById('api-test-result');
    if(dbResult){dbResult.innerHTML='<div class="test-result '+(m.couchbase?'success':'error')+'">'+(m.couchbase?'✓ Couchbase connected':'✗ Couchbase connection failed')+'</div>';}
    if(apiResult){apiResult.innerHTML='<div class="test-result '+(m.api?'success':'error')+'">'+(m.api?'✓ Grok API connected':'✗ API connection failed')+'</div>';}
    break;
case'fileSearchResults':showAutocomplete(m.files||[]);break;
case'prefillInput':msg.value=m.text;msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,120)+'px';saveInputState();break;
case'modelInfo':if(m.models){for(const[id,info]of Object.entries(m.models)){modelInfo[id]={ctx:info.contextLength||131072,inPrice:info.inputPrice||0.30,outPrice:info.outputPrice||0.50};}}break;
case'chartData':renderCharts(m);break;
}});
function showCmdOutput(cmd,out,isErr){const div=document.createElement('div');div.className='msg a';div.innerHTML='<div class="c"><div class="term-out"><div class="term-hdr"><span class="term-cmd">$ '+esc(cmd)+'</span><span style="color:'+(isErr?'#c44':'#6a9')+'">'+( isErr?'Failed':'Done')+'</span></div><div class="term-body">'+esc(out)+'</div></div></div>';chat.appendChild(div);scrollToBottom();}
function timeAgo(d){const s=Math.floor((Date.now()-new Date(d))/1e3);if(s<60)return'now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function repairAndParseJson(text){
if(!text)return null;
var str=text.trim();
if(str.charAt(0)!=='{')return null;
var first=str.indexOf('{');
var last=str.lastIndexOf('}');
if(first<0||last<0||last<=first)return null;
str=str.substring(first,last+1);
// Try parsing as-is first
try{return JSON.parse(str);}catch(e0){}
// Fix: replace \\" that is NOT at string boundaries with escaped form
// The problem: AI writes \" inside JSON strings, but JSON needs \\"
// Solution: Replace single backslash-quote with double-escaped
str=str.replace(/([^\\\\])\\\\"/g,'$1\\\\\\\\"');
try{return JSON.parse(str);}catch(e1){}
// Remove control chars
str=str.replace(/[\\x00-\\x1f]/g,' ');
try{return JSON.parse(str);}catch(e2){}
// Fix trailing commas
str=str.replace(/,\\s*}/g,'}').replace(/,\\s*]/g,']');
try{return JSON.parse(str);}catch(e3){}
return null;
}
function tryParseStructured(text){
if(!text)return null;
var parsed=repairAndParseJson(text);
if(!parsed||typeof parsed!=='object')return null;
// Fix malformed key: AI sometimes outputs "" instead of "sections"
var keys=Object.keys(parsed);
for(var i=0;i<keys.length;i++){
if(keys[i]===''&&Array.isArray(parsed[''])){
parsed.sections=parsed[''];
delete parsed[''];
break;
}
}
if(parsed.summary||parsed.message||parsed.sections||parsed.fileChanges){return parsed;}
return null;
}
function fmtUserMsg(t){return esc(t).replace(/\`([^\`]+)\`/g,'<code>$1</code>');}
function addPair(p,i,streaming){const u=document.createElement('div');u.className='msg u';u.innerHTML=fmtUserMsg(p.request.text);chat.appendChild(u);
const a=document.createElement('div');a.className='msg a';a.dataset.i=i;
const bugIcon='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="14" rx="6" ry="7"/><path d="M12 7V3M8 4c0 1.5 1.8 3 4 3s4-1.5 4-3"/><path d="M4 10h3M17 10h3M4 14h3M17 14h3M4 18h3M17 18h3"/><path d="M8 3l-1-1M16 3l1-1"/></svg>';
const bugBtn='<button class="bug-btn" onclick="reportBug('+i+')" title="Report bug in this response">'+bugIcon+'</button>';
if(p.response.status==='pending'&&streaming){a.classList.add('p');a.innerHTML='<div class="c"><div class="think"><div class="spin"></div>Thinking...</div></div>';curDiv=a;}
else if(p.response.status==='error'){a.classList.add('e');a.innerHTML='<div class="c"><div class="msg-actions">'+bugBtn+'</div>⚠️ Error: '+esc(p.response.errorMessage||'')+'</div>';}
else if(p.response.status==='cancelled'){a.innerHTML='<div class="c"><div class="msg-actions">'+bugBtn+'</div>'+fmtFinal(p.response.text||'',null,null)+'<div style="color:#c44;margin-top:6px">⏹ Cancelled</div></div>';}
else if(p.response.status==='success'){
// Use stored structured data if available (new format), else try to parse text (legacy)
var structured=p.response.structured||tryParseStructured(p.response.text);
var storedDiffPreview=p.response.diffPreview||null;
if(structured&&(structured.summary||structured.message||structured.sections||structured.fileChanges)){
a.innerHTML='<div class="c"><div class="msg-actions">'+bugBtn+'</div>'+fmtFinalStructured(structured,p.response.usage,storedDiffPreview,false)+'</div>';
}else{
a.innerHTML='<div class="c"><div class="msg-actions">'+bugBtn+'</div>'+fmtFinal(p.response.text||'',p.response.usage,storedDiffPreview)+'</div>';
}
}
else{a.innerHTML='<div class="c"><div class="msg-actions">'+bugBtn+'</div>'+fmtFinal(p.response.text||'',p.response.usage,null)+'</div>';}
chat.appendChild(a);}
function updStream(){if(!curDiv)return;const isJson=stream.trim().startsWith('{');curDiv.querySelector('.c').innerHTML='<div class="think"><div class="spin"></div>Generating...</div>'+(isJson?'':'<div style="font-size:12px;color:var(--vscode-descriptionForeground);white-space:pre-wrap;height:120px;overflow-y:auto;line-height:1.5;margin-top:8px;border-left:2px solid var(--vscode-textBlockQuote-border);padding-left:8px">'+fmtMd(stream.slice(-800))+'</div>');}
function fmtFinal(t,u,diffPreview){const result=fmtCode(t,diffPreview);let h=result.html;
// Build done bar with optional action buttons
const filesApplied=autoApply&&result.fileCount>0;
const filesPending=!autoApply&&result.fileCount>0;
const cmdsPending=result.cmdCount>0;
const uInfo=u?'<span class="done-tokens">'+u.totalTokens.toLocaleString()+' tokens</span>':'';
let actionBtns='';
if(filesApplied){actionBtns+='<span class="done-action done-applied">✓ '+result.fileCount+' applied</span>';}
if(filesPending){actionBtns+='<button class="done-action done-pending" onclick="scrollToApply()">Apply '+result.fileCount+'</button>';}
if(cmdsPending){actionBtns+='<button class="done-action done-pending" onclick="scrollToCmd()">Run '+result.cmdCount+' cmd'+(result.cmdCount>1?'s':'')+'</button>';}
h+='<div class="done"><span class="done-check">✓</span><span class="done-txt">Done</span><span class="done-actions">'+actionBtns+'</span>'+uInfo+'</div>';return h;}
function fmtFinalStructured(s,u,diffPreview,usedCleanup){
if(!s||(!s.summary&&!s.message)){return fmtFinal('',u,diffPreview);}
const msgId='msg-'+Date.now();
let h='<div id="'+msgId+'-top"></div>';
if(s.summary&&!s.summary.trim().startsWith('{')&&s.summary.length>5){h+='<p class="summary">'+esc(s.summary)+'</p>';}
if(s.sections&&s.sections.length>0){s.sections.forEach(sec=>{h+='<div class="section"><h3>'+esc(sec.heading)+'</h3>';const content=(sec.content||'').replace(/\\\\n/g,'\\n');h+=fmtMd(content);if(sec.codeBlocks&&sec.codeBlocks.length>0){sec.codeBlocks.forEach(cb=>{if(cb.caption){h+='<div class="code-caption">'+esc(cb.caption)+'</div>';}h+='<pre><code>'+escCode(cb.code)+'</code></pre>';});}h+='</div>';});}
if(s.codeBlocks&&s.codeBlocks.length>0){s.codeBlocks.forEach(cb=>{if(cb.caption){h+='<div class="code-caption">'+esc(cb.caption)+'</div>';}h+='<pre><code>'+escCode(cb.code)+'</code></pre>';});}
if((!s.sections||s.sections.length===0)&&s.message){
// Check if message looks like raw JSON (parsing failed) - try to re-parse it with basic repairs
const msgTrimmed=(s.message||'').trim();
if(msgTrimmed.startsWith('{')&&msgTrimmed.includes('"summary')){
try{
// Apply basic repairs before parsing
let repaired=msgTrimmed;
repaired=repaired.replace(/([a-z])(sections|todos|fileChanges|commands|nextSteps|codeBlocks)"\\s*:\\s*\\[/gi,'$1", "$2": [');
repaired=repaired.replace(/"(summary|heading|content|text|message)"\\\\?:([A-Za-z])/gi,'"$1": "$2');
repaired=repaired.replace(/"(summary|heading|content|text|message)"\\s+"([^"]*?)"/gi,'"$1": "$2"');
repaired=repaired.replace(/"sections"\\s*:\\s*"?heading"\\s*:\\s*/gi,'"sections": [{"heading": ');
const reparsed=JSON.parse(repaired);
const rpFileCount=reparsed.fileChanges?reparsed.fileChanges.length:0;
const rpCmdCount=reparsed.commands?reparsed.commands.length:0;
// Summary
if(reparsed.summary&&!reparsed.summary.trim().startsWith('{')){h+='<p class="summary">'+esc(reparsed.summary)+'</p>';}
// Sections
if(reparsed.sections&&reparsed.sections.length>0){
reparsed.sections.forEach(sec=>{h+='<div class="section"><h3>'+esc(sec.heading||'')+'</h3>';const content=(sec.content||'').replace(/\\\\n/g,'\\n');h+=fmtMd(content);h+='</div>';});
}
// Code blocks
if(reparsed.codeBlocks&&reparsed.codeBlocks.length>0){reparsed.codeBlocks.forEach(cb=>{if(cb.caption){h+='<div class="code-caption">'+esc(cb.caption)+'</div>';}h+='<pre><code>'+esc(cb.code||'')+'</code></pre>';});}
// File changes with full styling
if(rpFileCount>0){
if(rpFileCount>1&&!autoApply){h+='<button class="apply-all" onclick="applyAll()">✅ Apply All '+rpFileCount+' Files</button>';}
reparsed.fileChanges.forEach(fc=>{
const codeContent=fc.isDiff?(fc.content||'').split(/\\r?\\n/).map(line=>{
if(line.startsWith('+')){return '<span class="diff-add">'+esc(line.substring(1))+'</span>';}
if(line.startsWith('-')){return '<span class="diff-rem">'+esc(line.substring(1))+'</span>';}
if(line.startsWith(' ')){return '<span>'+esc(line.substring(1))+'</span>';}
return '<span>'+esc(line)+'</span>';
}).join('\\n'):esc(fc.content||'');
const applyBtn=autoApply?'<span class="btn" style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)">Applied ✓</span>':'<button class="btn btn-ok" onclick="applyFile(\\''+esc(fc.path||'')+'\\')">Apply</button>';
h+='<div class="diff"><div class="diff-h"><span>📄 '+esc(fc.path||'')+'</span>'+applyBtn+'</div><div class="diff-c"><pre><code>'+codeContent+'</code></pre></div></div>';
});}
// Commands
if(rpCmdCount>0){reparsed.commands.forEach(cmd=>{const desc=cmd.description?'<div class="term-desc">'+esc(cmd.description)+'</div>':'';const cmdEsc=esc(cmd.command||'').replace(/'/g,"\\\\'");h+='<div class="term-out"><div class="term-hdr"><div class="term-content"><div class="term-cmd">$ '+esc(cmd.command||'')+'</div>'+desc+'</div><div class="term-btns"><button class="term-copy" onclick="copyCmd(this,\\''+cmdEsc+'\\')">📋</button><button class="term-run" onclick="runCmd(\\''+cmdEsc+'\\')" >▶ Run</button></div></div></div>';});}
// Next steps
if(reparsed.nextSteps&&reparsed.nextSteps.length>0){h+='<div class="next-steps"><div class="next-steps-hdr">💡 Suggested Next Steps</div><div class="next-steps-btns">';reparsed.nextSteps.forEach(step=>{const safeStep=btoa(encodeURIComponent(step));h+='<button class="next-step-btn" data-step="'+safeStep+'">'+esc(step)+'</button>';});h+='</div></div>';}
// What was done summary
if(rpFileCount>0||rpCmdCount>0){
h+='<div class="response-summary"><div class="response-summary-header"><span class="response-summary-title">📝 What was done</span><a href="#" class="nav-link" onclick="this.closest(\\'.msg\\').scrollIntoView({behavior:\\'smooth\\'});return false;">See details ↑</a></div>';
h+='<ul class="summary-list">';
if(rpFileCount>0){const appliedText=autoApply?'Applied':'Ready to apply';h+='<li><strong>'+appliedText+' '+rpFileCount+' file'+(rpFileCount>1?'s':'')+':</strong></li>';reparsed.fileChanges.forEach(fc=>{const fname=(fc.path||'').split('/').pop()||fc.path;h+='<li class="file-item">📄 '+esc(fname)+'</li>';});}
if(rpCmdCount>0){h+='<li><strong>'+rpCmdCount+' command'+(rpCmdCount>1?'s':'')+' to verify:</strong></li>';reparsed.commands.slice(0,3).forEach(cmd=>{h+='<li class="cmd-item">$ '+esc((cmd.command||'').substring(0,50))+((cmd.command||'').length>50?'...':'')+'</li>';});}
h+='</ul></div>';}
// Done bar with action buttons
const rpFilesApplied=autoApply&&rpFileCount>0;const rpFilesPending=!autoApply&&rpFileCount>0;
let rpActionBtns='';
if(rpFilesApplied){rpActionBtns+='<span class="done-action done-applied">✓ '+rpFileCount+' applied</span>';}
if(rpFilesPending){rpActionBtns+='<button class="done-action done-pending" onclick="scrollToApply()">Apply '+rpFileCount+'</button>';}
if(rpCmdCount>0){rpActionBtns+='<button class="done-action done-pending" onclick="scrollToCmd()">Run '+rpCmdCount+' cmd'+(rpCmdCount>1?'s':'')+'</button>';}
h+='<div class="done"><span class="done-check">✓</span><span class="done-txt">Done</span><span class="done-actions">'+rpActionBtns+'</span></div>';
// TODOs
if(reparsed.todos&&reparsed.todos.length>0){currentTodos=reparsed.todos.map(t=>({text:t.text,done:t.completed}));renderTodos();}
}catch(e){console.log('[Grok] Re-parse failed:',e);h+='<p class="summary">Response parsing failed. Try again or enable JSON cleanup in settings.</p>';}
}else{
const msg=(s.message||'').replace(/\\\\n/g,'\\n');h+=fmtMd(msg);
}
}
if(s.fileChanges&&s.fileChanges.length>0){if(s.fileChanges.length>1&&!autoApply){h+='<button class="apply-all" onclick="applyAll()">✅ Apply All '+s.fileChanges.length+' Files</button>';}else if(s.fileChanges.length>1&&autoApply){h+='<div class="apply-all" style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:default">✓ Applied All '+s.fileChanges.length+' Files</div>';}const previewMap={};if(diffPreview){diffPreview.forEach(dp=>{previewMap[dp.file]=dp.stats;});}s.fileChanges.forEach(fc=>{const filename=fc.path.split('/').pop()||fc.path;const stats=previewMap[filename]||previewMap[fc.path]||{added:0,removed:0,modified:0};const statsHtml='<span class="stat-add">+'+stats.added+'</span> <span class="stat-rem">-'+stats.removed+'</span>'+(stats.modified>0?' <span class="stat-mod">~'+stats.modified+'</span>':'');const codeContent=fc.isDiff?fc.content.split(/\\r?\\n/).map(line=>{if(line.startsWith('+')){return '<span class="diff-add">'+esc(line.substring(1))+'</span>';}if(line.startsWith('-')){return '<span class="diff-rem">'+esc(line.substring(1))+'</span>';}if(line.startsWith(' ')){return '<span>'+esc(line.substring(1))+'</span>';}return '<span>'+esc(line)+'</span>';}).join('\\n'):esc(fc.content);const applyBtn=autoApply?'<span class="btn" style="background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)">Applied ✓</span>':'<button class="btn btn-ok" onclick="applyFile(\\''+esc(fc.path)+'\\')">Apply</button>';h+='<div class="diff"><div class="diff-h"><span>📄 '+esc(fc.path)+'</span><div class="diff-stats">'+statsHtml+'</div>'+applyBtn+'</div><div class="diff-c"><pre><code>'+codeContent+'</code></pre></div></div>';});}
if(s.commands&&s.commands.length>0){s.commands.forEach(cmd=>{const desc=cmd.description?'<div class="term-desc">'+esc(cmd.description)+'</div>':'';const cmdEsc=esc(cmd.command).replace(/'/g,"\\\\'");h+='<div class="term-out"><div class="term-hdr"><div class="term-content"><div class="term-cmd">$ '+esc(cmd.command)+'</div>'+desc+'</div><div class="term-btns"><button class="term-copy" onclick="copyCmd(this,\\''+cmdEsc+'\\')">📋</button><button class="term-run" onclick="runCmd(\\''+cmdEsc+'\\')" >▶ Run</button></div></div></div>';});}
if(s.nextSteps&&s.nextSteps.length>0){h+='<div class="next-steps"><div class="next-steps-hdr">💡 Suggested Next Steps</div><div class="next-steps-btns">';s.nextSteps.forEach(step=>{const safeStep=btoa(encodeURIComponent(step));h+='<button class="next-step-btn" data-step="'+safeStep+'">'+esc(step)+'</button>';});h+='</div></div>';}
// Summary section - structured bullet points showing what was done
const fileCount=s.fileChanges?s.fileChanges.length:0;
const cmdCount=s.commands?s.commands.length:0;
if(fileCount>0||cmdCount>0){
h+='<div class="response-summary"><div class="response-summary-header"><span class="response-summary-title">📝 What was done</span><a href="#" class="nav-link" onclick="this.closest(\\'.msg\\').scrollIntoView({behavior:\\'smooth\\'});return false;">See details ↑</a></div>';
h+='<ul class="summary-list">';
if(fileCount>0){
const appliedText=autoApply?'Applied':'Ready to apply';
h+='<li><strong>'+appliedText+' '+fileCount+' file'+(fileCount>1?'s':'')+':</strong></li>';
s.fileChanges.forEach(fc=>{const fname=fc.path.split('/').pop()||fc.path;h+='<li class="file-item">📄 '+esc(fname)+'</li>';});}
if(cmdCount>0){h+='<li><strong>'+cmdCount+' command'+(cmdCount>1?'s':'')+' to verify:</strong></li>';
s.commands.slice(0,3).forEach(cmd=>{h+='<li class="cmd-item">$ '+esc(cmd.command.substring(0,50))+(cmd.command.length>50?'...':'')+'</li>';});
if(cmdCount>3){h+='<li class="cmd-item">...and '+(cmdCount-3)+' more</li>';}}
h+='</ul></div>';}
// Build done bar with optional action buttons
const filesApplied=autoApply&&fileCount>0;
const filesPending=!autoApply&&fileCount>0;
const cmdsPending=cmdCount>0;
const cleanupInfo=usedCleanup?'<span class="done-icon" title="Response was cleaned up by AI">🔧</span>':'';
const uInfo=u?'<span class="done-tokens">'+u.totalTokens.toLocaleString()+' tokens</span>':'';
// Build action buttons for pending items
let actionBtns='';
if(filesApplied){actionBtns+='<span class="done-action done-applied">✓ '+fileCount+' applied</span>';}
if(filesPending){actionBtns+='<button class="done-action done-pending" onclick="scrollToApply()">Apply '+fileCount+'</button>';}
if(cmdsPending){actionBtns+='<button class="done-action done-pending" onclick="scrollToCmd()">Run '+cmdCount+' cmd'+(cmdCount>1?'s':'')+'</button>';}
h+='<div class="done"><span class="done-check">✓</span><span class="done-txt">Done</span>'+cleanupInfo+'<span class="done-actions">'+actionBtns+'</span>'+uInfo+'</div>';return h;}
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
// Count terminal commands in original text
const cmdBt=String.fromCharCode(96);
const cmdMatches=t.match(new RegExp('🖥️\\\\s*'+cmdBt+'[^'+cmdBt+']+'+cmdBt,'g'));
const cmdCount=cmdMatches?cmdMatches.length:0;
return {html:fmtMd(out),fileCount:fileBlocks.length,cmdCount:cmdCount};}
function fmtMd(t){const bt=String.fromCharCode(96);
// Store code blocks to protect from other transformations
const codeBlocks=[];
t=t.replace(new RegExp(bt+bt+bt+'(\\\\w+)?\\\\n([\\\\s\\\\S]*?)'+bt+bt+bt,'g'),function(m,lang,code){
    const highlighted=code.split('\\n').map(line=>{
        if(line.startsWith('+')){return '<span class="diff-add">'+esc(line.substring(1))+'</span>';}
        if(line.startsWith('-')){return '<span class="diff-rem">'+esc(line.substring(1))+'</span>';}
        return esc(line);
    }).join('\\n');
    codeBlocks.push('<pre><code>'+highlighted+'</code></pre>');
    return '%%CODE'+codeBlocks.length+'%%';
});
// Inline code - protect these too
const inlineCodes=[];
t=t.replace(new RegExp(bt+'([^'+bt+'\\\\n]+)'+bt,'g'),function(m,code){
    inlineCodes.push('<code>'+esc(code)+'</code>');
    return '%%INLINE'+inlineCodes.length+'%%';
});
// Terminal commands
t=t.replace(/🖥️\\s*%%INLINE(\\d+)%%/g,function(m,idx){
    const code=inlineCodes[parseInt(idx)-1]||'';
    const cmd=code.replace(/<\\/?code>/g,'');
    return '<div class="term-out"><div class="term-hdr"><div class="term-content"><div class="term-cmd">$ '+cmd+'</div></div><div class="term-btns"><button class="term-copy" onclick="copyCmd(this,\\''+cmd.replace(/'/g,"\\\\'")+'\\')">📋</button><button class="term-run" onclick="runCmd(\\''+cmd.replace(/'/g,"\\\\'")+'\\')">▶ Run</button></div></div></div>';
});
// Markdown tables - greedy match for rows to capture full line
t=t.replace(/^\\|(.+)\\|\\s*\\n\\|[-:|\\s]+\\|\\s*\\n((?:\\|.+\\|\\s*\\n?)+)/gm,function(m,header,body){
    const hCells=header.split('|').map(c=>c.trim()).filter(c=>c);
    const bRows=body.trim().split('\\n').filter(r=>r.trim());
    let tbl='<table><thead><tr>';
    hCells.forEach(c=>{tbl+='<th>'+c+'</th>';});
    tbl+='</tr></thead><tbody>';
    bRows.forEach(row=>{
        const cells=row.replace(/^\\|/,'').replace(/\\|$/,'').split('|').map(c=>c.trim()).filter(c=>c);
        tbl+='<tr>';
        cells.forEach(c=>{tbl+='<td>'+c+'</td>';});
        tbl+='</tr>';
    });
    tbl+='</tbody></table>';
    return tbl;
});
// Headers
t=t.replace(/^### (.+)$/gm,'<h3>$1</h3>');
t=t.replace(/^## (.+)$/gm,'<h2>$1</h2>');
t=t.replace(/^# (.+)$/gm,'<h1>$1</h1>');
// Checklists - [ ] and [x]
t=t.replace(/^-\\s*\\[\\s*\\]\\s*(.+)$/gm,'<li class="checklist"><span class="check-box">☐</span> $1</li>');
t=t.replace(/^-\\s*\\[[xX]\\]\\s*(.+)$/gm,'<li class="checklist done"><span class="check-box">☑</span> $1</li>');
// Lists
t=t.replace(/^- (.+)$/gm,'<li>$1</li>');
t=t.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
// Bold/italic
t=t.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
t=t.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
// Paragraphs
t=t.replace(/\\n\\n/g,'</p><p>');
t=t.replace(/\\n/g,'<br>');
// Restore code blocks and inline code
t=t.replace(/%%CODE(\\d+)%%/g,function(m,idx){return codeBlocks[parseInt(idx)-1]||'';});
t=t.replace(/%%INLINE(\\d+)%%/g,function(m,idx){return inlineCodes[parseInt(idx)-1]||'';});
return '<p>'+t+'</p>';}
function esc(t){const d=document.createElement('div');d.textContent=t||'';return d.innerHTML;}
function escCode(t){const d=document.createElement('div');d.textContent=(t||'').replace(/\\\\n/g,'\\n');return d.innerHTML;}
function applyFile(f){vs.postMessage({type:'applyEdits',editId:f});}
function applyAll(){vs.postMessage({type:'applyEdits',editId:'all'});}
function runCmd(c){vs.postMessage({type:'runCommand',command:c});}
function copyCmd(btn,c){navigator.clipboard.writeText(c).then(()=>{btn.textContent='✓ Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='📋 Copy';btn.classList.remove('copied');},2000);});}
function scrollToEl(id){const el=document.getElementById(id);if(el){el.scrollIntoView({behavior:'smooth',block:'start'});}}
function scrollToApply(){const el=document.querySelector('.diff .btn-ok, .apply-all');if(el){el.scrollIntoView({behavior:'smooth',block:'center'});}}
function scrollToCmd(){const el=document.querySelector('.term-run');if(el){el.scrollIntoView({behavior:'smooth',block:'center'});}}
function updateActionSummary(actionType,count){
// Find all action summaries and update the relevant counts
const items=document.querySelectorAll('.action-item[data-action="'+actionType+'"]');
items.forEach(item=>{
const countEl=item.querySelector('.action-count');
if(countEl){
let current=parseInt(countEl.textContent)||0;
current=Math.max(0,current-count);
if(current===0){item.classList.remove('pending');item.classList.add('done');item.innerHTML='✓ '+actionType.charAt(0).toUpperCase()+actionType.slice(1)+' complete';}
else{countEl.textContent=current;}}});}
function sendNextStep(step){msg.value=step;doSend();}
document.addEventListener('click',e=>{
    const btn=e.target.closest('.next-step-btn');
    if(btn&&btn.dataset.step){
        const step=decodeURIComponent(atob(btn.dataset.step));
        sendNextStep(step);
    }
});
function updUI(){stop.classList.toggle('vis',busy);send.style.display=busy?'none':'block';msg.disabled=busy;if(!busy)msg.focus();}
vs.postMessage({type:'ready'});
vs.postMessage({type:'getConfig'});
</script></body></html>`;
    }

    /**
     * Get the GitHub remote URL from git config
     */
    private async _getGitRemoteUrl(): Promise<string | null> {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) return null;

            const git = gitExtension.exports.getAPI(1);
            const repo = git.repositories[0];
            if (!repo) return null;

            const remotes = repo.state.remotes;
            const origin = remotes.find((r: any) => r.name === 'origin');
            if (!origin) return null;

            // Convert git URL to https URL
            let url = origin.fetchUrl || origin.pushUrl || '';
            if (url.startsWith('git@github.com:')) {
                url = url.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
            } else if (url.endsWith('.git')) {
                url = url.replace(/\.git$/, '');
            }

            return url;
        } catch (err) {
            debug('Failed to get git remote URL:', err);
            return null;
        }
    }

    /**
     * Offer to restore files from GitHub when AI provides truncated content
     */
    private async _offerGitHubRestore(blockedChanges: string[], gitRemoteUrl: string): Promise<void> {
        // Extract file paths from blocked changes (format: "path/to/file: warning message")
        const filePaths = blockedChanges.map(bc => bc.split(':')[0].trim());
        
        const selection = await vscode.window.showQuickPick(
            filePaths.map(fp => ({ label: fp, description: 'Restore from GitHub main branch' })),
            { 
                placeHolder: 'Select file(s) to restore from GitHub',
                canPickMany: true 
            }
        );

        if (!selection || selection.length === 0) return;

        for (const item of selection) {
            const filePath = item.label;
            // Construct raw GitHub URL
            const rawUrl = `https://raw.githubusercontent.com/${gitRemoteUrl.replace('https://github.com/', '')}/main/${filePath}`;
            
            info(`Fetching ${filePath} from GitHub: ${rawUrl}`);
            
            const result = await fetchUrl(rawUrl);
            
            if (result.success && result.content) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders) {
                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
                    
                    // Write the fetched content
                    const encoder = new TextEncoder();
                    await vscode.workspace.fs.writeFile(fileUri, encoder.encode(result.content));
                    
                    vscode.window.showInformationMessage(`Restored ${filePath} from GitHub (${result.bytes} bytes)`);
                    info(`Restored ${filePath}: ${result.bytes} bytes from ${rawUrl}`);
                }
            } else {
                vscode.window.showErrorMessage(`Failed to fetch ${filePath}: ${result.error}`);
                logError(`GitHub fetch failed for ${filePath}: ${result.error}`);
            }
        }
    }
}
