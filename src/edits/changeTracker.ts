import * as vscode from 'vscode';

export interface DiffStats {
    added: number;
    removed: number;
    modified: number;
}

export interface FileChange {
    filePath: string;
    fileName: string;
    oldContent: string;
    newContent: string;
    stats: DiffStats;
    isNewFile: boolean;
}

export interface ChangeSet {
    id: string;
    sessionId: string;
    timestamp: Date;
    files: FileChange[];
    totalStats: DiffStats;
    cost: number;
    tokensUsed: number;
    durationMs: number;
    applied: boolean;
    description?: string;
}

class ChangeTracker {
    private changeHistory: ChangeSet[] = [];
    private currentPosition: number = -1;
    private startTime: number = 0;
    private onChangeCallback?: (changes: ChangeSet[], position: number) => void;
    private onChangeSetAddedCallback?: (changeSet: ChangeSet) => void;

    startTracking(): void {
        this.startTime = Date.now();
    }

    calculateDiffStats(oldContent: string, newContent: string): DiffStats {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        
        let added = 0;
        let removed = 0;
        let modified = 0;

        if (oldContent === '') {
            return { added: newLines.length, removed: 0, modified: 0 };
        }

        if (newContent === '') {
            return { added: 0, removed: oldLines.length, modified: 0 };
        }

        const oldSet = new Set(oldLines);
        const newSet = new Set(newLines);

        for (const line of newLines) {
            if (!oldSet.has(line)) {
                added++;
            }
        }

        for (const line of oldLines) {
            if (!newSet.has(line)) {
                removed++;
            }
        }

        const minLength = Math.min(oldLines.length, newLines.length);
        for (let i = 0; i < minLength; i++) {
            if (oldLines[i] !== newLines[i] && oldSet.has(newLines[i]) === false && newSet.has(oldLines[i]) === false) {
                modified++;
                if (added > 0) added--;
                if (removed > 0) removed--;
            }
        }

        return { added, removed, modified };
    }

    createFileChange(
        filePath: string,
        oldContent: string,
        newContent: string,
        isNewFile: boolean = false
    ): FileChange {
        const fileName = filePath.split('/').pop() || filePath;
        const stats = this.calculateDiffStats(oldContent, newContent);
        
        return {
            filePath,
            fileName,
            oldContent,
            newContent,
            stats,
            isNewFile
        };
    }

