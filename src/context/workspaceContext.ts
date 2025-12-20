import * as vscode from 'vscode';
import * as path from 'path';

const MAX_FILE_SIZE = 50000; // 50KB max per file
const MAX_CONTEXT_SIZE = 100000; // 100KB total context

export interface ProjectContext {
    agentMd: string | null;
    readme: string | null;
    packageJson: any | null;
    fileTree: string;
    recentFiles: string[];
    gitInfo: string | null;
}

export async function readAgentContext(): Promise<string | null> {
    try {
        const context = await gatherFullContext();
        return formatContextForPrompt(context);
    } catch (error) {
        console.error('Failed to read agent context:', error);
        return null;
    }
}

export async function gatherFullContext(): Promise<ProjectContext> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return {
            agentMd: null,
            readme: null,
            packageJson: null,
            fileTree: '',
            recentFiles: [],
            gitInfo: null
        };
    }

    const rootUri = workspaceFolders[0].uri;

    const [agentMd, readme, packageJson, fileTree, gitInfo] = await Promise.all([
        readFileIfExists(rootUri, ['AGENT.md', 'AGENTS.md']),
        readFileIfExists(rootUri, ['README.md', 'readme.md', 'Readme.md']),
        readPackageJson(rootUri),
        generateFileTree(rootUri),
        getGitInfo(rootUri)
    ]);

    const recentFiles = await getRecentlyEditedFiles();

    return {
        agentMd,
        readme,
        packageJson,
        fileTree,
        recentFiles,
        gitInfo
    };
}

async function readFileIfExists(rootUri: vscode.Uri, fileNames: string[]): Promise<string | null> {
    for (const fileName of fileNames) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, fileName);
            const data = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(data).toString('utf8');
            return content.slice(0, MAX_FILE_SIZE);
        } catch {
            // File doesn't exist
        }
    }
    return null;
}

async function readPackageJson(rootUri: vscode.Uri): Promise<any | null> {
    try {
        const pkgUri = vscode.Uri.joinPath(rootUri, 'package.json');
        const data = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(Buffer.from(data).toString('utf8'));
        return {
            name: pkg.name,
            description: pkg.description,
            version: pkg.version,
            main: pkg.main,
            scripts: pkg.scripts,
            dependencies: Object.keys(pkg.dependencies || {}),
            devDependencies: Object.keys(pkg.devDependencies || {})
        };
    } catch {
        return null;
    }
}

async function generateFileTree(rootUri: vscode.Uri, maxDepth: number = 3): Promise<string> {
    const ignorePatterns = [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        '**/*.lock',
        '**/package-lock.json'
    ];

    try {
        const files = await vscode.workspace.findFiles('**/*', `{${ignorePatterns.join(',')}}`, 500);
        
        const tree: { [key: string]: any } = {};
        const rootPath = rootUri.fsPath;

        for (const file of files) {
            const relativePath = path.relative(rootPath, file.fsPath);
            const parts = relativePath.split(path.sep);
            
            if (parts.length > maxDepth) continue;

            let current = tree;
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                if (i === parts.length - 1) {
                    current[part] = null; // file
                } else {
                    current[part] = current[part] || {};
                    current = current[part];
                }
            }
        }

        return formatTree(tree, '');
    } catch (error) {
        console.error('Failed to generate file tree:', error);
        return '';
    }
}

function formatTree(tree: { [key: string]: any }, indent: string): string {
    const lines: string[] = [];
    const entries = Object.entries(tree).sort(([a], [b]) => {
        const aIsDir = tree[a] !== null;
        const bIsDir = tree[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
    });

    for (const [name, value] of entries) {
        if (value === null) {
            lines.push(`${indent}${name}`);
        } else {
            lines.push(`${indent}${name}/`);
            lines.push(formatTree(value, indent + '  '));
        }
    }
    return lines.join('\n');
}

async function getRecentlyEditedFiles(): Promise<string[]> {
    const recentFiles: string[] = [];
    
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && !doc.uri.fsPath.includes('node_modules')) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                const relativePath = path.relative(workspaceFolders[0].uri.fsPath, doc.uri.fsPath);
                if (!relativePath.startsWith('..')) {
                    recentFiles.push(relativePath);
                }
            }
        }
    }

    return recentFiles.slice(0, 10);
}

async function getGitInfo(rootUri: vscode.Uri): Promise<string | null> {
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) return null;

        const git = gitExtension.exports.getAPI(1);
        const repo = git.repositories[0];
        if (!repo) return null;

        const branch = repo.state.HEAD?.name || 'unknown';
        const changes = repo.state.workingTreeChanges?.length || 0;
        const staged = repo.state.indexChanges?.length || 0;

        return `Branch: ${branch}, Changes: ${changes} modified, ${staged} staged`;
    } catch {
        return null;
    }
}

function formatContextForPrompt(context: ProjectContext): string {
    const sections: string[] = [];

    if (context.agentMd) {
        sections.push(`## Project Instructions (AGENT.md)\n${context.agentMd}`);
    }

    if (context.packageJson) {
        const pkg = context.packageJson;
        sections.push(`## Project Info
- Name: ${pkg.name || 'unknown'}
- Description: ${pkg.description || 'N/A'}
- Main: ${pkg.main || 'N/A'}
- Scripts: ${Object.keys(pkg.scripts || {}).join(', ') || 'none'}
- Dependencies: ${pkg.dependencies?.slice(0, 20).join(', ') || 'none'}${pkg.dependencies?.length > 20 ? '...' : ''}
- DevDeps: ${pkg.devDependencies?.slice(0, 10).join(', ') || 'none'}${pkg.devDependencies?.length > 10 ? '...' : ''}`);
    }

    if (context.fileTree) {
        sections.push(`## File Structure\n\`\`\`\n${context.fileTree.slice(0, 3000)}\n\`\`\``);
    }

    if (context.recentFiles.length > 0) {
        sections.push(`## Open/Recent Files\n${context.recentFiles.map(f => `- ${f}`).join('\n')}`);
    }

    if (context.gitInfo) {
        sections.push(`## Git Status\n${context.gitInfo}`);
    }

    if (context.readme && !context.agentMd) {
        const readmePreview = context.readme.slice(0, 2000);
        sections.push(`## README.md\n${readmePreview}${context.readme.length > 2000 ? '\n...(truncated)' : ''}`);
    }

    const result = sections.join('\n\n');
    return result.slice(0, MAX_CONTEXT_SIZE);
}

export async function findFiles(glob: string): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(glob, '**/node_modules/**', 100);
}

export async function readFile(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
}

export async function getActiveEditorContent(): Promise<{ content: string; fileName: string; selection?: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const document = editor.document;
    const selection = editor.selection;
    
    return {
        content: document.getText(),
        fileName: document.fileName,
        selection: selection.isEmpty ? undefined : document.getText(selection)
    };
}

export async function gatherContextFromSelection(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return null;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
        return null;
    }

    const selectedText = editor.document.getText(selection);
    const fileName = editor.document.fileName;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    return `File: ${fileName} (lines ${startLine}-${endLine})\n\`\`\`\n${selectedText}\n\`\`\``;
}

export async function getFileContent(relativePath: string): Promise<string | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return null;

    try {
        const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
        const data = await vscode.workspace.fs.readFile(fileUri);
        return Buffer.from(data).toString('utf8').slice(0, MAX_FILE_SIZE);
    } catch {
        return null;
    }
}
