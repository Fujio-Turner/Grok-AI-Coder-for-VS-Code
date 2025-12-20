import { getConfig, debug, error, info } from '../utils/logger';

export interface CouchbaseDocument<T> {
    content: T;
    cas?: string;
}

export class CouchbaseRestClient {
    private getAuthHeader(): string {
        const config = getConfig();
        const credentials = Buffer.from(`${config.couchbaseUsername}:${config.couchbasePassword}`).toString('base64');
        return `Basic ${credentials}`;
    }

    private getQueryUrl(): string {
        const config = getConfig();
        return `http://${config.couchbaseUrl}:${config.couchbaseQueryPort}/query/service`;
    }

    private getManagementUrl(): string {
        const config = getConfig();
        return `http://${config.couchbaseUrl}:${config.couchbasePort}`;
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

    // Get a document by key using the REST API
    async get<T>(key: string): Promise<CouchbaseDocument<T> | null> {
        const config = getConfig();
        
        try {
            debug('Couchbase GET:', key);
            
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
                // The document content is in the collection name key (e.g., "_default")
                // Try collection name first, then bucket name as fallback
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

    // Insert a new document
    async insert<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase INSERT:', key);
            
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

    // Replace/update an existing document (using UPSERT)
    async replace<T>(key: string, doc: T): Promise<boolean> {
        try {
            debug('Couchbase REPLACE:', key);
            
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

    // Delete a document
    async remove(key: string): Promise<boolean> {
        try {
            debug('Couchbase DELETE:', key);
            
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

    // Run a N1QL query with named parameters
    async query<T>(statement: string, namedParams?: Record<string, unknown>): Promise<T[]> {
        try {
            debug('Couchbase QUERY:', statement);
            
            // Build request body with named parameters (prefixed with $)
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

    // Test connection
    async ping(): Promise<boolean> {
        try {
            debug('Couchbase PING');
            
            const response = await fetch(`${this.getManagementUrl()}/pools`, {
                headers: {
                    'Authorization': this.getAuthHeader()
                },
                signal: this.createTimeoutSignal()
            });
            
            const success = response.ok;
            debug('Couchbase PING result:', success);
            
            if (success) {
                info('Couchbase connection successful');
            }
            
            return success;
        } catch (err) {
            error('Couchbase PING failed:', err);
            return false;
        }
    }
}

// Singleton instance
let clientInstance: CouchbaseRestClient | null = null;

export function getCouchbaseClient(): CouchbaseRestClient {
    if (!clientInstance) {
        clientInstance = new CouchbaseRestClient();
    }
    return clientInstance;
}

export async function shutdownCouchbase(): Promise<void> {
    info('Couchbase client shutdown');
    clientInstance = null;
}
