/**
 * Unit tests for Smart File Reader functionality.
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import {
    smartReadFile,
    createFileInfo,
    shouldUseSmartReading,
    getFileSizeCategory,
    calculateTotalChunks,
    getReadingRecommendation,
    readNextChunk,
    searchAndRead,
    readRanges,
    smartReadFilesParallel,
    FileInfo,
    SmartReadResult,
    ParallelReadResult
} from '../../agent/smartFileReader';

describe('Smart File Reader', () => {

    function createTestFile(content: string, path: string = '/test/file.ts'): FileInfo {
        return createFileInfo(path, content, 'typescript');
    }

    function generateLargeContent(sizeKB: number): string {
        const lines: string[] = [];
        let currentSize = 0;
        let i = 0;
        
        while (currentSize < sizeKB * 1024) {
            if (i % 50 === 0) {
                lines.push(`export function function${i}(): number {`);
                lines.push(`    // Function ${i} implementation`);
                lines.push(`    return ${i};`);
                lines.push(`}`);
                lines.push('');
            } else {
                lines.push(`const variable${i} = ${i};`);
            }
            currentSize = lines.join('\n').length;
            i++;
        }
        return lines.join('\n');
    }

    function generateTypescriptFile(numFunctions: number): string {
        const lines: string[] = [
            'import { foo } from "./foo";',
            'import { bar } from "./bar";',
            'import * as utils from "./utils";',
            '',
            'export interface TestInterface {',
            '    name: string;',
            '    value: number;',
            '}',
            '',
            'export class TestClass {',
            '    constructor() {}',
            '}',
            ''
        ];
        
        for (let i = 0; i < numFunctions; i++) {
            lines.push(`export function test${i}(): void {`);
            lines.push(`    console.log("test${i}");`);
            lines.push(`}`);
            lines.push('');
        }
        
        lines.push('export default TestClass;');
        return lines.join('\n');
    }

    describe('shouldUseSmartReading', () => {
        it('returns false for small files (< 50KB)', () => {
            assert.strictEqual(shouldUseSmartReading(40 * 1024), false);
        });

        it('returns true for large files (> 50KB)', () => {
            assert.strictEqual(shouldUseSmartReading(50 * 1024), false); // Exactly 50KB is not large
            assert.strictEqual(shouldUseSmartReading(50 * 1024 + 1), true); // Just over threshold
            assert.strictEqual(shouldUseSmartReading(100 * 1024), true);
        });
    });

    describe('getFileSizeCategory', () => {
        it('returns "small" for files under 50KB', () => {
            assert.strictEqual(getFileSizeCategory(30 * 1024), 'small');
        });

        it('returns "large" for files between 50KB and 200KB', () => {
            assert.strictEqual(getFileSizeCategory(100 * 1024), 'large');
        });

        it('returns "huge" for files over 200KB', () => {
            assert.strictEqual(getFileSizeCategory(250 * 1024), 'huge');
        });
    });

    describe('calculateTotalChunks', () => {
        it('returns 1 for small files', () => {
            assert.strictEqual(calculateTotalChunks(100), 1);
        });

        it('returns multiple chunks for large files', () => {
            const chunks = calculateTotalChunks(1500, 500);
            assert.ok(chunks >= 3, `Expected at least 3 chunks, got ${chunks}`);
        });
    });

    describe('createFileInfo', () => {
        it('creates FileInfo with correct properties', () => {
            const content = 'const x = 1;\nconst y = 2;';
            const fileInfo = createFileInfo('/test/file.ts', content, 'typescript');
            
            assert.strictEqual(fileInfo.path, '/test/file.ts');
            assert.strictEqual(fileInfo.language, 'typescript');
            assert.strictEqual(fileInfo.lineCount, 2);
            assert.ok(fileInfo.sizeBytes > 0);
            assert.ok(fileInfo.md5Hash.length === 32);
        });
    });

    describe('smartReadFile - strategy selection', () => {
        it('uses "full" strategy for small files', () => {
            const smallFile = createTestFile('const x = 1;');
            const result = smartReadFile(smallFile);
            
            assert.strictEqual(result.strategy, 'full');
            assert.ok(result.reason.includes('under'));
        });

        it('uses "structured" strategy for large files', () => {
            const largeContent = generateLargeContent(60); // 60KB
            const largeFile = createTestFile(largeContent);
            const result = smartReadFile(largeFile);
            
            assert.strictEqual(result.strategy, 'structured');
            assert.ok(result.sections.length > 1, 'Should have multiple sections');
        });

        it('uses "summarized" strategy for huge files', () => {
            const hugeContent = generateLargeContent(250); // 250KB
            const hugeFile = createTestFile(hugeContent);
            const result = smartReadFile(hugeFile);
            
            assert.strictEqual(result.strategy, 'summarized');
            assert.ok(result.formattedContent.includes('Summary'));
        });

        it('uses "targeted" strategy when searchPattern provided', () => {
            const content = generateTypescriptFile(20);
            const file = createTestFile(content);
            const result = smartReadFile(file, { searchPattern: 'test5' });
            
            assert.strictEqual(result.strategy, 'targeted');
            assert.ok(result.sections.some(s => s.type === 'search-match'));
        });

        it('uses "chunked" strategy when chunkIndex provided', () => {
            const largeContent = generateLargeContent(60);
            const largeFile = createTestFile(largeContent);
            const result = smartReadFile(largeFile, { chunkIndex: 0 });
            
            assert.strictEqual(result.strategy, 'chunked');
            assert.ok(result.totalChunks !== undefined);
            assert.strictEqual(result.currentChunk, 0);
        });

        it('respects forceStrategy option', () => {
            const smallFile = createTestFile('const x = 1;');
            const result = smartReadFile(smallFile, { forceStrategy: 'summarized' });
            
            assert.strictEqual(result.strategy, 'summarized');
        });
    });

    describe('smartReadFile - structured reading', () => {
        it('includes imports section for TypeScript files', () => {
            const content = generateTypescriptFile(10);
            const file = createTestFile(content);
            const result = smartReadFile(file, { forceStrategy: 'structured' });
            
            const importsSection = result.sections.find(s => s.type === 'imports');
            assert.ok(importsSection, 'Should have imports section');
            assert.ok(importsSection.content.includes('import'));
        });

        it('includes structure definitions', () => {
            const content = generateTypescriptFile(10);
            const file = createTestFile(content);
            const result = smartReadFile(file, { forceStrategy: 'structured' });
            
            const headerSection = result.sections.find(s => s.type === 'header');
            assert.ok(headerSection, 'Should have structure header');
            assert.ok(headerSection.content.includes('function') || headerSection.content.includes('class'));
        });
    });

    describe('smartReadFile - chunked reading', () => {
        it('provides chunk metadata', () => {
            const largeContent = generateLargeContent(80);
            const largeFile = createTestFile(largeContent);
            const result = smartReadFile(largeFile, { chunkIndex: 0 });
            
            assert.ok(result.totalChunks !== undefined);
            assert.ok(result.totalChunks >= 2);
            assert.strictEqual(result.currentChunk, 0);
            assert.strictEqual(result.hasMoreChunks, true);
        });

        it('reads subsequent chunks correctly', () => {
            const largeContent = generateLargeContent(80);
            const largeFile = createTestFile(largeContent);
            
            const chunk1 = smartReadFile(largeFile, { chunkIndex: 0 });
            const chunk2 = readNextChunk(largeFile, 0);
            
            assert.strictEqual(chunk2.currentChunk, 1);
            assert.notStrictEqual(chunk1.sections[0].content, chunk2.sections[0].content);
        });
    });

    describe('smartReadFile - targeted reading', () => {
        it('finds search pattern matches with context', () => {
            const content = 'line1\nline2\nTARGET_PATTERN\nline4\nline5';
            const file = createTestFile(content);
            const result = searchAndRead(file, 'TARGET_PATTERN');
            
            assert.strictEqual(result.strategy, 'targeted');
            assert.ok(result.sections.length > 0);
            assert.ok(result.sections[0].content.includes('TARGET_PATTERN'));
        });

        it('reads specific line ranges', () => {
            const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
            const content = lines.join('\n');
            const file = createTestFile(content);
            
            const result = readRanges(file, [{ startLine: 10, endLine: 20 }]);
            
            assert.strictEqual(result.strategy, 'targeted');
            const section = result.sections[0];
            assert.strictEqual(section.startLine, 10);
            assert.strictEqual(section.endLine, 20);
        });
    });

    describe('smartReadFile - output formatting', () => {
        it('includes file metadata in formatted output', () => {
            const file = createTestFile('const x = 1;');
            const result = smartReadFile(file);
            
            assert.ok(result.formattedContent.includes(file.relativePath));
            assert.ok(result.formattedContent.includes('MD5:'));
        });

        it('includes line numbers in code blocks', () => {
            const content = 'line1\nline2\nline3';
            const file = createTestFile(content);
            const result = smartReadFile(file);
            
            assert.ok(result.formattedContent.includes('1:'));
            assert.ok(result.formattedContent.includes('2:'));
        });

        it('respects maxOutputSize option', () => {
            const largeContent = generateLargeContent(60);
            const file = createTestFile(largeContent);
            const result = smartReadFile(file, { 
                forceStrategy: 'full',
                maxOutputSize: 1000 
            });
            
            assert.ok(result.formattedContent.length <= 1100); // Some buffer for truncation message
            assert.ok(result.formattedContent.includes('truncated'));
        });

        it('estimates tokens correctly', () => {
            const content = 'x'.repeat(400); // ~100 tokens
            const file = createTestFile(content);
            const result = smartReadFile(file);
            
            assert.ok(result.estimatedTokens > 0);
        });
    });

    describe('getReadingRecommendation', () => {
        it('provides appropriate recommendations', () => {
            const smallRec = getReadingRecommendation(30 * 1024, 500);
            assert.ok(smallRec.includes('small'));

            const largeRec = getReadingRecommendation(80 * 1024, 2000);
            assert.ok(largeRec.includes('large') || largeRec.includes('Large'));

            const hugeRec = getReadingRecommendation(300 * 1024, 5000);
            assert.ok(hugeRec.includes('very large') || hugeRec.includes('summary'));
        });
    });

    describe('smartReadFilesParallel', () => {
        it('returns empty result for empty input', async () => {
            const result = await smartReadFilesParallel([]);
            
            assert.strictEqual(result.results.length, 0);
            assert.strictEqual(result.totalTokens, 0);
            assert.strictEqual(result.formattedContent, '');
        });

        it('reads multiple files in parallel', async () => {
            const files = [
                { path: '/test/file1.ts', content: 'const a = 1;', language: 'typescript' },
                { path: '/test/file2.ts', content: 'const b = 2;', language: 'typescript' },
                { path: '/test/file3.ts', content: 'const c = 3;', language: 'typescript' }
            ];
            
            const result = await smartReadFilesParallel(files);
            
            assert.strictEqual(result.results.length, 3);
            assert.ok(result.totalTokens > 0);
            assert.ok(result.formattedContent.includes('file1.ts'));
            assert.ok(result.formattedContent.includes('file2.ts'));
            assert.ok(result.formattedContent.includes('file3.ts'));
            assert.ok(result.readTimeMs >= 0);
        });

        it('applies options to all files', async () => {
            const largeContent = 'x'.repeat(60 * 1024); // 60KB each
            const files = [
                { path: '/test/large1.ts', content: largeContent, language: 'typescript' },
                { path: '/test/large2.ts', content: largeContent, language: 'typescript' }
            ];
            
            const result = await smartReadFilesParallel(files, { maxOutputSize: 5000 });
            
            assert.strictEqual(result.results.length, 2);
            // Each file should use structured strategy for 60KB files
            assert.ok(result.results.every(r => r.strategy === 'structured'));
        });

        it('combines formatted content correctly', async () => {
            const files = [
                { path: '/a.ts', content: 'const a = 1;', language: 'typescript' },
                { path: '/b.ts', content: 'const b = 2;', language: 'typescript' }
            ];
            
            const result = await smartReadFilesParallel(files);
            
            // Should have content from both files separated
            const parts = result.formattedContent.split('/b.ts');
            assert.ok(parts.length >= 2, 'Files should be separated in output');
        });
    });
});
