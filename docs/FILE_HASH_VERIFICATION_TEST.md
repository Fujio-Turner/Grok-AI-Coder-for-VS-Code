# File Hash Verification Test

This document walks through testing the new MD5 hash verification feature that ensures the AI has actually read file content before attempting modifications.

## The Core Problem: AI Cannot Read Files

**The AI does NOT have filesystem access.** It can only see files that are:
1. Attached to the conversation by the user
2. Pasted directly into the chat message
3. **Loaded by the Agent Workflow (Pass 2)** - when the planning step identifies files to load

When the AI claims to "read a file" without it being attached, it is **hallucinating**. For example:

```
User: "What's the MD5 of rollback_test.py?"
AI: "The MD5 is 9b8f8d0a2e4b5c6d7e8f9a0b1c2d3e4f" ← FAKE!
Actual: 9a906fd5909d29c5f1d228db1eaa90c4
```

## The Problem With LineOperations

When the AI uses `lineOperations` to modify a file, it must provide `expectedContent` for validation. However, the AI sometimes **hallucinates** file content - it guesses what the file contains without actually reading it. This causes:

1. **Failed operations** - expectedContent doesn't match actual content
2. **Broken rollback** - no actual changes were made, so nothing to roll back
3. **User confusion** - appears the AI made changes but nothing happened

## The Solution

The extension computes MD5 hashes when files are loaded and includes them in the augmented message sent to the AI. The AI must echo these hashes back when modifying files.

**How it works:**

1. **Pass 2 (File Loading)**: Extension reads files and computes MD5 hashes
2. **Augmented Message**: Each file is sent with its hash: `### file.py [MD5: 9a906fd...]`
3. **AI Response**: AI must include `fileHashes` field echoing the hash it was given
4. **Verification**: Extension compares provided hash with current file hash
5. **Apply/Block**: If match → apply, if mismatch → BLOCK

This prevents:
- AI hallucinating file content (it can only echo hashes it was given)
- Stale modifications (if file changed, hash won't match)

---

## Test Procedure

### Step 1: Create a Simple Test File

Create `/docs/rollback_test.py` with this content:

```python
"""
Rollback Feature Test Script
Tests that after 5 changes and 5 rollbacks, the document returns to original state.
"""
import hashlib
import copy

# The "document" - a simple dict representing code with 5 functions
original_document = {
    "func1": "def greet(): return 'Hello'",
    "func2": "def add(a, b): return a + b",
    "func3": "def multiply(a, b): return a * b",
    "func4": "def is_even(n): return n % 2 == 0",
    "func5": "def uppercase(s): return s.upper()"
}

def get_md5(doc: dict) -> str:
    """Get MD5 hash of document state."""
    content = str(sorted(doc.items()))
    return hashlib.md5(content.encode()).hexdigest()

print(f"Original MD5: {get_md5(original_document)}")
```

### Step 2: Ask the AI to Read and Hash

Send this prompt to the AI:

```
Read the file docs/rollback_test.py and tell me:
1. The MD5 hash of the file content
2. What line 10 contains
3. What line 14 contains
```

### Step 3: Verify the Response

The AI response should include a `fileHashes` field:

```json
{
  "summary": "I've read the rollback test file.",
  "fileHashes": {
    "docs/rollback_test.py": "abc123def456..."
  },
  "sections": [...]
}
```

### Step 4: Compare Hashes

Calculate the actual MD5 of the file:

```bash
md5 docs/rollback_test.py
# or on Linux:
md5sum docs/rollback_test.py
```

If the hashes match → AI actually read the file ✅
If the hashes differ → AI hallucinated ❌

---

## Expected AI Response Format

When the AI reads files for modification, it MUST include:

```json
{
  "summary": "Modified the greeting function.",
  "fileHashes": {
    "docs/rollback_test.py": "9a906fd5909d29c5f1d228db1eaa90c4"
  },
  "fileChanges": [{
    "path": "docs/rollback_test.py",
    "language": "python",
    "content": "",
    "lineOperations": [
      {"type": "replace", "line": 10, "expectedContent": "\"func1\": \"def greet(): return 'Hello'\",", "newContent": "\"func1\": \"def greet(): return 'Bonjour!'\","}
    ]
  }]
}
```

---

## Verification Logic (Extension Side)

```typescript
// Before applying lineOperations:
if (fc.lineOperations && fc.lineOperations.length > 0) {
    const filePath = fc.path;
    const providedHash = response.fileHashes?.[filePath];
    
    // Read actual file and compute hash
    const actualContent = await readFile(filePath);
    const actualHash = crypto.createHash('md5').update(actualContent).digest('hex');
    
    if (!providedHash) {
        // AI didn't provide hash - reject
        showError(`AI did not provide hash for ${filePath}. File may not have been read.`);
        return null;
    }
    
    if (providedHash !== actualHash) {
        // Hash mismatch - AI has stale/wrong content
        showError(`Hash mismatch for ${filePath}. AI has outdated content.`);
        return null;
    }
    
    // Hash matches - proceed with operations
    applyLineOperations(fc.lineOperations);
}
```

---

## Test Cases

| Scenario | Expected Result |
|----------|-----------------|
| AI provides correct hash | Operations applied ✅ |
| AI provides wrong hash | Operations rejected with "Hash mismatch" |
| AI provides no hash | Operations rejected with "No hash provided" |
| AI provides empty string hash | Operations rejected with "Invalid hash" |
| File changed after AI read it | Operations rejected with "Hash mismatch" |

---

## Implementation Checklist

- [x] Add `fileHashes` to response schema (`responseSchema.ts`)
- [x] Update system prompt to require hashes for any file being modified (`systemPrompt.ts`)
- [x] Compute MD5 when reading files (`workspaceFiles.ts`)
- [x] Include hash in augmented message (`agentOrchestrator.ts`)
- [x] Add hash verification in ChatViewProvider before lineOperations
- [x] Add clear error messages for hash failures
- [x] Log hash mismatches to Couchbase for debugging (`operationType: 'hashMismatch' | 'noHash'`)
- [x] Report failed file searches in augmented message
- [x] Improve rollback error handling for failed changes
- [ ] Test with real AI interactions

## Files Modified

| File | Changes |
|------|---------|
| `src/prompts/responseSchema.ts` | Added `fileHashes?: Record<string, string>` field |
| `src/prompts/systemPrompt.ts` | Added "YOU CANNOT READ FILES FROM DISK" warning, `fileHashes` requirement |
| `src/agent/workspaceFiles.ts` | Added `md5Hash` to `FileContent`, `computeMd5Hash()` function |
| `src/agent/actionTypes.ts` | Added `fileHashes: Map<string, string>` to `ExecutionResult` |
| `src/agent/agentOrchestrator.ts` | Store hashes in Pass 2, include `[MD5: hash]` in augmented message, report failed searches |
| `src/views/ChatViewProvider.ts` | Hash verification before `lineOperations`, clear error messages |
| `src/edits/codeActions.ts` | Rollback detects failed changes, shows warning |
| `src/storage/chatSessionRepository.ts` | Added `hashMismatch` and `noHash` operation types |
