/**
 * Unit tests for Change Consolidator.
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import {
    consolidateFileChanges,
    needsConsolidation,
    getConsolidationPreview,
    ConsolidationResult
} from '../../edits/changeConsolidator';
import { FileChange, LineOperation } from '../../prompts/responseSchema';

describe('Change Consolidator', () => {

    describe('needsConsolidation', () => {
        it('returns false for empty array', () => {
            assert.strictEqual(needsConsolidation([]), false);
        });

        it('returns false for single change', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'const x = 1;' }
            ];
            assert.strictEqual(needsConsolidation(changes), false);
        });

        it('returns false for different files', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'const x = 1;' },
                { path: 'src/utils.ts', language: 'typescript', content: 'const y = 2;' }
            ];
            assert.strictEqual(needsConsolidation(changes), false);
        });

        it('returns true for same file', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'const x = 1;' },
                { path: 'src/main.ts', language: 'typescript', content: 'const y = 2;' }
            ];
            assert.strictEqual(needsConsolidation(changes), true);
        });

        it('normalizes paths correctly', () => {
            const changes: FileChange[] = [
                { path: './src/main.ts', language: 'typescript', content: 'const x = 1;' },
                { path: 'src/main.ts', language: 'typescript', content: 'const y = 2;' }
            ];
            assert.strictEqual(needsConsolidation(changes), true);
        });
    });

    describe('consolidateFileChanges', () => {
        it('returns empty result for empty input', () => {
            const result = consolidateFileChanges([]);
            
            assert.strictEqual(result.consolidatedChanges.length, 0);
            assert.strictEqual(result.mergedFiles.length, 0);
            assert.strictEqual(result.stats.originalCount, 0);
        });

        it('passes through single change unchanged', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'const x = 1;' }
            ];
            
            const result = consolidateFileChanges(changes);
            
            assert.strictEqual(result.consolidatedChanges.length, 1);
            assert.strictEqual(result.consolidatedChanges[0].content, 'const x = 1;');
            assert.strictEqual(result.mergedFiles.length, 0);
        });

        it('merges line operations from multiple changes', () => {
            const changes: FileChange[] = [
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 5, expectedContent: 'old1', newContent: 'new1' }
                    ]
                },
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 10, expectedContent: 'old2', newContent: 'new2' }
                    ]
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            assert.strictEqual(result.consolidatedChanges.length, 1);
            assert.strictEqual(result.mergedFiles.length, 1);
            assert.strictEqual(result.mergedFiles[0], 'src/main.ts');
            
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineOperations);
            assert.strictEqual(merged.lineOperations!.length, 2);
        });

        it('resolves conflicting operations on same line', () => {
            const changes: FileChange[] = [
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 5, expectedContent: 'old', newContent: 'new1' }
                    ]
                },
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 5, expectedContent: 'old', newContent: 'new2' }
                    ]
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            assert.strictEqual(result.consolidatedChanges.length, 1);
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineOperations);
            // Last one should win
            assert.strictEqual(merged.lineOperations!.length, 1);
            assert.strictEqual(merged.lineOperations![0].newContent, 'new2');
        });

        it('combines insert operations on same line', () => {
            const changes: FileChange[] = [
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'insertAfter', line: 5, newContent: 'line A' }
                    ]
                },
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'insertAfter', line: 5, newContent: 'line B' }
                    ]
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineOperations);
            assert.strictEqual(merged.lineOperations!.length, 1);
            // Should combine insert contents
            assert.ok(merged.lineOperations![0].newContent!.includes('line A'));
            assert.ok(merged.lineOperations![0].newContent!.includes('line B'));
        });

        it('handles delete operations with priority', () => {
            const changes: FileChange[] = [
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 5, expectedContent: 'old', newContent: 'new' }
                    ]
                },
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'delete', line: 5, expectedContent: 'old' }
                    ]
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineOperations);
            assert.strictEqual(merged.lineOperations!.length, 1);
            assert.strictEqual(merged.lineOperations![0].type, 'delete');
        });

        it('sorts operations by line number descending', () => {
            const changes: FileChange[] = [
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 5, expectedContent: 'old', newContent: 'new' }
                    ]
                },
                {
                    path: 'src/main.ts',
                    language: 'typescript',
                    content: '',
                    lineOperations: [
                        { type: 'replace', line: 20, expectedContent: 'old', newContent: 'new' },
                        { type: 'replace', line: 10, expectedContent: 'old', newContent: 'new' }
                    ]
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineOperations);
            // Should be sorted descending: 20, 10, 5
            assert.strictEqual(merged.lineOperations![0].line, 20);
            assert.strictEqual(merged.lineOperations![1].line, 10);
            assert.strictEqual(merged.lineOperations![2].line, 5);
        });

        it('handles content-based changes (last wins)', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'version 1' },
                { path: 'src/main.ts', language: 'typescript', content: 'version 2' }
            ];
            
            const result = consolidateFileChanges(changes);
            
            assert.strictEqual(result.consolidatedChanges.length, 1);
            assert.strictEqual(result.consolidatedChanges[0].content, 'version 2');
        });

        it('merges line ranges correctly', () => {
            const changes: FileChange[] = [
                { 
                    path: 'src/main.ts', 
                    language: 'typescript', 
                    content: '', 
                    lineRange: { start: 10, end: 20 } 
                },
                { 
                    path: 'src/main.ts', 
                    language: 'typescript', 
                    content: '', 
                    lineRange: { start: 30, end: 40 } 
                }
            ];
            
            const result = consolidateFileChanges(changes);
            
            const merged = result.consolidatedChanges[0];
            assert.ok(merged.lineRange);
            assert.strictEqual(merged.lineRange!.start, 10);
            assert.strictEqual(merged.lineRange!.end, 40);
        });

        it('handles mixed files correctly', () => {
            const changes: FileChange[] = [
                { path: 'src/main.ts', language: 'typescript', content: 'a' },
                { path: 'src/utils.ts', language: 'typescript', content: 'b' },
                { path: 'src/main.ts', language: 'typescript', content: 'c' }
            ];
            
            const result = consolidateFileChanges(changes);
            
            assert.strictEqual(result.consolidatedChanges.length, 2);
            assert.strictEqual(result.stats.originalCount, 3);
            assert.strictEqual(result.stats.consolidatedCount, 2);
            assert.strictEqual(result.mergedFiles.length, 1);
        });
    });

    describe('getConsolidationPreview', () => {
        it('returns no consolidation needed for unique files', () => {
            const changes: FileChange[] = [
                { path: 'a.ts', language: 'typescript', content: '' },
                { path: 'b.ts', language: 'typescript', content: '' }
            ];
            
            const preview = getConsolidationPreview(changes);
            assert.ok(preview.includes('No consolidation'));
        });

        it('shows files that will be merged', () => {
            const changes: FileChange[] = [
                { path: 'main.ts', language: 'typescript', content: '' },
                { path: 'main.ts', language: 'typescript', content: '' },
                { path: 'main.ts', language: 'typescript', content: '' }
            ];
            
            const preview = getConsolidationPreview(changes);
            assert.ok(preview.includes('main.ts'));
            assert.ok(preview.includes('3 changes'));
        });
    });
});
