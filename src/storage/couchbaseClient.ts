import { getConfig, debug, error, info } from '../utils/logger';

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
// Factory and Singleton
// ============================================================================
let clientInstance: ICouchbaseClient | null = null;
let currentDeploymentMode: string | null = null;

export function getCouchbaseClient(): ICouchbaseClient {
    const config = getConfig();
    const deployment = config.couchbaseDeployment;
    
    // Recreate client if deployment mode changed
    if (clientInstance && currentDeploymentMode !== deployment) {
        info('Couchbase deployment mode changed, recreating client', { from: currentDeploymentMode, to: deployment });
        clientInstance = null;
    }
    
    if (!clientInstance) {
        if (deployment === 'capella') {
            info('Creating Capella Data API client');
            clientInstance = new CapellaDataApiClient();
        } else {
            info('Creating self-hosted Couchbase client');
            clientInstance = new SelfHostedCouchbaseClient();
        }
        currentDeploymentMode = deployment;
    }
    
    return clientInstance;
}

export async function shutdownCouchbase(): Promise<void> {
    info('Couchbase client shutdown');
    clientInstance = null;
    currentDeploymentMode = null;
}

// Export concrete classes for type checking if needed
export { SelfHostedCouchbaseClient, CapellaDataApiClient };
