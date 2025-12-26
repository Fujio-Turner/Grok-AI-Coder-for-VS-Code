# Rollback Test - User Prompts

**Test files:**
- `rollback_test_template.py` - Original template (never modify)
- `rollback_test.py` - Working copy (gets modified during test)

This tests the change history and rollback feature by making 5 sequential changes, then rolling them all back. Also tests CRU (Create, Read, Update) operations.

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
| "terminated" error | Wait 30s, try again (rate limiting) |
| `contextFiles: []` | File not in workspace - copy it there |
| AI does all steps at once | Repeat "ONLY do one change, then STOP" |
| AI creates new file | Say "MODIFY the existing file, don't create new" |
| File already modified | Reset from template (see above) |

---

## Step 1: Find File and Start the Task

**User Prompt:**
```
Find the rollback test file and MODIFY its original_document dict. I need to make 5 changes total.

IMPORTANT RULES:
1. Do ONLY ONE change per response (start with greet → "Bonjour!")
2. After completing ONE change, STOP and wait for me to say "continue"
3. Do NOT create new files - modify the existing file directly

Change 1: In original_document, change greet to return "Bonjour!" instead of "Hello"
```

**Expected Result:**
- AI finds `rollback_test.py` using file search (OS-agnostic)
- Loads the file content
- Modifies ONLY the greet function in original_document
- Line 10 modified: `"func1": "def greet(): return 'Bonjour!'"`
- Change History shows: Change #1 - 1 file
- Waits for user to say "continue"

---

## Step 2: Second Change

**User Prompt:**
```
continue
```

**Expected Result:**
- AI changes add function to return `a + b + 100`
- Line 11 modified: `"func2": "def add(a, b): return a + b + 100"`
- Change History shows: Change #2 - 1 file

---

## Step 3: Third Change

**User Prompt:**
```
continue
```

**Expected Result:**
- AI changes multiply function to return `a * b * 2`
- Line 12 modified: `"func3": "def multiply(a, b): return a * b * 2"`
- Change History shows: Change #3 - 1 file

---

## Step 4: Fourth Change

**User Prompt:**
```
continue
```

**Expected Result:**
- AI changes is_even to check `n % 2 != 0` (inverted logic)
- Line 13 modified: `"func4": "def is_even(n): return n % 2 != 0"`
- Change History shows: Change #4 - 1 file

---

## Step 5: Fifth Change

**User Prompt:**
```
continue
```

**Expected Result:**
- AI changes uppercase to use `.lower()` instead of `.upper()`
- Line 14 modified: `"func5": "def uppercase(s): return s.lower()"`
- Change History shows: Change #5 - 1 file

---

## Verification: All Changes Applied

At this point, `original_document` should look like:
```python
original_document = {
    "func1": "def greet(): return 'Bonjour!'",
    "func2": "def add(a, b): return a + b + 100",
    "func3": "def multiply(a, b): return a * b * 2",
    "func4": "def is_even(n): return n % 2 != 0",
    "func5": "def uppercase(s): return s.lower()"
}
```

---

## Rollback Testing

### Rollback 1

**User Action:**
Click the **◀ Rewind** button in Change History panel, or click on Change #4

**Expected Result:**
- Change #5 reverted (uppercase back to `.upper()`)
- Position indicator moves to Change #4

### Rollback 2-5

**User Action:**
Continue clicking **◀ Rewind** until at original state

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
```

---

## What This Tests

| Feature | Tested |
|---------|--------|
| Change tracking | ✅ 5 changes recorded |
| Diff stats | ✅ +/- lines shown |
| Rollback UI | ✅ Rewind button works |
| Content restoration | ✅ Original content restored |
| Couchbase persistence | ✅ History saved to session |
