import { getConfig, debug, error, info, warn } from '../utils/logger';

// Couchbase SDK is loaded dynamically to handle native module issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let couchbase: typeof import('couchbase') | null = null;
let couchbaseLoadAttempted = false;
let couchbaseLoadError: Error | null = null;

async function loadCouchbaseSDK(): Promise<typeof import('couchbase') | null> {
    if (couchbaseLoadAttempted) {
        return couchbase;
    }
    couchbaseLoadAttempted = true;
    
    try {
        couchbase = await import('couchbase');
        info('Couchbase SDK loaded successfully');
        return couchbase;
    } catch (err) {
        couchbaseLoadError = err as Error;
        warn('Couchbase SDK failed to load, falling back to REST mode:', err);
        return null;
    }
}

export interface CouchbaseDocument<T> {
    content: T;
    cas?: string;
}

export interface ICouchbaseClient {
    get<T>(key: string): Promise<CouchbaseDocument<T> | null>;
    insert<T>(key: string, doc: T): Promise<boolean>;
    replace<T>(key: string, doc: T): Promise<boolean>;
    remove(key: string): Promise<boolean>;
    query<T>(statement: string, namedParams?: Record<string, unknown>): Promise<T[]>;
    ping(): Promise<boolean>;
    disconnect?(): Promise<void>;
}

// ============================================================================
// Self-Hosted Couchbase Client (N1QL Query API)
// ============================================================================
class SelfHostedCouchbaseClient implements ICouchbaseClient {
    private getAuthHeader(): string {
        const config = getConfig();
        const credentials = Buffer.from(`${config.couchbaseUsername}:${config.couchbasePassword}`).toString('base64');
        return `Basic ${credentials}`;
    }

