/**
 * Config Loader - Loads prompt configs from JSON files in the config folder.
 * 
 * This allows prompts to be edited without recompiling the extension.
 * Falls back to hardcoded defaults if config files are not found.
 */

import * as fs from 'fs';
import * as path from 'path';
import { debug, info, error as logError } from './logger';

// Cache for loaded configs
const configCache = new Map<string, any>();

/**
 * Get the path to the config folder.
 * When running in VS Code, this is relative to the extension's install location.
 */
function getConfigPath(): string {
    // __dirname is the compiled output folder (out/utils)
    // Go up two levels to get to the extension root, then into config
    return path.join(__dirname, '..', '..', 'config');
}

/**
 * Load a config file by name.
 * @param configName - Name of the config file (without .json extension)
 * @returns The parsed config object, or null if not found
 */
export function loadConfig<T = any>(configName: string): T | null {
    // Check cache first
    if (configCache.has(configName)) {
        return configCache.get(configName) as T;
    }

    const configPath = path.join(getConfigPath(), `${configName}.json`);
    
    try {
        if (!fs.existsSync(configPath)) {
            debug(`Config file not found: ${configPath}`);
            return null;
        }

        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        
        // Cache the result
        configCache.set(configName, parsed);
        debug(`Loaded config: ${configName}`);
        
        return parsed as T;
    } catch (err: any) {
        logError(`Failed to load config ${configName}:`, err);
        return null;
    }
}

/**
 * Get a prompt from a config file.
 * @param configName - Name of the config file
 * @param fallback - Fallback prompt if config is not found
 * @returns The prompt string
 */
export function getPromptFromConfig(configName: string, fallback: string): string {
    const config = loadConfig(configName);
    if (config && config.prompt) {
        return config.prompt;
    }
    return fallback;
}

/**
 * Get a schema from a config file.
 * @param configName - Name of the config file
 * @param fallback - Fallback schema if config is not found
 * @returns The schema object
 */
export function getSchemaFromConfig<T = any>(configName: string, fallback: T): T {
    const config = loadConfig(configName);
    if (config && config.schema) {
        return config.schema as T;
    }
    return fallback;
}

/**
 * Clear the config cache (useful for hot-reload).
 */
export function clearConfigCache(): void {
    configCache.clear();
    info('Config cache cleared');
}

/**
 * Reload a specific config file.
 * @param configName - Name of the config file to reload
 */
export function reloadConfig(configName: string): void {
    configCache.delete(configName);
    loadConfig(configName);
}

/**
 * List all available config files.
 * @returns Array of config file names (without .json extension)
 */
export function listConfigs(): string[] {
    const configPath = getConfigPath();
    
    try {
        if (!fs.existsSync(configPath)) {
            return [];
        }

        const files = fs.readdirSync(configPath);
        return files
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    } catch (err: any) {
        logError('Failed to list configs:', err);
        return [];
    }
}

// Config file interfaces for type safety
export interface PromptConfig {
    name: string;
    description: string;
    version: string;
    prompt: string;
}

export interface PromptTemplateConfig {
    name: string;
    description: string;
    version: string;
    promptTemplate: string;
    variables?: Record<string, string>;
}

export interface SchemaConfig {
    name: string;
    description: string;
    version: string;
    schema: any;
}
