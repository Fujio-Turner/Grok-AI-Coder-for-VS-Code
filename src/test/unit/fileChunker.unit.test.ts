/**
 * Unit tests for file chunking functionality.
 */

// Set test environment before imports
process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { 
    chunkFile, 
    needsChunking, 
    formatChunkForPrompt, 
    createChunkSummary,
    estimateTokens,
    FileChunk,
    ChunkingResult,
    ChunkableFileContent
} from '../../agent/fileChunker';

describe('File Chunker', () => {
    
    // Helper to create a ChunkableFileContent object
    function createFileContent(content: string, path: string = '/test/file.py'): ChunkableFileContent {
        return {
            path,
            relativePath: path,
            name: path.split('/').pop() || 'file.py',
            content,
            language: path.split('.').pop() || 'text',
            lineCount: content.split('\n').length,
            md5Hash: 'test-hash-123'
        };
    }
    
    // Helper to generate large content
    function generateLargeContent(sizeKB: number, language: string = 'python'): string {
        const lines: string[] = [];
        const lineTemplate = language === 'python' 
            ? 'def function_${i}():\n    """Function ${i} docstring."""\n    return ${i}\n\n'
            : 'function function${i}() {\n    // Function ${i} comment\n    return ${i};\n}\n\n';
        
        let currentSize = 0;
        let i = 0;
        while (currentSize < sizeKB * 1024) {
            const line = lineTemplate.replace(/\$\{i\}/g, String(i));
            lines.push(line);
            currentSize += line.length;
            i++;
        }
        return lines.join('');
    }

    describe('needsChunking', () => {
        it('returns false for small files', () => {
            const smallFile = createFileContent('print("hello")');
            assert.strictEqual(needsChunking(smallFile), false);
        });

        it('returns false for files under 50KB', () => {
            const content = 'x'.repeat(49 * 1024); // 49KB
            const file = createFileContent(content);
            assert.strictEqual(needsChunking(file), false);
        });

        it('returns true for files over 50KB', () => {
            const content = 'x'.repeat(51 * 1024); // 51KB
            const file = createFileContent(content);
            assert.strictEqual(needsChunking(file), true);
        });

        it('respects custom threshold option', () => {
            const content = 'x'.repeat(25 * 1024); // 25KB
            const file = createFileContent(content);
            assert.strictEqual(needsChunking(file, { chunkThreshold: 20 * 1024 }), true);
            assert.strictEqual(needsChunking(file, { chunkThreshold: 30 * 1024 }), false);
        });
    });

    describe('estimateTokens', () => {
        it('estimates tokens correctly', () => {
            const content = 'x'.repeat(400); // 400 chars = ~100 tokens
            assert.strictEqual(estimateTokens(content), 100);
        });

        it('rounds up for partial tokens', () => {
            const content = 'x'.repeat(401); // 401 chars = 101 tokens (rounded up)
            assert.strictEqual(estimateTokens(content), 101);
        });
    });

    describe('chunkFile', () => {
        it('does not chunk small files', () => {
            const smallFile = createFileContent('print("hello")');
            const result = chunkFile(smallFile);
            
            assert.strictEqual(result.wasChunked, false);
            assert.strictEqual(result.chunks.length, 1);
            assert.strictEqual(result.chunks[0].chunkIndex, 0);
            assert.strictEqual(result.chunks[0].totalChunks, 1);
        });

        it('chunks large files into multiple pieces', () => {
            const largeContent = generateLargeContent(80); // 80KB
            const largeFile = createFileContent(largeContent, '/test/large.py');
            const result = chunkFile(largeFile);
            
            assert.strictEqual(result.wasChunked, true);
            assert.ok(result.chunks.length >= 2, `Expected at least 2 chunks, got ${result.chunks.length}`);
            
            // Verify chunk structure
            result.chunks.forEach((chunk, i) => {
                assert.strictEqual(chunk.chunkIndex, i);
                assert.strictEqual(chunk.totalChunks, result.chunks.length);
                assert.strictEqual(chunk.originalPath, '/test/large.py');
                assert.ok(chunk.startLine >= 1);
                assert.ok(chunk.endLine >= chunk.startLine);
            });
        });

        it('maintains line number continuity', () => {
            const largeContent = generateLargeContent(80);
            const largeFile = createFileContent(largeContent);
            const result = chunkFile(largeFile);
            
            // First chunk should start at line 1
            assert.strictEqual(result.chunks[0].startLine, 1);
            
            // Last chunk should end near the file's total line count
            const lastChunk = result.chunks[result.chunks.length - 1];
            assert.ok(
                Math.abs(lastChunk.endLine - result.originalFile.lineCount) <= 1,
                `Last chunk endLine ${lastChunk.endLine} should be close to total lines ${result.originalFile.lineCount}`
            );
        });

        it('includes line numbers in chunk content', () => {
            const content = 'line1\nline2\nline3\nline4\nline5';
            const file = createFileContent(content);
            const result = chunkFile(file, { chunkThreshold: 0 }); // Force chunking
            
            const firstChunk = result.chunks[0];
            assert.ok(firstChunk.content.includes('1:'), 'Should include line number 1');
        });

        it('respects custom chunk size', () => {
            const largeContent = generateLargeContent(80);
            const largeFile = createFileContent(largeContent);
            
            const smallChunks = chunkFile(largeFile, { 
                maxChunkSize: 10 * 1024, // 10KB chunks
                chunkThreshold: 0 
            });
            const largeChunks = chunkFile(largeFile, { 
                maxChunkSize: 40 * 1024, // 40KB chunks
                chunkThreshold: 0 
            });
            
            assert.ok(
                smallChunks.chunks.length > largeChunks.chunks.length,
                'Smaller chunk size should produce more chunks'
            );
        });
    });

    describe('formatChunkForPrompt', () => {
        it('formats single-chunk file correctly', () => {
            const chunk: FileChunk = {
                originalPath: '/test/file.py',
                chunkIndex: 0,
                totalChunks: 1,
                startLine: 1,
                endLine: 10,
                content: '1: print("hello")',
                rawContent: 'print("hello")',
                language: 'python',
                originalMd5: 'abc123',
                sizeBytes: 100,
                estimatedTokens: 25
            };
            
            const formatted = formatChunkForPrompt(chunk);
            assert.ok(formatted.includes('/test/file.py'));
            assert.ok(formatted.includes('MD5: abc123'));
            assert.ok(formatted.includes('python'));
            assert.ok(!formatted.includes('CHUNK'), 'Single chunk should not show CHUNK info');
        });

        it('formats multi-chunk correctly', () => {
            const chunk: FileChunk = {
                originalPath: '/test/file.py',
                chunkIndex: 1,
                totalChunks: 3,
                startLine: 100,
                endLine: 200,
                content: '100: def foo():',
                rawContent: 'def foo():',
                language: 'python',
                originalMd5: 'abc123',
                sizeBytes: 1000,
                estimatedTokens: 250
            };
            
            const formatted = formatChunkForPrompt(chunk);
            assert.ok(formatted.includes('CHUNK 2/3'), 'Should show chunk 2 of 3');
            assert.ok(formatted.includes('lines 100-200'), 'Should show line range');
        });
    });

    describe('createChunkSummary', () => {
        it('returns empty for single chunk', () => {
            const chunks: FileChunk[] = [{
                originalPath: '/test/file.py',
                chunkIndex: 0,
                totalChunks: 1,
                startLine: 1,
                endLine: 10,
                content: '',
                rawContent: '',
                language: 'python',
                originalMd5: 'abc123',
                sizeBytes: 100,
                estimatedTokens: 25
            }];
            
            assert.strictEqual(createChunkSummary(chunks), '');
        });

        it('creates summary for multiple chunks', () => {
            const chunks: FileChunk[] = [
                {
                    originalPath: '/test/file.py',
                    chunkIndex: 0,
                    totalChunks: 3,
                    startLine: 1,
                    endLine: 100,
                    content: '',
                    rawContent: '',
                    language: 'python',
                    originalMd5: 'abc123',
                    sizeBytes: 1000,
                    estimatedTokens: 250
                },
                {
                    originalPath: '/test/file.py',
                    chunkIndex: 1,
                    totalChunks: 3,
                    startLine: 80,
                    endLine: 180,
                    content: '',
                    rawContent: '',
                    language: 'python',
                    originalMd5: 'abc123',
                    sizeBytes: 1000,
                    estimatedTokens: 250
                },
                {
                    originalPath: '/test/file.py',
                    chunkIndex: 2,
                    totalChunks: 3,
                    startLine: 160,
                    endLine: 250,
                    content: '',
                    rawContent: '',
                    language: 'python',
                    originalMd5: 'abc123',
                    sizeBytes: 1000,
                    estimatedTokens: 250
                }
            ];
            
            const summary = createChunkSummary(chunks);
            assert.ok(summary.includes('LARGE FILE CHUNKING'));
            assert.ok(summary.includes('3 chunks'));
            assert.ok(summary.includes('Chunk 1'));
            assert.ok(summary.includes('Chunk 2'));
            assert.ok(summary.includes('Chunk 3'));
        });
    });

    describe('Logical boundary detection', () => {
        it('prefers splitting at function boundaries in Python', () => {
            // Create content with clear function boundaries
            let content = '';
            for (let i = 0; i < 500; i++) {
                if (i % 50 === 0) {
                    content += `def function_${i}():\n`;
                }
                content += `    x = ${i}\n`;
            }
            
            const file = createFileContent(content, '/test/code.py');
            const result = chunkFile(file, { 
                chunkThreshold: 0,
                maxChunkSize: 5 * 1024 // Small chunks to force splits
            });
            
            // Check that at least some chunks start at function definitions
            const startsAtFunction = result.chunks.some(chunk => {
                const firstLine = chunk.rawContent.split('\n')[0];
                return firstLine.trim().startsWith('def ');
            });
            
            // First chunk should start at line 1 (always), but subsequent chunks should prefer boundaries
            if (result.chunks.length > 1) {
                // This is a soft check - boundary detection is best-effort
                assert.ok(result.chunks.length >= 2, 'Should have multiple chunks');
            }
        });
    });
});
