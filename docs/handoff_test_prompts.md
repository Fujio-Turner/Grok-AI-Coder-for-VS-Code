# Handoff Test - User Prompts

**Test files:**
- `handoff_test_template.py` - Original template (never modify)
- `handoff_test.py` - Working copy (gets modified during test)

This tests the session handoff mechanism by refactoring 8 functions across two sessions, with a handoff in the middle. Also tests CRU (Create, Read, Update) operations.

---

## 🔄 Reset Before Each Test (Manual)

Before starting a new test session, reset the working file:
```bash
cp handoff_test_template.py handoff_test.py
```

---

## ⚠️ Troubleshooting

| Issue | Solution |
|-------|----------|
| "terminated" error | Wait 30s, try again (rate limiting) |
| `contextFiles: []` | File not in workspace - copy it there |
| AI does all steps at once | Repeat "ONLY do one function, then STOP" |
| AI creates new file | Say "MODIFY the existing file, don't create new" |
| File already modified | Reset from template (see above) |

---

## Session 1: Functions 1-4

### Step 1: Find File and Start the Task

**User Prompt:**
```
Find the handoff test file and MODIFY it to add type hints and docstrings to the 8 functions.

IMPORTANT RULES:
1. Do ONLY ONE function per response (start with calculate_area)
2. After completing ONE function, STOP and wait for me to say "continue"
3. Create a TODO list showing all 8 functions
4. Do NOT create new files - modify the existing file directly

Start now with calculate_area only.
```

**Expected Result:**
- AI finds `handoff_test.py` using file search (OS-agnostic)
- Loads the file content
- Creates TODO list with all 8 functions
- Modifies ONLY `calculate_area` with type hints and docstring
- TODO list shows: 1/8 complete
- Waits for user to say "continue"
- File change applied

**Expected Code:**
```python
def calculate_area(length: float, width: float) -> float:
    """Calculate the area of a rectangle.
    
    Args:
        length: The length of the rectangle.
        width: The width of the rectangle.
    
    Returns:
        The area (length × width).
    """
    return length * width
```

---

### Step 2: Second Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `calculate_perimeter` updated with type hints and docstring
- TODO list shows: 2/8 complete

---

### Step 3: Third Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `is_prime` updated with type hints and docstring
- TODO list shows: 3/8 complete

---

### Step 4: Fourth Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `factorial` updated with type hints and docstring
- TODO list shows: 4/8 complete
- This is the halfway point

---

### Step 5: Create Handoff

**User Prompt:**
```
Create a handoff for the remaining work. I need to continue this in a new session.
```

**Expected Result:**
- Handoff created with:
  - Summary of completed work (functions 1-4)
  - List of modified files (`handoff_test.py`)
  - Pending TODOs (functions 5-8)
  - Completed TODOs (functions 1-4)
- New session link/button appears

---

## Session 2: Functions 5-8 (From Handoff)

### Step 6: Start Handoff Session

**User Action:**
1. Click "Start New Session" from the handoff
2. The new session should auto-populate with handoff context

**Expected Prefill Text:**
```
Continue from handoff. Pending tasks:
- [ ] Add type hints and docstring to fibonacci
- [ ] Add type hints and docstring to reverse_string
- [ ] Add type hints and docstring to count_vowels
- [ ] Add type hints and docstring to find_max

Files: handoff_test.py
```

**User Prompt:**
```
Continue from handoff. There are 4 remaining functions (fibonacci, reverse_string, count_vowels, find_max) that need type hints and docstrings. Do them ONE AT A TIME - start with fibonacci, then wait for me to say "continue".
```

> **Note:** Re-establish the incremental workflow for the new session.

**Expected Result:**
- AI acknowledges the handoff context
- Shows it knows functions 1-4 are already done
- Updates `fibonacci` with type hints and docstring
- TODO list shows: 5/8 complete (or 1/4 remaining)

---

### Step 7: Sixth Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `reverse_string` updated with type hints and docstring
- TODO list shows: 6/8 complete

---

### Step 8: Seventh Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `count_vowels` updated with type hints and docstring
- TODO list shows: 7/8 complete

---

### Step 9: Final Function

**User Prompt:**
```
continue
```

**Expected Result:**
- `find_max` updated with type hints and docstring
- TODO list shows: 8/8 complete ✅
- AI indicates task is fully complete

---

## Final Verification

**User Prompt:**
```
Run python handoff_test.py to verify all functions still work correctly
```

**Expected Output:**
```
============================================================
HANDOFF TEST SCRIPT - Function Verification
============================================================
✅ calculate_area(5, 3) = 15
✅ calculate_perimeter(5, 3) = 16
✅ is_prime(7)=True, is_prime(4)=False
✅ factorial(5) = 120
✅ fibonacci(10) = 55
✅ reverse_string('hello') = 'olleh'
✅ count_vowels('Hello World') = 3
✅ find_max([3,1,4,1,5,9,2,6]) = 9
============================================================
Results: 8 passed, 0 failed
============================================================
```

---

## What This Tests

| Feature | Session 1 | Session 2 |
|---------|-----------|-----------|
| Multi-step execution | ✅ 4 steps | ✅ 4 steps |
| TODO tracking | ✅ Progress 1-4/8 | ✅ Progress 5-8/8 |
| Handoff creation | ✅ Triggered | - |
| Handoff context | - | ✅ Received |
| Modified files list | - | ✅ Shows `handoff_test.py` |
| Pending TODOs | - | ✅ Shows 4 remaining |
| Completed TODOs | - | ✅ Shows 4 done |
| Parent session link | - | ✅ References original |
| Change history | ✅ 4 changes | ✅ 4 more changes |

---

## Handoff Context Verification

After creating the handoff in Step 5, check Couchbase for the handoff document structure:

```json
{
  "handoff": {
    "parentId": "session-uuid-1",
    "createdAt": "2025-12-26T...",
    "completedWork": "Added type hints and docstrings to calculate_area, calculate_perimeter, is_prime, and factorial functions.",
    "modifiedFiles": ["docs/handoff_test.py"],
    "pendingTodos": [
      {"text": "Add type hints and docstring to fibonacci", "completed": false},
      {"text": "Add type hints and docstring to reverse_string", "completed": false},
      {"text": "Add type hints and docstring to count_vowels", "completed": false},
      {"text": "Add type hints and docstring to find_max", "completed": false}
    ],
    "completedTodos": [
      {"text": "Add type hints and docstring to calculate_area", "completed": true},
      {"text": "Add type hints and docstring to calculate_perimeter", "completed": true},
      {"text": "Add type hints and docstring to is_prime", "completed": true},
      {"text": "Add type hints and docstring to factorial", "completed": true}
    ]
  }
}
```

---

## Error Tracking Verification

Check the Error Dashboard after both sessions to verify:

1. **No truncation bugs** - Each step was small enough
2. **CLI executions logged** - The `python handoff_test.py` command should appear
3. **No JSON parse failures** - Responses parsed cleanly

Dashboard URL: `http://localhost:5050`
