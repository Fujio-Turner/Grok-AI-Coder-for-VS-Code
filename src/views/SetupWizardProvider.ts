import * as vscode from 'vscode';
import { getCouchbaseClient } from '../storage/couchbaseClient';
import { testApiConnection } from '../api/grokClient';
import { info, debug, error } from '../utils/logger';

const SETUP_COMPLETE_KEY = 'grok.setupComplete';

export class SetupWizardProvider {
    private panel: vscode.WebviewPanel | null = null;
    
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly context: vscode.ExtensionContext
    ) {}

    /**
     * Check if first-run setup is needed
     */
    static async isSetupNeeded(context: vscode.ExtensionContext): Promise<boolean> {
        // Check if setup was already completed
        const setupComplete = context.globalState.get<boolean>(SETUP_COMPLETE_KEY);
        if (setupComplete) {
            return false;
        }

        // Check if API key exists
        const apiKey = await context.secrets.get('grokApiKey');
        if (apiKey) {
            // User already has an API key, mark setup as complete
            await context.globalState.update(SETUP_COMPLETE_KEY, true);
            return false;
        }

        return true;
    }

    /**
     * Show the setup wizard
     */
    async show(): Promise<void> {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'grokSetupWizard',
            'Grok AI Coder - Setup',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getHtml();

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'saveApiKey':
                    await this.saveApiKey(message.apiKey);
                    break;
                case 'saveCouchbaseSettings':
                    await this.saveCouchbaseSettings(message.settings);
                    break;
                case 'testConnections':
                    await this.testConnections();
                    break;
                case 'completeSetup':
                    await this.completeSetup();
                    break;
                case 'skipSetup':
                    await this.skipSetup();
                    break;
            }
        });

        this.panel.onDidDispose(() => {
            this.panel = null;
        });

        info('Setup wizard opened');
    }

    private async saveApiKey(apiKey: string): Promise<void> {
        try {
            await this.context.secrets.store('grokApiKey', apiKey);
            this.sendMessage({ type: 'apiKeySaved', success: true });
            info('API key saved via setup wizard');
        } catch (err) {
            error('Failed to save API key:', err);
            this.sendMessage({ type: 'apiKeySaved', success: false, error: String(err) });
        }
    }

    private async saveCouchbaseSettings(settings: {
        url: string;
        username: string;
        password: string;
        bucket: string;
        deployment: string;
        capellaDataApiUrl?: string;
    }): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('grok');
            await config.update('couchbaseUrl', settings.url, vscode.ConfigurationTarget.Global);
            await config.update('couchbaseUsername', settings.username, vscode.ConfigurationTarget.Global);
            await config.update('couchbasePassword', settings.password, vscode.ConfigurationTarget.Global);
            await config.update('couchbaseBucket', settings.bucket, vscode.ConfigurationTarget.Global);
            await config.update('couchbaseDeployment', settings.deployment, vscode.ConfigurationTarget.Global);
            if (settings.capellaDataApiUrl) {
                await config.update('capellaDataApiUrl', settings.capellaDataApiUrl, vscode.ConfigurationTarget.Global);
            }
            
            this.sendMessage({ type: 'couchbaseSettingsSaved', success: true });
            info('Couchbase settings saved via setup wizard');
        } catch (err) {
            error('Failed to save Couchbase settings:', err);
            this.sendMessage({ type: 'couchbaseSettingsSaved', success: false, error: String(err) });
        }
    }

    private async testConnections(): Promise<void> {
        this.sendMessage({ type: 'testingConnections' });

        // Test Couchbase
        let cbResult = false;
        let cbError = '';
        try {
            const client = getCouchbaseClient();
            cbResult = await client.ping();
        } catch (err) {
            cbError = String(err);
        }

        // Test Grok API
        let apiResult = false;
        let apiError = '';
        let apiLatency = 0;
        try {
            const apiKey = await this.context.secrets.get('grokApiKey');
            if (apiKey) {
                const result = await testApiConnection(apiKey);
                apiResult = result.success;
                apiError = result.error || '';
                apiLatency = result.latencyMs || 0;
            } else {
                apiError = 'No API key set';
            }
        } catch (err) {
            apiError = String(err);
        }

        this.sendMessage({
            type: 'connectionTestResults',
            couchbase: { success: cbResult, error: cbError },
            api: { success: apiResult, error: apiError, latencyMs: apiLatency }
        });
    }

    private async completeSetup(): Promise<void> {
        await this.context.globalState.update(SETUP_COMPLETE_KEY, true);
        info('Setup wizard completed');
        this.panel?.dispose();
        vscode.window.showInformationMessage('Grok AI Coder setup complete! You can start chatting now.');
    }

    private async skipSetup(): Promise<void> {
        // Don't mark as complete so it shows again next time
        info('Setup wizard skipped');
        this.panel?.dispose();
    }

    private sendMessage(message: unknown): void {
        this.panel?.webview.postMessage(message);
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Grok AI Coder Setup</title>
    <style>
        :root {
            --bg-color: #1a1a2e;
            --card-bg: #16213e;
            --border-color: #0f3460;
            --text-primary: #e4e4e4;
            --text-secondary: #a0a0a0;
            --accent: #e94560;
            --accent-hover: #ff6b6b;
            --success: #4ade80;
            --error: #f87171;
            --input-bg: #0f3460;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-color);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 40px 20px;
        }
        
        .wizard-container {
            max-width: 600px;
            width: 100%;
        }
        
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        
        .header h1 {
            font-size: 2rem;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
        }
        
        .header p {
            color: var(--text-secondary);
        }
        
        .logo {
            width: 48px;
            height: 48px;
        }
        
        .step {
            display: none;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 20px;
        }
        
        .step.active {
            display: block;
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .step-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .step-number {
            background: var(--accent);
            color: white;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 14px;
        }
        
        .step-title {
            font-size: 1.25rem;
            font-weight: 600;
        }
        
        .step-description {
            color: var(--text-secondary);
            margin-bottom: 24px;
            line-height: 1.6;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            font-size: 14px;
        }
        
        .form-group input,
        .form-group select {
            width: 100%;
            padding: 12px 16px;
            background: var(--input-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            color: var(--text-primary);
            font-size: 14px;
            transition: border-color 0.2s;
        }
        
        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: var(--accent);
        }
        
        .form-group small {
            display: block;
            margin-top: 6px;
            color: var(--text-secondary);
            font-size: 12px;
        }
        
        .form-group small a {
            color: var(--accent);
            text-decoration: none;
        }
        
        .form-group small a:hover {
            text-decoration: underline;
        }
        
        .button-group {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }
        
        button {
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            border: none;
        }
        
        .btn-primary {
            background: var(--accent);
            color: white;
            flex: 1;
        }
        
        .btn-primary:hover {
            background: var(--accent-hover);
        }
        
        .btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .btn-secondary {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
        }
        
        .btn-secondary:hover {
            border-color: var(--text-secondary);
            color: var(--text-primary);
        }
        
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 12px 16px;
            border-radius: 8px;
            margin-top: 16px;
            font-size: 14px;
        }
        
        .status-success {
            background: rgba(74, 222, 128, 0.1);
            border: 1px solid var(--success);
            color: var(--success);
        }
        
        .status-error {
            background: rgba(248, 113, 113, 0.1);
            border: 1px solid var(--error);
            color: var(--error);
        }
        
        .status-pending {
            background: rgba(251, 191, 36, 0.1);
            border: 1px solid #fbbf24;
            color: #fbbf24;
        }
        
        .connection-results {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin: 20px 0;
        }
        
        .connection-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px;
            background: var(--input-bg);
            border-radius: 8px;
        }
        
        .connection-name {
            font-weight: 500;
        }
        
        .connection-status {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .progress-bar {
            display: flex;
            gap: 8px;
            margin-bottom: 30px;
        }
        
        .progress-step {
            flex: 1;
            height: 4px;
            background: var(--border-color);
            border-radius: 2px;
            transition: background 0.3s;
        }
        
        .progress-step.completed {
            background: var(--accent);
        }
        
        .progress-step.active {
            background: var(--accent);
            opacity: 0.6;
        }
        
        .welcome-features {
            display: grid;
            gap: 16px;
            margin: 24px 0;
        }
        
        .feature-item {
            display: flex;
            gap: 12px;
            align-items: flex-start;
        }
        
        .feature-icon {
            font-size: 20px;
        }
        
        .feature-text h4 {
            font-size: 14px;
            margin-bottom: 4px;
        }
        
        .feature-text p {
            font-size: 13px;
            color: var(--text-secondary);
        }
        
        .spinner {
            animation: spin 1s linear infinite;
            display: inline-block;
        }
        
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="wizard-container">
        <div class="header">
            <h1>
                <svg class="logo" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect width="48" height="48" rx="12" fill="#e94560"/>
                    <text x="50%" y="55%" text-anchor="middle" fill="white" font-size="24" font-weight="bold" dy=".1em">G</text>
                </svg>
                Welcome to Grok AI Coder
            </h1>
            <p>Let's set up your AI coding assistant in a few quick steps</p>
        </div>
        
        <div class="progress-bar">
            <div class="progress-step" id="progress-1"></div>
            <div class="progress-step" id="progress-2"></div>
            <div class="progress-step" id="progress-3"></div>
            <div class="progress-step" id="progress-4"></div>
        </div>
        
        <!-- Step 1: Welcome -->
        <div class="step active" id="step-1">
            <div class="step-header">
                <div class="step-number">1</div>
                <div class="step-title">Welcome</div>
            </div>
            <p class="step-description">
                Grok AI Coder brings the power of xAI's Grok models directly into your VS Code editor.
                To get started, you'll need to configure two things:
            </p>
            
            <div class="welcome-features">
                <div class="feature-item">
                    <span class="feature-icon">🔑</span>
                    <div class="feature-text">
                        <h4>xAI API Key</h4>
                        <p>Required to communicate with Grok AI models</p>
                    </div>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🗄️</span>
                    <div class="feature-text">
                        <h4>Couchbase Database</h4>
                        <p>Stores your chat history and enables session persistence</p>
                    </div>
                </div>
            </div>
            
            <div class="button-group">
                <button class="btn-primary" onclick="goToStep(2)">Get Started →</button>
            </div>
            <div class="button-group" style="margin-top: 8px;">
                <button class="btn-secondary" onclick="skipSetup()">Skip for now</button>
            </div>
        </div>
        
        <!-- Step 2: API Key -->
        <div class="step" id="step-2">
            <div class="step-header">
                <div class="step-number">2</div>
                <div class="step-title">xAI API Key</div>
            </div>
            <p class="step-description">
                Enter your xAI API key to enable communication with Grok models.
                Your key is stored securely in VS Code's secret storage.
            </p>
            
            <div class="form-group">
                <label for="apiKey">API Key</label>
                <input type="password" id="apiKey" placeholder="xai-..." />
                <small>Get your API key at <a href="https://x.ai/api" target="_blank">x.ai/api</a></small>
            </div>
            
            <div id="apiKeyStatus"></div>
            
            <div class="button-group">
                <button class="btn-secondary" onclick="goToStep(1)">← Back</button>
                <button class="btn-primary" id="saveApiKeyBtn" onclick="saveApiKey()">Save & Continue →</button>
            </div>
        </div>
        
        <!-- Step 3: Couchbase -->
        <div class="step" id="step-3">
            <div class="step-header">
                <div class="step-number">3</div>
                <div class="step-title">Couchbase Database</div>
            </div>
            <p class="step-description">
                Configure your Couchbase connection for persistent chat history.
                You can use a local Couchbase Server or Couchbase Capella cloud.
            </p>
            
            <div class="form-group">
                <label for="cbDeployment">Deployment Type</label>
                <select id="cbDeployment" onchange="updateDeploymentFields()">
                    <option value="self-hosted">Self-Hosted (local Couchbase Server)</option>
                    <option value="capella-sdk">Couchbase Capella - SDK</option>
                    <option value="capella-data-api">Couchbase Capella - Data API</option>
                </select>
            </div>
            
            <div class="form-group" id="row-cbUrl">
                <label for="cbUrl">Server URL</label>
                <input type="text" id="cbUrl" placeholder="http://localhost" value="http://localhost" />
                <small id="cbUrlHint">For self-hosted: http://localhost or your server address</small>
            </div>
            
            <div class="form-group" id="row-capellaDataApiUrl" style="display:none">
                <label for="capellaDataApiUrl">Capella Data API URL</label>
                <input type="text" id="capellaDataApiUrl" placeholder="https://your-cluster.data.cloud.couchbase.com" />
                <small>Capella Data API endpoint URL</small>
            </div>
            
            <div class="form-group">
                <label for="cbUsername">Username</label>
                <input type="text" id="cbUsername" placeholder="Administrator" value="Administrator" />
            </div>
            
            <div class="form-group">
                <label for="cbPassword">Password</label>
                <input type="password" id="cbPassword" placeholder="Enter password" />
            </div>
            
            <div class="form-group">
                <label for="cbBucket">Bucket Name</label>
                <input type="text" id="cbBucket" placeholder="grokCoder" value="grokCoder" />
                <small>Create this bucket in Couchbase before connecting</small>
            </div>
            
            <div id="couchbaseStatus"></div>
            
            <div class="button-group">
                <button class="btn-secondary" onclick="goToStep(2)">← Back</button>
                <button class="btn-primary" id="saveCouchbaseBtn" onclick="saveCouchbaseSettings()">Save & Continue →</button>
            </div>
        </div>
        
        <!-- Step 4: Test & Complete -->
        <div class="step" id="step-4">
            <div class="step-header">
                <div class="step-number">4</div>
                <div class="step-title">Test Connections</div>
            </div>
            <p class="step-description">
                Let's verify that everything is configured correctly.
            </p>
            
            <div class="connection-results" id="connectionResults">
                <div class="connection-item">
                    <span class="connection-name">Couchbase Database</span>
                    <span class="connection-status" id="cbTestStatus">
                        <span style="color: var(--text-secondary);">Not tested</span>
                    </span>
                </div>
                <div class="connection-item">
                    <span class="connection-name">Grok API</span>
                    <span class="connection-status" id="apiTestStatus">
                        <span style="color: var(--text-secondary);">Not tested</span>
                    </span>
                </div>
            </div>
            
            <div class="button-group">
                <button class="btn-secondary" onclick="testConnections()" id="testBtn">🔄 Test Connections</button>
                <button class="btn-primary" onclick="completeSetup()" id="completeBtn">Complete Setup ✓</button>
            </div>
            
            <div class="button-group" style="margin-top: 8px;">
                <button class="btn-secondary" onclick="goToStep(3)">← Back to Settings</button>
            </div>
        </div>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        let currentStep = 1;
        
        function goToStep(step) {
            // Hide current step
            document.getElementById('step-' + currentStep).classList.remove('active');
            
            // Show new step
            document.getElementById('step-' + step).classList.add('active');
            
            // Update progress bar
            for (let i = 1; i <= 4; i++) {
                const progressEl = document.getElementById('progress-' + i);
                progressEl.classList.remove('completed', 'active');
                if (i < step) {
                    progressEl.classList.add('completed');
                } else if (i === step) {
                    progressEl.classList.add('active');
                }
            }
            
            currentStep = step;
        }
        
        function saveApiKey() {
            const apiKey = document.getElementById('apiKey').value.trim();
            if (!apiKey) {
                showStatus('apiKeyStatus', 'Please enter an API key', 'error');
                return;
            }
            
            document.getElementById('saveApiKeyBtn').disabled = true;
            document.getElementById('saveApiKeyBtn').textContent = 'Saving...';
            
            vscode.postMessage({ type: 'saveApiKey', apiKey });
        }
        
        function saveCouchbaseSettings() {
            const deployment = document.getElementById('cbDeployment').value;
            const capellaDataApiUrlEl = document.getElementById('capellaDataApiUrl');
            const settings = {
                url: document.getElementById('cbUrl').value.trim(),
                username: document.getElementById('cbUsername').value.trim(),
                password: document.getElementById('cbPassword').value,
                bucket: document.getElementById('cbBucket').value.trim(),
                deployment: deployment,
                capellaDataApiUrl: capellaDataApiUrlEl ? capellaDataApiUrlEl.value.trim() : ''
            };
            
            // Validate based on deployment type
            if (deployment === 'capella-data-api') {
                if (!settings.capellaDataApiUrl || !settings.username || !settings.bucket) {
                    showStatus('couchbaseStatus', 'Please fill in all required fields', 'error');
                    return;
                }
            } else {
                if (!settings.url || !settings.username || !settings.bucket) {
                    showStatus('couchbaseStatus', 'Please fill in all required fields', 'error');
                    return;
                }
            }
            
            document.getElementById('saveCouchbaseBtn').disabled = true;
            document.getElementById('saveCouchbaseBtn').textContent = 'Saving...';
            
            vscode.postMessage({ type: 'saveCouchbaseSettings', settings });
        }
        
        function testConnections() {
            document.getElementById('testBtn').disabled = true;
            document.getElementById('testBtn').textContent = '⏳ Testing...';
            
            document.getElementById('cbTestStatus').innerHTML = '<span class="spinner">⏳</span> Testing...';
            document.getElementById('apiTestStatus').innerHTML = '<span class="spinner">⏳</span> Testing...';
            
            vscode.postMessage({ type: 'testConnections' });
        }
        
        function completeSetup() {
            vscode.postMessage({ type: 'completeSetup' });
        }
        
        function skipSetup() {
            vscode.postMessage({ type: 'skipSetup' });
        }
        
        function updateDeploymentFields() {
            const deployment = document.getElementById('cbDeployment').value;
            const urlHint = document.getElementById('cbUrlHint');
            const urlInput = document.getElementById('cbUrl');
            const urlRow = document.getElementById('row-cbUrl');
            const dataApiRow = document.getElementById('row-capellaDataApiUrl');
            
            if (deployment === 'capella-sdk') {
                urlRow.style.display = 'block';
                dataApiRow.style.display = 'none';
                urlHint.textContent = 'Capella SDK connection string hostname (e.g., cb.xxxxx.cloud.couchbase.com)';
                urlInput.placeholder = 'cb.xxxxx.cloud.couchbase.com';
            } else if (deployment === 'capella-data-api') {
                urlRow.style.display = 'none';
                dataApiRow.style.display = 'block';
            } else {
                urlRow.style.display = 'block';
                dataApiRow.style.display = 'none';
                urlHint.textContent = 'For self-hosted: http://localhost or your server address';
                urlInput.placeholder = 'http://localhost';
            }
        }
        
        function showStatus(elementId, message, type) {
            const el = document.getElementById(elementId);
            el.className = 'status-indicator status-' + type;
            el.textContent = message;
        }
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'apiKeySaved':
                    document.getElementById('saveApiKeyBtn').disabled = false;
                    document.getElementById('saveApiKeyBtn').textContent = 'Save & Continue →';
                    
                    if (message.success) {
                        showStatus('apiKeyStatus', '✓ API key saved securely', 'success');
                        setTimeout(() => goToStep(3), 500);
                    } else {
                        showStatus('apiKeyStatus', '✗ ' + (message.error || 'Failed to save'), 'error');
                    }
                    break;
                    
                case 'couchbaseSettingsSaved':
                    document.getElementById('saveCouchbaseBtn').disabled = false;
                    document.getElementById('saveCouchbaseBtn').textContent = 'Save & Continue →';
                    
                    if (message.success) {
                        showStatus('couchbaseStatus', '✓ Settings saved', 'success');
                        setTimeout(() => goToStep(4), 500);
                    } else {
                        showStatus('couchbaseStatus', '✗ ' + (message.error || 'Failed to save'), 'error');
                    }
                    break;
                    
                case 'connectionTestResults':
                    document.getElementById('testBtn').disabled = false;
                    document.getElementById('testBtn').textContent = '🔄 Test Connections';
                    
                    // Couchbase result
                    const cbStatus = document.getElementById('cbTestStatus');
                    if (message.couchbase.success) {
                        cbStatus.innerHTML = '<span style="color: var(--success);">✓ Connected</span>';
                    } else {
                        cbStatus.innerHTML = '<span style="color: var(--error);">✗ ' + (message.couchbase.error || 'Failed') + '</span>';
                    }
                    
                    // API result
                    const apiStatus = document.getElementById('apiTestStatus');
                    if (message.api.success) {
                        apiStatus.innerHTML = '<span style="color: var(--success);">✓ Connected (' + message.api.latencyMs + 'ms)</span>';
                    } else {
                        apiStatus.innerHTML = '<span style="color: var(--error);">✗ ' + (message.api.error || 'Failed') + '</span>';
                    }
                    break;
            }
        });
        
        // Initialize progress bar
        document.getElementById('progress-1').classList.add('active');
    </script>
</body>
</html>`;
    }
}

/**
 * Register setup wizard command and check for first run
 */
export async function initSetupWizard(context: vscode.ExtensionContext): Promise<void> {
    const wizard = new SetupWizardProvider(context.extensionUri, context);
    
    // Register command to manually open setup wizard
    context.subscriptions.push(
        vscode.commands.registerCommand('grok.openSetupWizard', () => {
            wizard.show();
        })
    );

    // Check if first-run setup is needed
    const needsSetup = await SetupWizardProvider.isSetupNeeded(context);
    if (needsSetup) {
        // Show wizard after a short delay to let VS Code finish loading
        setTimeout(() => {
            wizard.show();
        }, 1000);
    }
}