    private getBaseUrl(): string {
        const config = getConfig();
        // Support full URL with protocol (http:// or https://)
        let url = config.couchbaseUrl || 'http://localhost';
        // Strip trailing slash if present
        url = url.replace(/\/$/, '');
        // Add http:// if no protocol specified (backwards compatibility)
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `http://${url}`;
        }
        return url;
    }

    private getQueryUrl(): string {
        const config = getConfig();
        return `${this.getBaseUrl()}:${config.couchbaseQueryPort}/query/service`;
    }

    private getManagementUrl(): string {
        const config = getConfig();
        return `${this.getBaseUrl()}:${config.couchbasePort}`;
    }

    private getFullPath(): string {
        const config = getConfig();
        return `\`${config.couchbaseBucket}\`.\`${config.couchbaseScope}\`.\`${config.couchbaseCollection}\``;
    }

    private getTimeoutMs(): number {
        const config = getConfig();
        return (config.couchbaseTimeout || 30) * 1000;
    }

    private createTimeoutSignal(): AbortSignal {
        return AbortSignal.timeout(this.getTimeoutMs());
    }

    async get<T>(key: string): Promise<CouchbaseDocument<T> | null> {
        const config = getConfig();
        
        try {
            debug('Couchbase GET (self-hosted):', key);
            
            const query = `SELECT META().id, META().cas, * FROM ${this.getFullPath()} WHERE META().id = $key`;
            
            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    statement: query,
                    $key: key
                }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase GET HTTP error:', { status: response.status, error: errorText });
                return null;
            }

            const result = await response.json() as {
                results?: Array<{ id: string; cas: string; [key: string]: unknown }>;
                status?: string;
                errors?: Array<{msg: string}>;
            };

            debug('Couchbase GET result:', { status: result.status, count: result.results?.length });

            if (result.results && result.results.length > 0) {
                const row = result.results[0];
                const content = (row[config.couchbaseCollection] || row[config.couchbaseBucket]) as T;
                debug('Couchbase GET content:', content ? 'found' : 'not found');
                return {
                    content,
                    cas: row.cas?.toString()
                };
            }

            debug('Couchbase GET: No results found');
            return null;
        } catch (err) {
            error('Couchbase GET failed:', err);
            return null;
        }
    }

    async insert<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase INSERT (self-hosted):', key);
            
            const query = `INSERT INTO ${this.getFullPath()} (KEY, VALUE) VALUES ($key, $doc)`;
            
            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    statement: query,
                    $key: key,
                    $doc: doc
                }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase INSERT HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase INSERT result:', JSON.stringify(result));
            
            if (result.status !== 'success') {
                error('Couchbase INSERT failed:', result.errors?.[0]?.msg || 'Unknown error');
                return false;
            }
            
            return true;
        } catch (err) {
            error('Couchbase INSERT exception:', err);
            return false;
        }
    }

    async replace<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase REPLACE (self-hosted):', key);
            
            const query = `UPSERT INTO ${this.getFullPath()} (KEY, VALUE) VALUES ($key, $doc)`;
            
            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    statement: query,
                    $key: key,
                    $doc: doc
                }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase REPLACE HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase REPLACE result:', JSON.stringify(result));
            
            if (result.status !== 'success') {
                error('Couchbase REPLACE failed:', result.errors?.[0]?.msg || 'Unknown error');
                return false;
            }
            
            return true;
        } catch (err) {
            error('Couchbase REPLACE exception:', err);
            return false;
        }
    }

    async remove(key: string): Promise<boolean> {
        try {
            debug('Couchbase DELETE (self-hosted):', key);
            
            const query = `DELETE FROM ${this.getFullPath()} WHERE META().id = $key`;
            
            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    statement: query,
                    $key: key
                }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase DELETE HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase DELETE result:', result.status);
            return result.status === 'success';
        } catch (err) {
            error('Couchbase DELETE exception:', err);
            return false;
        }
    }

    async query<T>(statement: string, namedParams?: Record<string, unknown>): Promise<T[]> {
        try {
            debug('Couchbase QUERY (self-hosted):', statement);
            
            const body: Record<string, unknown> = { statement };
            if (namedParams) {
                for (const [key, value] of Object.entries(namedParams)) {
                    body[`$${key}`] = value;
                }
            }

            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase QUERY HTTP error:', { status: response.status, error: errorText });
                return [];
            }

            const result = await response.json() as { results?: T[]; status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase QUERY result:', { status: result.status, count: result.results?.length });
            
            if (result.status !== 'success') {
                error('Couchbase QUERY failed:', result.errors?.[0]?.msg || 'Unknown error');
                return [];
            }
            
            return result.results || [];
        } catch (err) {
            error('Couchbase QUERY exception:', err);
            return [];
        }
    }

    async ping(): Promise<boolean> {
        try {
            debug('Couchbase PING (self-hosted)');
            
            const response = await fetch(`${this.getManagementUrl()}/pools`, {
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });
            
            const success = response.ok;
            debug('Couchbase PING result:', success);
            
            if (success) {
                info('Couchbase connection successful (self-hosted)');
            }
            
            return success;
        } catch (err) {
            error('Couchbase PING failed:', err);
            return false;
        }
    }
}

// ============================================================================
// Capella Data API Client
// ============================================================================
class CapellaDataApiClient implements ICouchbaseClient {
    private getAuthHeader(): string {
        const config = getConfig();
        const credentials = Buffer.from(`${config.couchbaseUsername}:${config.couchbasePassword}`).toString('base64');
        return `Basic ${credentials}`;
    }

    private getBaseUrl(): string {
        const config = getConfig();
        const url = config.capellaDataApiUrl;
        if (!url) {
            throw new Error('Capella Data API URL not configured. Set grok.capellaDataApiUrl in settings.');
        }
        return url.replace(/\/$/, '');
    }

    private getDocumentPath(key: string): string {
        const config = getConfig();
        return `/v1/buckets/${config.couchbaseBucket}/scopes/${config.couchbaseScope}/collections/${config.couchbaseCollection}/documents/${encodeURIComponent(key)}`;
    }

    private getQueryPath(): string {
        return '/v1/_p/query/query/service';
    }

    private getTimeoutMs(): number {
        const config = getConfig();
        return (config.couchbaseTimeout || 30) * 1000;
    }

    private createTimeoutSignal(): AbortSignal {
        return AbortSignal.timeout(this.getTimeoutMs());
    }

