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
        error('Couchbase SDK failed to load:', {
            message: couchbaseLoadError.message,
            name: couchbaseLoadError.name,
            stack: couchbaseLoadError.stack?.split('\n').slice(0, 5).join('\n')
        });
        warn('Falling back to REST mode. Common causes: native module mismatch, VS Code Node version incompatibility, or missing prebuilt binaries.');
        return null;
    }
}

export interface CouchbaseDocument<T> {
    content: T;
    cas?: string;
}

/**
 * Result from a CAS-aware replace operation
 */
export interface ReplaceResult {
    success: boolean;
    cas?: string;
    error?: CouchbaseErrorType;
}

/**
 * Subdocument operation types for mutateIn
 */
export type SubdocOp = 
    | { type: 'upsert'; path: string; value: unknown }
    | { type: 'insert'; path: string; value: unknown }
    | { type: 'arrayAppend'; path: string; value: unknown }
    | { type: 'arrayPrepend'; path: string; value: unknown }
    | { type: 'remove'; path: string };

/**
 * Couchbase error types for proper exception handling
 * Mirrors Python SDK exception types from 05_cb_exception_handling.py
 */
export type CouchbaseErrorType = 
    | 'DocumentNotFound'
    | 'DocumentExists'
    | 'CasMismatch'
    | 'Timeout'
    | 'ServiceUnavailable'
    | 'ParsingFailed'
    | 'PathNotFound'
    | 'PathExists'
    | 'Unknown';

/**
 * Classify an error into a CouchbaseErrorType for consistent handling
 */
export function classifyCouchbaseError(err: unknown): CouchbaseErrorType {
    if (!err) return 'Unknown';
    
    const errName = (err as Error)?.name || '';
    const errMessage = (err as Error)?.message || '';
    
    if (errName.includes('DocumentNotFound') || errMessage.includes('document not found')) {
        return 'DocumentNotFound';
    }
    if (errName.includes('DocumentExists') || errMessage.includes('already exists')) {
        return 'DocumentExists';
    }
    if (errName.includes('CasMismatch') || errMessage.includes('cas mismatch')) {
        return 'CasMismatch';
    }
    if (errName.includes('Timeout') || errMessage.includes('timeout')) {
        return 'Timeout';
    }
    if (errName.includes('ServiceUnavailable') || errMessage.includes('service unavailable')) {
        return 'ServiceUnavailable';
    }
    if (errName.includes('ParsingFailed') || errMessage.includes('parsing failed')) {
        return 'ParsingFailed';
    }
    if (errName.includes('PathNotFound') || errMessage.includes('path not found')) {
        return 'PathNotFound';
    }
    if (errName.includes('PathExists') || errMessage.includes('path exists')) {
        return 'PathExists';
    }
    
    return 'Unknown';
}

/**
 * Result from an insert operation
 */
export interface InsertResult {
    success: boolean;
    cas?: string;
    error?: CouchbaseErrorType;
}

