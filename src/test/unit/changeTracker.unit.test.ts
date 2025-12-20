import * as assert from 'assert';

// Recreate the core logic for testing without vscode dependency
interface DiffStats {
    added: number;
    removed: number;
    modified: number;
}

interface FileChange {
    filePath: string;
    fileName: string;
    oldContent: string;
    newContent: string;
    stats: DiffStats;
    isNewFile: boolean;
}

interface ChangeSet {
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

class TestChangeTracker {
    private changeHistory: ChangeSet[] = [];
    private currentPosition: number = -1;

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
        description?: string
    ): ChangeSet {
        const totalStats: DiffStats = { added: 0, removed: 0, modified: 0 };

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
            durationMs: 0,
            applied: false,
            description
        };

        if (this.currentPosition < this.changeHistory.length - 1) {
            this.changeHistory = this.changeHistory.slice(0, this.currentPosition + 1);
        }

        this.changeHistory.push(changeSet);
        this.currentPosition = this.changeHistory.length - 1;

        return changeSet;
    }

    canRewind(): boolean {
        return this.currentPosition > 0;
    }

    canForward(): boolean {
        return this.currentPosition < this.changeHistory.length - 1;
    }

    rewind(): ChangeSet | null {
        if (!this.canRewind()) { return null; }
        this.currentPosition--;
        return this.changeHistory[this.currentPosition];
    }

    forward(): ChangeSet | null {
        if (!this.canForward()) { return null; }
        this.currentPosition++;
        return this.changeHistory[this.currentPosition];
    }

    getHistory(): ChangeSet[] {
        return [...this.changeHistory];
    }

    getCurrentPosition(): number {
        return this.currentPosition;
    }

    clear(): void {
        this.changeHistory = [];
        this.currentPosition = -1;
    }

    formatDuration(ms: number): string {
        if (ms < 1000) { return '<1s'; }
        const seconds = Math.floor(ms / 1000);
        if (seconds < 60) { return `${seconds}s`; }
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
        if (stats.added > 0) { parts.push(`+${stats.added}`); }
        if (stats.removed > 0) { parts.push(`-${stats.removed}`); }
        if (stats.modified > 0) { parts.push(`~${stats.modified}`); }
        return parts.join(' ') || 'No changes';
    }
}

describe('ChangeTracker - Diff Calculations', () => {
    let tracker: TestChangeTracker;

    beforeEach(() => {
        tracker = new TestChangeTracker();
    });

    it('calculates stats for new file (empty old content)', () => {
        const stats = tracker.calculateDiffStats('', 'line1\nline2\nline3');
        
        assert.strictEqual(stats.added, 3);
        assert.strictEqual(stats.removed, 0);
        assert.strictEqual(stats.modified, 0);
    });

    it('calculates stats for deleted file (empty new content)', () => {
        const stats = tracker.calculateDiffStats('line1\nline2\nline3', '');
        
        assert.strictEqual(stats.added, 0);
        assert.strictEqual(stats.removed, 3);
        assert.strictEqual(stats.modified, 0);
    });

    it('calculates stats for identical content', () => {
        const content = 'line1\nline2\nline3';
        const stats = tracker.calculateDiffStats(content, content);
        
        assert.strictEqual(stats.added, 0);
        assert.strictEqual(stats.removed, 0);
        assert.strictEqual(stats.modified, 0);
    });

    it('calculates stats for added lines', () => {
        const oldContent = 'line1\nline2';
        const newContent = 'line1\nline2\nline3\nline4';
        const stats = tracker.calculateDiffStats(oldContent, newContent);
        
        assert.strictEqual(stats.added, 2);
        assert.strictEqual(stats.removed, 0);
    });

    it('calculates stats for removed lines', () => {
        const oldContent = 'line1\nline2\nline3\nline4';
        const newContent = 'line1\nline2';
        const stats = tracker.calculateDiffStats(oldContent, newContent);
        
        assert.strictEqual(stats.removed, 2);
        assert.strictEqual(stats.added, 0);
    });
});