    async get<T>(key: string): Promise<CouchbaseDocument<T> | null> {
        try {
            debug('Couchbase GET (Capella):', key);
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getDocumentPath(key)}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Accept': 'application/json'
                },
                signal: this.createTimeoutSignal()
            });

            if (response.status === 404) {
                debug('Couchbase GET: Document not found');
                return null;
            }

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase GET HTTP error:', { status: response.status, error: errorText });
                return null;
            }

            const content = await response.json() as T;
            const etag = response.headers.get('ETag') || undefined;
            
            debug('Couchbase GET content:', content ? 'found' : 'not found');
            return { content, cas: etag };
        } catch (err) {
            error('Couchbase GET failed:', err);
            return null;
        }
    }

    async insert<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase INSERT (Capella):', key);
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getDocumentPath(key)}`;
            
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(doc),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase INSERT HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            debug('Couchbase INSERT success');
            return true;
        } catch (err) {
            error('Couchbase INSERT exception:', err);
            return false;
        }
    }

    async replace<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase REPLACE (Capella):', key);
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getDocumentPath(key)}`;
            
            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(doc),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase REPLACE HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            debug('Couchbase REPLACE success');
            return true;
        } catch (err) {
            error('Couchbase REPLACE exception:', err);
            return false;
        }
    }

    async remove(key: string): Promise<boolean> {
        try {
            debug('Couchbase DELETE (Capella):', key);
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getDocumentPath(key)}`;
            
            const response = await fetch(url, {
                method: 'DELETE',
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });

            if (!response.ok && response.status !== 404) {
                const errorText = await response.text();
                error('Couchbase DELETE HTTP error:', { status: response.status, error: errorText });
                return false;
            }

            debug('Couchbase DELETE success');
            return true;
        } catch (err) {
            error('Couchbase DELETE exception:', err);
            return false;
        }
    }

    async query<T>(statement: string, namedParams?: Record<string, unknown>): Promise<T[]> {
        try {
            debug('Couchbase QUERY (Capella):', statement);
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getQueryPath()}`;
            
            const body: Record<string, unknown> = { statement };
            if (namedParams) {
                for (const [key, value] of Object.entries(namedParams)) {
                    body[`$${key}`] = value;
                }
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase QUERY HTTP error:', { status: response.status, error: errorText });
                return [];
            }

            const result = await response.json() as { results?: T[]; status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase QUERY result:', { status: result.status, count: result.results?.length });
            
            if (result.status !== 'success') {
                error('Couchbase QUERY failed:', result.errors?.[0]?.msg || 'Unknown error');
                return [];
            }
            
            return result.results || [];
        } catch (err) {
            error('Couchbase QUERY exception:', err);
            return [];
        }
    }

    async ping(): Promise<boolean> {
        try {
            debug('Couchbase PING (Capella)');
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}/v1/scopes`;
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });
            
            const success = response.ok;
            debug('Couchbase PING result:', success);
            
            if (success) {
                info('Couchbase connection successful (Capella)');
            }
            
            return success;
        } catch (err) {
            error('Couchbase PING failed:', err);
            return false;
        }
    }
}

// ============================================================================
// SDK-Based Couchbase Client (Native Node.js SDK)
// ============================================================================
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CouchbaseCluster = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CouchbaseCollection = any;

class SdkCouchbaseClient implements ICouchbaseClient {
    private cluster: CouchbaseCluster | null = null;
    private connectPromise: Promise<CouchbaseCluster> | null = null;
    private sdk: typeof import('couchbase') | null = null;

    private getConnectionString(): string {
        const config = getConfig();
        let url = config.couchbaseUrl || 'localhost';
        
        // Remove http:// or https:// prefix if present (SDK uses couchbase:// or couchbases://)
        url = url.replace(/^https?:\/\//, '');
        // Remove trailing slash
        url = url.replace(/\/$/, '');
        
        // For Capella, use couchbases:// (TLS)
        if (config.couchbaseDeployment === 'capella' && config.capellaDataApiUrl) {
            // Extract hostname from Capella Data API URL
            const capellaHost = config.capellaDataApiUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').split('/')[0];
            // Convert data API URL to connection string (e.g., data.cloud.couchbase.com -> cb.xxx.cloud.couchbase.com)
            return `couchbases://${capellaHost}`;
        }
        
        return `couchbase://${url}`;
    }

    private async ensureSDK(): Promise<typeof import('couchbase')> {
        if (this.sdk) {
            return this.sdk;
        }
        
        this.sdk = await loadCouchbaseSDK();
        if (!this.sdk) {
            throw new Error('Couchbase SDK failed to load: ' + (couchbaseLoadError?.message || 'unknown error'));
        }
        return this.sdk;
    }

    private async ensureConnected(): Promise<CouchbaseCluster> {
        if (this.cluster) {
            return this.cluster;
        }

        // Prevent multiple simultaneous connection attempts
        if (this.connectPromise) {
            return this.connectPromise;
        }

        this.connectPromise = this.connect();
        try {
            this.cluster = await this.connectPromise;
            return this.cluster;
        } finally {
            this.connectPromise = null;
        }
    }

    private async connect(): Promise<CouchbaseCluster> {
        const sdk = await this.ensureSDK();
        const config = getConfig();
        const connectionString = this.getConnectionString();
        const timeoutMs = (config.couchbaseTimeout || 30) * 1000;

        debug('Couchbase SDK connecting to:', connectionString);

        try {
            const cluster = await sdk.connect(connectionString, {
                username: config.couchbaseUsername,
                password: config.couchbasePassword,
                configProfile: 'wanDevelopment', // Optimized for cloud/WAN
                timeouts: {
                    kvTimeout: timeoutMs,
                    queryTimeout: timeoutMs,
                    connectTimeout: timeoutMs,
                    managementTimeout: timeoutMs
                }
            });

            info('Couchbase SDK connected successfully');
            return cluster;
        } catch (err) {
            error('Couchbase SDK connection failed:', err);
            throw err;
        }
    }

    private async getCollection(): Promise<CouchbaseCollection> {
        const cluster = await this.ensureConnected();
        const config = getConfig();
        return cluster
            .bucket(config.couchbaseBucket)
            .scope(config.couchbaseScope)
            .collection(config.couchbaseCollection);
    }

    async get<T>(key: string): Promise<CouchbaseDocument<T> | null> {
        try {
            debug('Couchbase SDK GET:', key);
            const sdk = await this.ensureSDK();
            const collection = await this.getCollection();
            const result = await collection.get(key);
            
            debug('Couchbase SDK GET success:', key);
            return {
                content: result.content as T,
                cas: result.cas.toString()
            };
        } catch (err) {
            const sdk = this.sdk;
            if (sdk && err instanceof sdk.DocumentNotFoundError) {
                debug('Couchbase SDK GET: Document not found:', key);
                return null;
            }
            // Also check by error name for compatibility
            if ((err as Error)?.name === 'DocumentNotFoundError') {
                debug('Couchbase SDK GET: Document not found:', key);
                return null;
            }
            error('Couchbase SDK GET failed:', err);
            return null;
        }
    }

    async insert<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase SDK INSERT:', key);
            await this.ensureSDK();
            const collection = await this.getCollection();
            await collection.insert(key, doc);
            debug('Couchbase SDK INSERT success:', key);
            return true;
        } catch (err) {
            const sdk = this.sdk;
            if (sdk && err instanceof sdk.DocumentExistsError) {
                error('Couchbase SDK INSERT: Document already exists:', key);
            } else if ((err as Error)?.name === 'DocumentExistsError') {
                error('Couchbase SDK INSERT: Document already exists:', key);
            } else {
                error('Couchbase SDK INSERT failed:', err);
            }
            return false;
        }
    }

    async replace<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase SDK UPSERT:', key);
            await this.ensureSDK();
            const collection = await this.getCollection();
            // Use upsert for replace to match REST behavior (creates if not exists)
            await collection.upsert(key, doc);
            debug('Couchbase SDK UPSERT success:', key);
            return true;
        } catch (err) {
            error('Couchbase SDK UPSERT failed:', err);
            return false;
        }
    }

    async remove(key: string): Promise<boolean> {
        try {
            debug('Couchbase SDK REMOVE:', key);
            await this.ensureSDK();
            const collection = await this.getCollection();
            await collection.remove(key);
            debug('Couchbase SDK REMOVE success:', key);
            return true;
        } catch (err) {
            const sdk = this.sdk;
            if (sdk && err instanceof sdk.DocumentNotFoundError) {
                debug('Couchbase SDK REMOVE: Document not found:', key);
                return true; // Match REST behavior - removal of non-existent doc is OK
            }
            if ((err as Error)?.name === 'DocumentNotFoundError') {
                debug('Couchbase SDK REMOVE: Document not found:', key);
                return true;
            }
            error('Couchbase SDK REMOVE failed:', err);
            return false;
        }
    }

    async query<T>(statement: string, namedParams?: Record<string, unknown>): Promise<T[]> {
        try {
            debug('Couchbase SDK QUERY:', statement);
            await this.ensureSDK();
            const cluster = await this.ensureConnected();
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const options: any = {};
            if (namedParams) {
                options.parameters = namedParams;
            }

            const result = await cluster.query(statement, options);
            debug('Couchbase SDK QUERY success, rows:', result.rows.length);
            return result.rows as T[];
        } catch (err) {
            error('Couchbase SDK QUERY failed:', err);
            return [];
        }
    }

    async ping(): Promise<boolean> {
        try {
            debug('Couchbase SDK PING');
            await this.ensureSDK();
            
            // Use a simple KV exists operation to verify connectivity
            // This is more reliable than diagnostics() which may have type issues
            const collection = await this.getCollection();
            await collection.exists('__ping_test__');
            
            info('Couchbase SDK connection healthy');
            return true;
        } catch (err) {
            error('Couchbase SDK PING failed:', err);
            return false;
        }
    }

    async disconnect(): Promise<void> {
        if (this.cluster) {
            debug('Couchbase SDK disconnecting');
            await this.cluster.close();
            this.cluster = null;
            info('Couchbase SDK disconnected');
        }
    }
}

