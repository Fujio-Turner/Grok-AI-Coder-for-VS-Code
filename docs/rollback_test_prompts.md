# Rollback Test - User Prompts

**Test files:**
- `rollback_test_template.py` - Original template (never modify)
- `rollback_test.py` - Working copy (gets modified during test)

This tests the change history and rollback feature by making 5 sequential changes, then rolling them all back.

---

## 🔄 Reset Before Each Test (Manual)

Before starting a new test session, reset the working file:
```bash
cp rollback_test_template.py rollback_test.py
```

---

## ⚠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| "terminated" error | Check `grok.useFilesApi` is `false` in settings |
| AI does all steps at once | Be firm: "STOP after this one change" |
| AI creates new file | Say "MODIFY the existing file, don't create new" |
| AI asks for file | Attach rollback_test.py with backtick (\`) |
| Hash mismatch error | File was modified since AI read it - re-attach |

---

## The 5 Changes (Reference)

The test modifies `original_document` dict in `rollback_test.py`:

| Change | Line | Original | Modified To |
|--------|------|----------|-------------|
| 1 | 10 | `return 'Hello'` | `return 'Bonjour!'` |
| 2 | 11 | `return a + b` | `return a + b + 100` |
| 3 | 12 | `return a * b` | `return a * b * 2` |
| 4 | 13 | `n % 2 == 0` | `n % 2 != 0` |
| 5 | 14 | `s.upper()` | `s.lower()` |

---

## Step 1: Initial Prompt (All Changes Specified)

**User Prompt:**
```
Find the rollback test file and MODIFY its original_document dict. 

I need you to make these 5 changes, ONE AT A TIME:
1. func1 greet: change 'Hello' → 'Bonjour!'
2. func2 add: change 'a + b' → 'a + b + 100'
3. func3 multiply: change 'a * b' → 'a * b * 2'
4. func4 is_even: change 'n % 2 == 0' → 'n % 2 != 0'
5. func5 uppercase: change '.upper()' → '.lower()'

IMPORTANT RULES:
- Do ONLY change #1 now
- After applying ONE change, STOP and wait for me to say "continue"
- Do NOT create new files - modify the existing rollback_test.py directly

Start with change #1: In original_document, change greet to return "Bonjour!" instead of "Hello"
```

**Expected Result:**
- AI finds `rollback_test.py`
- Modifies ONLY line 10: `"func1": "def greet(): return 'Bonjour!'"`
- Change History shows: Change #1 - 1 file, modified: 1
- AI stops and waits

---

## Steps 2-5: Continue with Remaining Changes

**User Prompt:**
```
continue
```

Repeat "continue" for each remaining change. The AI knows the full plan from Step 1.

**Expected Results:**

| Step | Line Modified | New Value |
|------|---------------|-----------|
| 2 | 11 | `"def add(a, b): return a + b + 100"` |
| 3 | 12 | `"def multiply(a, b): return a * b * 2"` |
| 4 | 13 | `"def is_even(n): return n % 2 != 0"` |
| 5 | 14 | `"def uppercase(s): return s.lower()"` |

---

## Verification: All Changes Applied

After all 5 changes, `original_document` should look like:
```python
original_document = {
    "func1": "def greet(): return 'Bonjour!'",
    "func2": "def add(a, b): return a + b + 100",
    "func3": "def multiply(a, b): return a * b * 2",
    "func4": "def is_even(n): return n % 2 != 0",
    "func5": "def uppercase(s): return s.lower()"
}
```

Change History panel should show 5 separate entries.

---

## Rollback Testing

### Rollback All Changes

**User Action:**
Click the **◀ Rewind** button in Change History panel 5 times, or click directly on the earliest entry.

**Expected Result After All Rollbacks:**
```python
original_document = {
    "func1": "def greet(): return 'Hello'",
    "func2": "def add(a, b): return a + b",
    "func3": "def multiply(a, b): return a * b",
    "func4": "def is_even(n): return n % 2 == 0",
    "func5": "def uppercase(s): return s.upper()"
}
```

---

## Final Verification

**User Prompt:**
```
Run the rollback_test.py script to verify the document is back to original state
```

**Expected Output:**
```
✅ SUCCESS: Document restored to original state!
   Original: <hash>
   Final:    <hash>
```

---

## What This Tests

| Feature | Tested |
|---------|--------|
| File search | ✅ AI finds file in workspace |
| lineOperations | ✅ Single-line replacements |
| Hash verification | ✅ AI must provide correct file hash |
| Change tracking | ✅ 5 separate changes recorded |
| Diff stats | ✅ modified: 1 for each change |
| Rollback UI | ✅ Rewind button works |
| Content restoration | ✅ Original content restored |
| Couchbase persistence | ✅ History saved to session |

---

## Alternative: Single-Shot Test (All 5 at Once)

If you want to test applying all changes in one request:

**User Prompt:**
```
Find rollback_test.py and modify original_document with ALL these changes at once:
1. func1: 'Hello' → 'Bonjour!'
2. func2: 'a + b' → 'a + b + 100'
3. func3: 'a * b' → 'a * b * 2'
4. func4: 'n % 2 == 0' → 'n % 2 != 0'
5. func5: '.upper()' → '.lower()'
```

This creates a single Change History entry with all 5 modifications.