    addChangeSet(
        sessionId: string,
        files: FileChange[],
        cost: number = 0,
        tokensUsed: number = 0,
        description?: string,
        applied: boolean = false
    ): ChangeSet {
        const totalStats: DiffStats = {
            added: 0,
            removed: 0,
            modified: 0
        };

        for (const file of files) {
            totalStats.added += file.stats.added;
            totalStats.removed += file.stats.removed;
            totalStats.modified += file.stats.modified;
        }

        const changeSet: ChangeSet = {
            id: `cs-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            sessionId,
            timestamp: new Date(),
            files,
            totalStats,
            cost,
            tokensUsed,
            durationMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
            applied,
            description
        };

        if (this.currentPosition < this.changeHistory.length - 1) {
            this.changeHistory = this.changeHistory.slice(0, this.currentPosition + 1);
        }

        this.changeHistory.push(changeSet);
        this.currentPosition = this.changeHistory.length - 1;
        this.startTime = 0;

        this.notifyChange();
        
        // Notify listeners that a new ChangeSet was added (for AgentStepTracker)
        if (this.onChangeSetAddedCallback) {
            this.onChangeSetAddedCallback(changeSet);
        }
        
        return changeSet;
    }

    markApplied(changeSetId: string): void {
        const cs = this.changeHistory.find(c => c.id === changeSetId);
        if (cs) {
            cs.applied = true;
            this.notifyChange();
        }
    }

    markReverted(changeSetId: string): void {
        const cs = this.changeHistory.find(c => c.id === changeSetId);
        if (cs) {
            cs.applied = false;
            this.notifyChange();
        }
    }

    canRewind(): boolean {
        // Can rewind if we have any history AND we're not already at "original" (-1)
        return this.changeHistory.length > 0 && this.currentPosition >= 0;
    }
    
    /**
     * Check if we're at the "original" position (before any AI changes)
     */
    isAtOriginal(): boolean {
        return this.currentPosition === -1;
    }

    canForward(): boolean {
        // Can forward if we're at -1 (original) or below the last changeset
        return this.currentPosition < this.changeHistory.length - 1;
    }

    /**
     * Rewind one step. Returns null if already at original (-1).
     * When rewinding from position 0, we go to -1 (original state).
     */
    rewind(): ChangeSet | null {
        if (!this.canRewind()) return null;
        this.currentPosition--;
        this.notifyChange();
        // If we're now at -1, return null to indicate "original" state
        if (this.currentPosition === -1) {
            return null;
        }
        return this.changeHistory[this.currentPosition];
    }

    forward(): ChangeSet | null {
        if (!this.canForward()) return null;
        this.currentPosition++;
        this.notifyChange();
        return this.changeHistory[this.currentPosition];
    }

    getChangeAt(position: number): ChangeSet | null {
        if (position < 0 || position >= this.changeHistory.length) return null;
        return this.changeHistory[position];
    }

    getCurrentChange(): ChangeSet | null {
        return this.getChangeAt(this.currentPosition);
    }

    getHistory(): ChangeSet[] {
        return [...this.changeHistory];
    }

    getCurrentPosition(): number {
        return this.currentPosition;
    }

    setPosition(position: number): ChangeSet | null {
        // Allow position -1 for "original" state
        if (position < -1 || position >= this.changeHistory.length) return null;
        this.currentPosition = position;
        this.notifyChange();
        if (position === -1) return null; // "Original" state
        return this.changeHistory[this.currentPosition];
    }
    
    /**
     * Set position to -1 (original state before any AI changes)
     */
    setToOriginal(): void {
        this.currentPosition = -1;
        this.notifyChange();
    }

    onChange(callback: (changes: ChangeSet[], position: number) => void): void {
        this.onChangeCallback = callback;
    }

    /**
     * Register callback for when a new ChangeSet is added.
     * Used by AgentStepTracker to auto-link ChangeSets to steps.
     */
    onChangeSetAdded(callback: (changeSet: ChangeSet) => void): void {
        this.onChangeSetAddedCallback = callback;
    }

    private notifyChange(): void {
        if (this.onChangeCallback) {
            this.onChangeCallback(this.getHistory(), this.currentPosition);
        }
    }

    getSessionChanges(sessionId: string): ChangeSet[] {
        return this.changeHistory.filter(c => c.sessionId === sessionId);
    }

    /**
     * Get unique file paths that have been modified in this session
     * Returns most recently modified files first
     */
    getModifiedFilePaths(): string[] {
        const fileMap = new Map<string, Date>();
        
        // Collect all file paths with their most recent modification time
        for (const changeSet of this.changeHistory) {
            for (const file of changeSet.files) {
                const existing = fileMap.get(file.filePath);
                if (!existing || changeSet.timestamp > existing) {
                    fileMap.set(file.filePath, changeSet.timestamp);
                }
            }
        }
        
        // Sort by most recent first
        return Array.from(fileMap.entries())
            .sort((a, b) => b[1].getTime() - a[1].getTime())
            .map(([path]) => path);
    }

    /**
     * Get all unapplied changes (proposed but not yet written to disk)
     * These need to be applied before AI can see the current state
     */
    getUnappliedChanges(): ChangeSet[] {
        return this.changeHistory.filter(cs => !cs.applied);
    }

    clear(): void {
        this.changeHistory = [];
        this.currentPosition = -1;
        this.startTime = 0;
        this.notifyChange();
    }

    clearSession(sessionId: string): void {
        this.changeHistory = this.changeHistory.filter(c => c.sessionId !== sessionId);
        this.currentPosition = Math.min(this.currentPosition, this.changeHistory.length - 1);
        this.notifyChange();
    }

    formatDuration(ms: number): string {
        if (ms < 1000) return '<1s';
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes < 60) {
            return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
        }
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        return `${hours}h ${remainingMinutes}m`;
    }

    formatStats(stats: DiffStats): string {
        const parts: string[] = [];
        if (stats.added > 0) parts.push(`+${stats.added}`);
        if (stats.removed > 0) parts.push(`-${stats.removed}`);
        if (stats.modified > 0) parts.push(`~${stats.modified}`);
        return parts.join(' ') || 'No changes';
    }

    toSerializable(): object {
        return {
            history: this.changeHistory.map(cs => ({
                ...cs,
                timestamp: cs.timestamp.toISOString()
            })),
            position: this.currentPosition
        };
    }

    fromSerializable(data: any): void {
        if (data && data.history) {
            this.changeHistory = data.history.map((cs: any) => ({
                ...cs,
                timestamp: new Date(cs.timestamp)
            }));
            this.currentPosition = data.position ?? this.changeHistory.length - 1;
            this.notifyChange();
        }
    }
}

export const changeTracker = new ChangeTracker();