// ============================================================================
// Factory and Singleton
// ============================================================================
let clientInstance: ICouchbaseClient | null = null;
let currentDeploymentMode: string | null = null;
let currentConnectionMode: string | null = null;

export function getCouchbaseClient(): ICouchbaseClient {
    const config = getConfig();
    const deployment = config.couchbaseDeployment;
    let connectionMode = config.couchbaseConnectionMode || 'rest'; // Default to REST for compatibility
    
    // If SDK load already failed, force REST mode
    if (connectionMode === 'sdk' && couchbaseLoadAttempted && !couchbase) {
        warn('Couchbase SDK not available, using REST mode');
        connectionMode = 'rest';
    }
    
    // Recreate client if deployment mode or connection mode changed
    if (clientInstance && (currentDeploymentMode !== deployment || currentConnectionMode !== connectionMode)) {
        info('Couchbase mode changed, recreating client', { 
            fromDeployment: currentDeploymentMode, 
            toDeployment: deployment,
            fromConnection: currentConnectionMode,
            toConnection: connectionMode 
        });
        // Disconnect SDK client if switching away from it
        if (clientInstance.disconnect) {
            clientInstance.disconnect().catch(err => error('Error disconnecting:', err));
        }
        clientInstance = null;
    }
    
    if (!clientInstance) {
        // SDK mode - uses native Couchbase SDK for all operations
        if (connectionMode === 'sdk') {
            info('Creating Couchbase SDK client');
            clientInstance = new SdkCouchbaseClient();
        }
        // REST mode - legacy HTTP/REST-based clients
        else if (deployment === 'capella') {
            info('Creating Capella Data API client (REST)');
            clientInstance = new CapellaDataApiClient();
        } else {
            info('Creating self-hosted Couchbase client (REST)');
            clientInstance = new SelfHostedCouchbaseClient();
        }
        currentDeploymentMode = deployment;
        currentConnectionMode = connectionMode;
    }
    
    return clientInstance;
}

export async function shutdownCouchbase(): Promise<void> {
    info('Couchbase client shutdown');
    if (clientInstance?.disconnect) {
        await clientInstance.disconnect();
    }
    clientInstance = null;
    currentDeploymentMode = null;
    currentConnectionMode = null;
}

// Export concrete classes for type checking if needed
export { SelfHostedCouchbaseClient, CapellaDataApiClient, SdkCouchbaseClient };
