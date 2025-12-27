import * as assert from 'assert';

/**
 * Unit tests for diff application functions.
 * These test the enhanced applySimpleDiff and applyUnifiedDiff from codeActions.ts
 */

// Recreate the functions for testing without vscode dependency

function applyUnifiedDiff(originalContent: string, diffContent: string): string {
    const originalLines = originalContent.split('\n');
    const diffLines = diffContent.split('\n');
    const resultLines: string[] = [];
    
    let originalIndex = 0;
    let inHunk = false;
    let hunkStartLine = 0;
    
    for (const line of diffLines) {
        if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+)/);
            if (match) {
                hunkStartLine = parseInt(match[1], 10) - 1;
                while (originalIndex < hunkStartLine && originalIndex < originalLines.length) {
                    resultLines.push(originalLines[originalIndex]);
                    originalIndex++;
                }
            }
            inHunk = true;
            continue;
        }
        
        if (!inHunk) {
            continue;
        }
        
        if (line.startsWith('-')) {
            originalIndex++;
        } else if (line.startsWith('+')) {
            resultLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            resultLines.push(originalLines[originalIndex] || line.substring(1));
            originalIndex++;
        } else {
            resultLines.push(originalLines[originalIndex] || line);
            originalIndex++;
        }
    }
    
    while (originalIndex < originalLines.length) {
        resultLines.push(originalLines[originalIndex]);
        originalIndex++;
    }
    
    return resultLines.join('\n');
}

function applySimpleDiff(originalContent: string, diffContent: string): string {
    const diffLines = diffContent.split('\n');
    const resultLines: string[] = [];
    
    if (!diffContent || diffContent.trim() === '') {
        console.warn('[Test] Empty diff content, returning original');
        return originalContent;
    }
    
    const addLines = diffLines.filter(l => l.startsWith('+'));
    const removeLines = diffLines.filter(l => l.startsWith('-'));
    const contextLines = diffLines.filter(l => l.startsWith(' '));
    const hasHunkHeaders = diffLines.some(l => l.startsWith('@@'));
    
    if (hasHunkHeaders) {
        return applyUnifiedDiff(originalContent, diffContent);
    }
    
    const hasOnlyAddRemove = diffLines.every(line => 
        line.startsWith('+') || line.startsWith('-') || line.trim() === ''
    );
    
    if (hasOnlyAddRemove) {
        for (const line of diffLines) {
            if (line.startsWith('+')) {
                resultLines.push(line.substring(1));
            }
        }
        
        if (resultLines.length === 0 && addLines.length > 0) {
            console.warn('[Test] Diff produced empty result, checking for issues');
        }
        
        return resultLines.join('\n');
    }
    
    // Has context lines but no @@ headers
    const originalLines = originalContent.split('\n');
    
    // Extract context lines to find match location
    const firstContextLines: string[] = [];
    for (const line of diffLines) {
        if (line.startsWith(' ')) {
            firstContextLines.push(line.substring(1));
        } else if (!line.startsWith('+') && !line.startsWith('-') && line.trim() !== '') {
            firstContextLines.push(line);
        }
        if (firstContextLines.length >= 3) break;
    }
    
    let matchIndex = -1;
    if (firstContextLines.length > 0) {
        for (let i = 0; i < originalLines.length; i++) {
            let matches = true;
            for (let j = 0; j < firstContextLines.length && i + j < originalLines.length; j++) {
                if (originalLines[i + j].trim() !== firstContextLines[j].trim()) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                matchIndex = i;
                break;
            }
        }
    }
    
    if (matchIndex === -1) {
        for (const line of diffLines) {
            if (line.startsWith('+')) {
                resultLines.push(line.substring(1));
            } else if (line.startsWith(' ')) {
                resultLines.push(line.substring(1));
            } else if (!line.startsWith('-') && line.trim() !== '') {
                resultLines.push(line);
            }
        }
        
        if (resultLines.length === 0) {
            return originalContent;
        }
        
        return resultLines.join('\n');
    }
    
    let originalIdx = 0;
    let diffIdx = 0;
    
    while (originalIdx < matchIndex) {
        resultLines.push(originalLines[originalIdx]);
        originalIdx++;
    }
    
    while (diffIdx < diffLines.length) {
        const line = diffLines[diffIdx];
        
        if (line.startsWith('-')) {
            originalIdx++;
            diffIdx++;
        } else if (line.startsWith('+')) {
            resultLines.push(line.substring(1));
            diffIdx++;
        } else if (line.startsWith(' ')) {
            resultLines.push(originalLines[originalIdx] || line.substring(1));
            originalIdx++;
            diffIdx++;
        } else if (line.trim() === '') {
            diffIdx++;
        } else {
            resultLines.push(originalLines[originalIdx] || line);
            originalIdx++;
            diffIdx++;
        }
    }
    
    while (originalIdx < originalLines.length) {
        resultLines.push(originalLines[originalIdx]);
        originalIdx++;
    }
    
    return resultLines.join('\n');
}