describe('ChangeTracker - History Management', () => {
    let tracker: TestChangeTracker;

    beforeEach(() => {
        tracker = new TestChangeTracker();
    });

    it('starts with empty history', () => {
        assert.strictEqual(tracker.getHistory().length, 0);
        assert.strictEqual(tracker.getCurrentPosition(), -1);
    });

    it('adds change set and updates position', () => {
        const fileChange = tracker.createFileChange('/path/file.ts', '', 'new content', true);
        tracker.addChangeSet('session-1', [fileChange]);
        
        assert.strictEqual(tracker.getHistory().length, 1);
        assert.strictEqual(tracker.getCurrentPosition(), 0);
    });

    it('tracks multiple change sets', () => {
        const fc1 = tracker.createFileChange('/path/file1.ts', '', 'content1', true);
        const fc2 = tracker.createFileChange('/path/file2.ts', '', 'content2', true);
        
        tracker.addChangeSet('session-1', [fc1]);
        tracker.addChangeSet('session-1', [fc2]);
        
        assert.strictEqual(tracker.getHistory().length, 2);
        assert.strictEqual(tracker.getCurrentPosition(), 1);
    });

    it('canRewind returns false for empty history', () => {
        assert.strictEqual(tracker.canRewind(), false);
    });

    it('canRewind returns false at position 0', () => {
        const fc = tracker.createFileChange('/path/file.ts', '', 'content', true);
        tracker.addChangeSet('session-1', [fc]);
        
        assert.strictEqual(tracker.canRewind(), false);
    });

    it('canRewind returns true with multiple changes', () => {
        const fc1 = tracker.createFileChange('/path/file1.ts', '', 'content1', true);
        const fc2 = tracker.createFileChange('/path/file2.ts', '', 'content2', true);
        
        tracker.addChangeSet('session-1', [fc1]);
        tracker.addChangeSet('session-1', [fc2]);
        
        assert.strictEqual(tracker.canRewind(), true);
    });

    it('rewind moves position back', () => {
        const fc1 = tracker.createFileChange('/path/file1.ts', '', 'content1', true);
        const fc2 = tracker.createFileChange('/path/file2.ts', '', 'content2', true);
        
        tracker.addChangeSet('session-1', [fc1]);
        tracker.addChangeSet('session-1', [fc2]);
        
        assert.strictEqual(tracker.getCurrentPosition(), 1);
        tracker.rewind();
        assert.strictEqual(tracker.getCurrentPosition(), 0);
    });

    it('clear resets history', () => {
        const fc = tracker.createFileChange('/path/file.ts', '', 'content', true);
        tracker.addChangeSet('session-1', [fc]);
        
        tracker.clear();
        
        assert.strictEqual(tracker.getHistory().length, 0);
        assert.strictEqual(tracker.getCurrentPosition(), -1);
    });
});

describe('ChangeTracker - Formatting', () => {
    let tracker: TestChangeTracker;

    beforeEach(() => {
        tracker = new TestChangeTracker();
    });

    it('formatDuration handles milliseconds', () => {
        assert.strictEqual(tracker.formatDuration(500), '<1s');
    });

    it('formatDuration handles seconds', () => {
        assert.strictEqual(tracker.formatDuration(5000), '5s');
        assert.strictEqual(tracker.formatDuration(45000), '45s');
    });

    it('formatDuration handles minutes', () => {
        assert.strictEqual(tracker.formatDuration(60000), '1m');
        assert.strictEqual(tracker.formatDuration(90000), '1m 30s');
    });

    it('formatDuration handles hours', () => {
        assert.strictEqual(tracker.formatDuration(3600000), '1h 0m');
    });

    it('formatStats with all types', () => {
        assert.strictEqual(tracker.formatStats({ added: 5, removed: 3, modified: 2 }), '+5 -3 ~2');
    });

    it('formatStats with only added', () => {
        assert.strictEqual(tracker.formatStats({ added: 10, removed: 0, modified: 0 }), '+10');
    });

    it('formatStats with no changes', () => {
        assert.strictEqual(tracker.formatStats({ added: 0, removed: 0, modified: 0 }), 'No changes');
    });
});