export interface ICouchbaseClient {
    get<T>(key: string): Promise<CouchbaseDocument<T> | null>;
    /**
     * Insert a new document (fails if document already exists).
     * Following 05_cb_exception_handling.py pattern - returns specific error type.
     */
    insert<T>(key: string, doc: T): Promise<InsertResult>;
    replace<T>(key: string, doc: T): Promise<boolean>;
    /**
     * Replace with CAS for optimistic locking (01b_cb_get_update_w_cas.py pattern)
     * Returns detailed result including new CAS or error type
     */
    replaceWithCas<T>(key: string, doc: T, cas: string): Promise<ReplaceResult>;
    /**
     * Subdocument mutation for atomic array appends (04_cb_sub_doc_ops.py pattern)
     * Max 16 operations per call
     */
    mutateIn(key: string, ops: SubdocOp[], cas?: string): Promise<ReplaceResult>;
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
        const credentials = Buffer.from(`${config.selfHostedUsername}:${config.selfHostedPassword}`).toString('base64');
        return `Basic ${credentials}`;
    }

    private getBaseUrl(): string {
        const config = getConfig();
        // Support full URL with protocol (http:// or https://)
        let url = config.selfHostedUrl || 'http://localhost';
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
        return `${this.getBaseUrl()}:${config.selfHostedQueryPort}/query/service`;
    }

    private getManagementUrl(): string {
        const config = getConfig();
        return `${this.getBaseUrl()}:${config.selfHostedPort}`;
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

    async insert<T>(key: string, doc: T): Promise<InsertResult> {
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
                return { success: false, error: 'Unknown' };
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string; code?: number}> };
            debug('Couchbase INSERT result:', JSON.stringify(result));
            
            if (result.status !== 'success') {
                const errMsg = result.errors?.[0]?.msg || '';
                // N1QL error 12009 = "Duplicate Key" (document already exists)
                if (errMsg.includes('Duplicate') || errMsg.includes('already exists') || result.errors?.[0]?.code === 12009) {
                    warn('Couchbase INSERT: Document already exists:', key);
                    return { success: false, error: 'DocumentExists' };
                }
                error('Couchbase INSERT failed:', errMsg);
                return { success: false, error: 'Unknown' };
            }
            
            return { success: true };
        } catch (err) {
            const errorType = classifyCouchbaseError(err);
            error('Couchbase INSERT exception:', { error: err, errorType });
            return { success: false, error: errorType };
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

    /**
     * REST API does not support CAS-based operations directly via N1QL.
     * This implementation falls back to regular upsert with a warning.
     * For true CAS support, use SDK connection mode.
     */
    async replaceWithCas<T>(key: string, doc: T, cas: string): Promise<ReplaceResult> {
        warn('CAS-based replace not fully supported in REST mode, falling back to upsert', { key, cas });
        const success = await this.replace(key, doc);
        return { success, error: success ? undefined : 'Unknown' };
    }

    /**
     * REST API subdocument operations via N1QL UPDATE with ARRAY_APPEND.
     * Note: N1QL doesn't support true subdoc atomicity - for that, use SDK mode.
     */
    async mutateIn(key: string, ops: SubdocOp[], cas?: string): Promise<ReplaceResult> {
        try {
            debug('Couchbase MUTATE_IN (self-hosted):', { key, opCount: ops.length });
            
            if (ops.length > 16) {
                error('Couchbase MUTATE_IN: Max 16 operations per call');
                return { success: false, error: 'Unknown' };
            }

            // Build SET clauses for each operation
            const setClauses: string[] = [];
            for (const op of ops) {
                switch (op.type) {
                    case 'upsert':
                        setClauses.push(`\`${op.path}\` = $${op.path.replace(/[.\[\]]/g, '_')}`);
                        break;
                    case 'arrayAppend':
                        setClauses.push(`\`${op.path}\` = ARRAY_APPEND(IFMISSINGORNULL(\`${op.path}\`, []), $${op.path.replace(/[.\[\]]/g, '_')})`);
                        break;
                    case 'arrayPrepend':
                        setClauses.push(`\`${op.path}\` = ARRAY_PREPEND($${op.path.replace(/[.\[\]]/g, '_')}, IFMISSINGORNULL(\`${op.path}\`, []))`);
                        break;
                    case 'remove':
                        // N1QL doesn't have direct remove - would need OBJECT_REMOVE
                        warn('REMOVE operation not fully supported in REST mode');
                        break;
                    case 'insert':
                        // Insert fails if exists - N1QL doesn't support this directly
                        setClauses.push(`\`${op.path}\` = $${op.path.replace(/[.\[\]]/g, '_')}`);
                        break;
                }
            }

            if (setClauses.length === 0) {
                return { success: true };
            }

            const query = `UPDATE ${this.getFullPath()} SET ${setClauses.join(', ')} WHERE META().id = $key`;
            
            // Build params
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const params: Record<string, any> = { $key: key };
            for (const op of ops) {
                if (op.type !== 'remove') {
                    params[`$${op.path.replace(/[.\[\]]/g, '_')}`] = op.value;
                }
            }

            const response = await fetch(this.getQueryUrl(), {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ statement: query, ...params }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase MUTATE_IN HTTP error:', { status: response.status, error: errorText });
                return { success: false, error: 'Unknown' };
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase MUTATE_IN result:', JSON.stringify(result));
            
            if (result.status !== 'success') {
                error('Couchbase MUTATE_IN failed:', result.errors?.[0]?.msg || 'Unknown error');
                return { success: false, error: 'Unknown' };
            }
            
            return { success: true };
        } catch (err) {
            const errorType = classifyCouchbaseError(err);
            error('Couchbase MUTATE_IN exception:', { error: err, errorType });
            return { success: false, error: errorType };
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
            const url = `${this.getManagementUrl()}/pools`;
            debug('Couchbase PING URL:', url);
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });
            
            const success = response.ok;
            debug('Couchbase PING result:', { success, status: response.status });
            
            if (success) {
                info('Couchbase connection successful (self-hosted)');
            } else {
                const errorText = await response.text().catch(() => '');
                error('Couchbase PING failed:', { status: response.status, statusText: response.statusText, error: errorText });
            }
            
            return success;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            error('Couchbase PING failed:', errMsg);
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
        debug('Capella Data API auth using username:', config.capellaDataApiUsername || '(empty)');
        if (!config.capellaDataApiUsername || !config.capellaDataApiPassword) {
            warn('Capella Data API credentials not configured');
        }
        const credentials = Buffer.from(`${config.capellaDataApiUsername}:${config.capellaDataApiPassword}`).toString('base64');
        return `Basic ${credentials}`;
    }

    private getBaseUrl(): string {
        const config = getConfig();
        let url = config.capellaDataApiUrl;
        
        if (!url) {
            throw new Error('Capella Data API URL not configured. Set grok.capellaDataApiUrl in settings.');
        }
        
        // Strip any protocols and normalize
        url = url.replace(/^couchbases?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        
        // Always use https
        url = `https://${url}`;
        
        debug('Using Capella Data API URL:', url);
        return url;
    }

    private getDocumentPath(key: string): string {
        const config = getConfig();
        return `/v1/buckets/${config.couchbaseBucket}/scopes/${config.couchbaseScope}/collections/${config.couchbaseCollection}/documents/${encodeURIComponent(key)}`;
    }

    private getQueryPath(): string {
        // Data API query passthrough endpoint (no /v1 prefix)
        return '/_p/query/query/service';
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

    async insert<T>(key: string, doc: T): Promise<InsertResult> {
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

            // Capella Data API returns 409 Conflict if document exists
            if (response.status === 409) {
                warn('Couchbase INSERT: Document already exists (Capella):', key);
                return { success: false, error: 'DocumentExists' };
            }

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase INSERT HTTP error:', { status: response.status, error: errorText });
                return { success: false, error: 'Unknown' };
            }

            const cas = response.headers.get('ETag') || undefined;
            debug('Couchbase INSERT success (Capella):', { key, cas });
            return { success: true, cas };
        } catch (err) {
            const errorType = classifyCouchbaseError(err);
            error('Couchbase INSERT exception:', { error: err, errorType });
            return { success: false, error: errorType };
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

    /**
     * Capella Data API supports CAS via ETag/If-Match header.
     * Follows 01b_cb_get_update_w_cas.py pattern.
     */
    async replaceWithCas<T>(key: string, doc: T, cas: string): Promise<ReplaceResult> {
        try {
            debug('Couchbase REPLACE with CAS (Capella):', { key, cas });
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getDocumentPath(key)}`;
            
            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json',
                    'If-Match': cas
                },
                body: JSON.stringify(doc),
                signal: this.createTimeoutSignal()
            });

            if (response.status === 412) {
                warn('Couchbase REPLACE CAS mismatch (Capella):', { key, cas });
                return { success: false, error: 'CasMismatch' };
            }

            if (response.status === 404) {
                warn('Couchbase REPLACE document not found (Capella):', key);
                return { success: false, error: 'DocumentNotFound' };
            }

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase REPLACE with CAS HTTP error:', { status: response.status, error: errorText });
                return { success: false, error: 'Unknown' };
            }

            const newCas = response.headers.get('ETag') || undefined;
            debug('Couchbase REPLACE with CAS success:', { key, newCas });
            return { success: true, cas: newCas };
        } catch (err) {
            const errorType = classifyCouchbaseError(err);
            error('Couchbase REPLACE with CAS exception:', { error: err, errorType });
            return { success: false, error: errorType };
        }
    }

    /**
     * Capella Data API doesn't support subdoc directly - falls back to N1QL.
     * For true subdoc atomicity, use SDK mode.
     */
    async mutateIn(key: string, ops: SubdocOp[], cas?: string): Promise<ReplaceResult> {
        try {
            debug('Couchbase MUTATE_IN (Capella):', { key, opCount: ops.length });
            
            if (ops.length > 16) {
                error('Couchbase MUTATE_IN: Max 16 operations per call');
                return { success: false, error: 'Unknown' };
            }

            // Use N1QL UPDATE for subdoc-like operations
            const config = getConfig();
            const fullPath = `\`${config.couchbaseBucket}\`.\`${config.couchbaseScope}\`.\`${config.couchbaseCollection}\``;

            const setClauses: string[] = [];
            for (const op of ops) {
                switch (op.type) {
                    case 'upsert':
                        setClauses.push(`\`${op.path}\` = $${op.path.replace(/[.\[\]]/g, '_')}`);
                        break;
                    case 'arrayAppend':
                        setClauses.push(`\`${op.path}\` = ARRAY_APPEND(IFMISSINGORNULL(\`${op.path}\`, []), $${op.path.replace(/[.\[\]]/g, '_')})`);
                        break;
                    case 'arrayPrepend':
                        setClauses.push(`\`${op.path}\` = ARRAY_PREPEND($${op.path.replace(/[.\[\]]/g, '_')}, IFMISSINGORNULL(\`${op.path}\`, []))`);
                        break;
                    case 'remove':
                        warn('REMOVE operation not fully supported in Capella REST mode');
                        break;
                    case 'insert':
                        setClauses.push(`\`${op.path}\` = $${op.path.replace(/[.\[\]]/g, '_')}`);
                        break;
                }
            }

            if (setClauses.length === 0) {
                return { success: true };
            }

            const query = `UPDATE ${fullPath} USE KEYS $key SET ${setClauses.join(', ')}`;
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const params: Record<string, any> = { $key: key };
            for (const op of ops) {
                if (op.type !== 'remove') {
                    params[`$${op.path.replace(/[.\[\]]/g, '_')}`] = op.value;
                }
            }

            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}${this.getQueryPath()}`;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeader(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ statement: query, ...params }),
                signal: this.createTimeoutSignal()
            });

            if (!response.ok) {
                const errorText = await response.text();
                error('Couchbase MUTATE_IN HTTP error:', { status: response.status, error: errorText });
                return { success: false, error: 'Unknown' };
            }

            const result = await response.json() as { status?: string; errors?: Array<{msg: string}> };
            debug('Couchbase MUTATE_IN result:', JSON.stringify(result));
            
            if (result.status !== 'success') {
                error('Couchbase MUTATE_IN failed:', result.errors?.[0]?.msg || 'Unknown error');
                return { success: false, error: 'Unknown' };
            }
            
            return { success: true };
        } catch (err) {
            const errorType = classifyCouchbaseError(err);
            error('Couchbase MUTATE_IN exception:', { error: err, errorType });
            return { success: false, error: errorType };
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
            debug('Couchbase PING (Capella Data API)');
            
            const baseUrl = this.getBaseUrl();
            const url = `${baseUrl}/v1/callerIdentity`;
            debug('Couchbase PING URL:', url);
            
            const response = await fetch(url, {
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });
            
            const success = response.ok;
            debug('Couchbase PING result:', { success, status: response.status });
            
            if (success) {
                info('Couchbase connection successful (Capella Data API)');
            } else {
                const errorText = await response.text().catch(() => '');
                error('Couchbase PING failed:', { status: response.status, statusText: response.statusText, error: errorText });
            }
            
            return success;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            error('Couchbase PING failed:', errMsg);
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
        
        // Use deployment-specific URL
        let url: string;
        if (config.couchbaseDeployment === 'capella-sdk') {
            url = config.capellaSdkUrl || '';
            if (!url) {
                throw new Error('Capella SDK URL not configured. Set grok.capellaSdkUrl in settings.');
            }
        } else {
            url = config.selfHostedUrl || 'localhost';
        }
        
        // Remove any protocol prefix
        url = url.replace(/^https?:\/\//, '').replace(/^couchbases?:\/\//, '').replace(/\/$/, '');
        
        // For Capella SDK, use couchbases:// (TLS)
        if (config.couchbaseDeployment === 'capella-sdk') {
            return `couchbases://${url}`;
        }
        
        return `couchbase://${url}`;
    }
    
    private getCredentials(): { username: string; password: string } {
        const config = getConfig();
        if (config.couchbaseDeployment === 'capella-sdk') {
            return {
                username: config.capellaSdkUsername,
                password: config.capellaSdkPassword
            };
        }
        return {
            username: config.selfHostedUsername,
            password: config.selfHostedPassword
        };
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
        const credentials = this.getCredentials();
        const timeoutMs = (config.couchbaseTimeout || 30) * 1000;

        debug('Couchbase SDK connecting to:', connectionString);

        try {
            const cluster = await sdk.connect(connectionString, {
                username: credentials.username,
                password: credentials.password,
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

    async insert<T>(key: string, doc: T): Promise<InsertResult> {
        try {
            debug('Couchbase SDK INSERT:', key);
            await this.ensureSDK();
            const collection = await this.getCollection();
            const result = await collection.insert(key, doc);
            debug('Couchbase SDK INSERT success:', { key, cas: result.cas?.toString() });
            return { success: true, cas: result.cas?.toString() };
        } catch (err) {
            const sdk = this.sdk;
            const errName = (err as Error)?.name || '';
            
            // Following 05_cb_exception_handling.py - specific DocumentExistsException handling
            if (sdk && err instanceof sdk.DocumentExistsError || errName === 'DocumentExistsError') {
                warn('Couchbase SDK INSERT: Document already exists:', key);
                return { success: false, error: 'DocumentExists' };
            }
            
            const errorType = classifyCouchbaseError(err);
            error('Couchbase SDK INSERT failed:', { error: err, errorType });
            return { success: false, error: errorType };
        }
    }

    async replace<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase SDK UPSERT:', key);
            await this.ensureSDK();
            const collection = await this.getCollection();
            await collection.upsert(key, doc);
            debug('Couchbase SDK UPSERT success:', key);
            return true;
        } catch (err) {
            error('Couchbase SDK UPSERT failed:', err);
            return false;
        }
    }

    /**
     * CAS-based replace following 01b_cb_get_update_w_cas.py pattern.
     * Uses SDK's native replace with CAS for optimistic locking.
     * On CasMismatchError, caller should retry with fresh document.
     */
    async replaceWithCas<T>(key: string, doc: T, cas: string): Promise<ReplaceResult> {
        try {
            debug('Couchbase SDK REPLACE with CAS:', { key, cas });
            const sdk = await this.ensureSDK();
            const collection = await this.getCollection();
            
            const result = await collection.replace(key, doc, { cas: BigInt(cas) });
            
            debug('Couchbase SDK REPLACE with CAS success:', { key, newCas: result.cas?.toString() });
            return { 
                success: true, 
                cas: result.cas?.toString() 
            };
        } catch (err) {
            const sdk = this.sdk;
            const errName = (err as Error)?.name || '';
            
            if (sdk && err instanceof sdk.CasMismatchError || errName === 'CasMismatchError') {
                warn('Couchbase SDK CAS mismatch - document modified by another writer:', { key, cas });
                return { success: false, error: 'CasMismatch' };
            }
            if (sdk && err instanceof sdk.DocumentNotFoundError || errName === 'DocumentNotFoundError') {
                warn('Couchbase SDK REPLACE: Document not found:', key);
                return { success: false, error: 'DocumentNotFound' };
            }
            
            const errorType = classifyCouchbaseError(err);
            error('Couchbase SDK REPLACE with CAS failed:', { error: err, errorType });
            return { success: false, error: errorType };
        }
    }

    /**
     * Subdocument mutation following 04_cb_sub_doc_ops.py pattern.
     * Uses SDK's mutateIn for atomic array operations.
     * Max 16 operations per call.
     */
    async mutateIn(key: string, ops: SubdocOp[], cas?: string): Promise<ReplaceResult> {
        try {
            debug('Couchbase SDK MUTATE_IN:', { key, opCount: ops.length, hasCas: !!cas });
            const sdk = await this.ensureSDK();
            const collection = await this.getCollection();
            
            if (ops.length > 16) {
                error('Couchbase SDK MUTATE_IN: Max 16 operations per call');
                return { success: false, error: 'Unknown' };
            }

            // Build subdoc specs
            const specs: unknown[] = [];
            for (const op of ops) {
                switch (op.type) {
                    case 'upsert':
                        specs.push(sdk.MutateInSpec.upsert(op.path, op.value));
                        break;
                    case 'insert':
                        specs.push(sdk.MutateInSpec.insert(op.path, op.value));
                        break;
                    case 'arrayAppend':
                        specs.push(sdk.MutateInSpec.arrayAppend(op.path, op.value));
                        break;
                    case 'arrayPrepend':
                        specs.push(sdk.MutateInSpec.arrayPrepend(op.path, op.value));
                        break;
                    case 'remove':
                        specs.push(sdk.MutateInSpec.remove(op.path));
                        break;
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const options: any = {};
            if (cas) {
                options.cas = BigInt(cas);
            }

            const result = await collection.mutateIn(key, specs, options);
            
            debug('Couchbase SDK MUTATE_IN success:', { key, newCas: result.cas?.toString() });
            return { 
                success: true, 
                cas: result.cas?.toString() 
            };
        } catch (err) {
            const sdk = this.sdk;
            const errName = (err as Error)?.name || '';
            
            if (sdk && err instanceof sdk.CasMismatchError || errName === 'CasMismatchError') {
                warn('Couchbase SDK MUTATE_IN CAS mismatch:', { key, cas });
                return { success: false, error: 'CasMismatch' };
            }
            if (sdk && err instanceof sdk.DocumentNotFoundError || errName === 'DocumentNotFoundError') {
                warn('Couchbase SDK MUTATE_IN: Document not found:', key);
                return { success: false, error: 'DocumentNotFound' };
            }
            if (errName === 'PathNotFoundError' || errName.includes('PathNotFound')) {
                warn('Couchbase SDK MUTATE_IN: Path not found:', key);
                return { success: false, error: 'PathNotFound' };
            }
            
            const errorType = classifyCouchbaseError(err);
            error('Couchbase SDK MUTATE_IN failed:', { error: err, errorType });
            return { success: false, error: errorType };
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

/**
 * Returns the current Couchbase client instance.
 * The client maintains a persistent connection (especially for SDK mode).
 * Only recreates the client if deployment mode changes.
 */
export function getCouchbaseClient(): ICouchbaseClient {
    // Return cached client if available (fast path for normal operations)
    if (clientInstance) {
        return clientInstance;
    }
    
    // Only read config when creating a new client
    return createCouchbaseClient();
}

/**
 * Forces a refresh of the client based on current config.
 * Call this after saving settings to pick up new deployment/credentials.
 */
export function refreshCouchbaseClient(): ICouchbaseClient {
    const config = getConfig();
    let deployment = config.couchbaseDeployment;
    
    // BYPASS: Always use REST mode for compatibility
    const connectionMode = 'rest';
    
    // Handle legacy 'capella-sdk' setting - redirect to capella-data-api
    if (deployment === 'capella-sdk') {
        deployment = 'capella-data-api';
    }
    
    // Check if mode actually changed
    if (clientInstance && currentDeploymentMode === deployment && currentConnectionMode === connectionMode) {
        debug('Couchbase client refresh: no mode change, keeping existing client');
        return clientInstance;
    }
    
    // Mode changed - disconnect old client and create new one
    if (clientInstance) {
        info('Couchbase mode changed, recreating client', { 
            fromDeployment: currentDeploymentMode, 
            toDeployment: deployment,
            fromConnection: currentConnectionMode,
            toConnection: connectionMode 
        });
        if (clientInstance.disconnect) {
            clientInstance.disconnect().catch(err => error('Error disconnecting:', err));
        }
        clientInstance = null;
    }
    
    return createCouchbaseClient();
}

/**
 * Internal: Creates the appropriate client based on current config.
 * 
 * NOTE: SDK mode is bypassed for compatibility. Native Couchbase SDK requires
 * platform-specific binaries that don't work reliably in VS Code's Electron.
 * REST API mode works everywhere without native module issues.
 */
function createCouchbaseClient(): ICouchbaseClient {
    const config = getConfig();
    let deployment = config.couchbaseDeployment;
    
    // BYPASS: Always use REST mode for compatibility
    // SDK mode code is preserved but not used - native modules don't load reliably in Electron
    const connectionMode = 'rest';
    
    // Handle legacy 'capella-sdk' setting - redirect to capella-data-api
    if (deployment === 'capella-sdk') {
        info('Capella SDK mode redirected to Capella Data API (SDK disabled for compatibility)');
        deployment = 'capella-data-api';
    }
    
    // Create the appropriate REST client
    if (deployment === 'capella-data-api') {
        info('Creating Capella Data API client (REST)');
        clientInstance = new CapellaDataApiClient();
    } else {
        info('Creating self-hosted Couchbase client (REST)');
        clientInstance = new SelfHostedCouchbaseClient();
    }
    
    currentDeploymentMode = deployment;
    currentConnectionMode = connectionMode;
    
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

/**
 * Returns current connection mode info for UI display.
 * Shows what deployment type and protocol is currently in use.
 * Note: SDK mode is disabled - always returns REST mode.
 */
export function getConnectionModeInfo(): { deployment: string; mode: string; label: string } {
    const deployment = currentDeploymentMode || 'unknown';
    const mode = 'rest'; // Always REST - SDK mode is bypassed
    
    // Create a short, readable label for the UI
    let label = '';
    switch (deployment) {
        case 'self-hosted':
            label = 'Self-Hosted REST API';
            break;
        case 'capella-data-api':
            label = 'Capella Data API';
            break;
        default:
            label = `${deployment} (${mode})`;
    }
    
    return { deployment, mode, label };
}

// Export concrete classes for type checking if needed
export { SelfHostedCouchbaseClient, CapellaDataApiClient, SdkCouchbaseClient };