describe('applySimpleDiff', () => {
    it('applies pure +/- diff correctly', () => {
        const original = `line1
line2
line3`;
        const diff = `-line2
+line2modified`;
        
        const result = applySimpleDiff(original, diff);
        assert.strictEqual(result, 'line2modified');
    });

    it('returns original for empty diff', () => {
        const original = 'original content';
        assert.strictEqual(applySimpleDiff(original, ''), original);
        assert.strictEqual(applySimpleDiff(original, '   '), original);
    });

    it('handles diff with only additions', () => {
        const original = '';
        const diff = `+new line 1
+new line 2`;
        
        const result = applySimpleDiff(original, diff);
        assert.strictEqual(result, 'new line 1\nnew line 2');
    });

    it('handles unified diff with @@ headers', () => {
        const original = `line1
line2
line3
line4
line5`;
        
        const diff = `@@ -2,2 +2,2 @@
 line2
-line3
+line3modified
 line4`;
        
        const result = applySimpleDiff(original, diff);
        assert.ok(result.includes('line3modified'));
        assert.ok(!result.includes('\nline3\n'));
    });
});

describe('applyUnifiedDiff', () => {
    it('applies basic unified diff', () => {
        const original = `function greet() {
    return "hello";
}`;
        
        const diff = `@@ -1,3 +1,4 @@
 function greet() {
-    return "hello";
+    const msg = "hello";
+    return msg;
 }`;
        
        const result = applyUnifiedDiff(original, diff);
        assert.ok(result.includes('const msg = "hello"'));
        assert.ok(result.includes('return msg'));
    });

    it('handles multiple hunks', () => {
        const original = `line1
line2
line3
line4
line5
line6
line7`;
        
        const diff = `@@ -1,2 +1,2 @@
-line1
+LINE1
 line2
@@ -6,2 +6,2 @@
 line6
-line7
+LINE7`;
        
        const result = applyUnifiedDiff(original, diff);
        assert.ok(result.startsWith('LINE1'));
        assert.ok(result.endsWith('LINE7'));
    });

    it('preserves lines before first hunk', () => {
        const original = `header1
header2
content1
content2`;
        
        const diff = `@@ -3,2 +3,2 @@
-content1
+CONTENT1
 content2`;
        
        const result = applyUnifiedDiff(original, diff);
        assert.ok(result.startsWith('header1\nheader2'));
        assert.ok(result.includes('CONTENT1'));
    });

    it('preserves lines after last hunk', () => {
        const original = `line1
line2
line3
footer1
footer2`;
        
        const diff = `@@ -2,1 +2,1 @@
-line2
+LINE2`;
        
        const result = applyUnifiedDiff(original, diff);
        assert.ok(result.includes('LINE2'));
        assert.ok(result.endsWith('footer1\nfooter2'));
    });
});

describe('Diff edge cases', () => {
    it('handles diff that would make content identical', () => {
        const original = 'same content';
        const diff = `+same content`;
        
        const result = applySimpleDiff(original, diff);
        assert.strictEqual(result, 'same content');
    });

    it('handles multi-line function replacement', () => {
        const original = `def calculate_area(length, width):
    return length * width`;
        
        const diff = `-def calculate_area(length, width):
-    return length * width
+def calculate_area(length: float, width: float) -> float:
+    """Calculate area of rectangle."""
+    return length * width`;
        
        const result = applySimpleDiff(original, diff);
        assert.ok(result.includes('length: float'));
        assert.ok(result.includes('"""Calculate area'));
    });

    it('handles empty lines in diff', () => {
        const original = '';
        const diff = `+line1
+
+line3`;
        
        const result = applySimpleDiff(original, diff);
        assert.strictEqual(result, 'line1\n\nline3');
    });
});
