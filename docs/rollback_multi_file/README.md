# Multi-File Rollback Test

## Purpose

This test validates that the AI can correctly update a function across multiple files, and that the rollback feature can revert all changes atomically.

## File Structure

```
rollback_multi_file/
├── base.py       # Contains the shared hello() function
├── greeter.py    # Imports and uses hello() for greeting
├── welcomer.py   # Imports and uses hello() for welcoming
├── original/     # Backup copies for manual reset
│   ├── base.original.py
│   ├── greeter.original.py
│   └── welcomer.original.py
└── README.md     # This file
```

## Original State

**base.py:**
```python
def hello(a="", b=""):
    print(a, b)
```

**greeter.py:**
```python
from base import hello

def greet_user():
    hello("Hello", "World")
```

**welcomer.py:**
```python
from base import hello

def welcome_guest():
    hello("Welcome", "Guest")
```

## Test Prompt

Copy and paste this prompt to test:

```
We need to update the scripts to print out a third value that's an INT. Can you update the code so that it prints all the data?
```

## Expected AI Response

The AI should update all 3 files:

**base.py** (updated):
```python
def hello(a="", b="", c=0):
    print(a, b)
    print(c)
```

**greeter.py** (updated):
```python
from base import hello

def greet_user():
    hello("Hello", "World", 42)

if __name__ == "__main__":
    greet_user()
```

**welcomer.py** (updated):
```python
from base import hello

def welcome_guest():
    hello("Welcome", "Guest", 100)

if __name__ == "__main__":
    welcome_guest()
```

## Rollback Test

1. **Apply Changes**: Let the AI update all 3 files
2. **Verify Changes**: Run `python greeter.py` and `python welcomer.py` - should print 3 values
3. **Test Rollback**: Click "Undo All" or undo each file change individually
4. **Verify Rollback**: All files should return to original 2-parameter state

## Success Criteria

- [ ] AI correctly identifies all 3 files need updating
- [ ] AI adds third parameter `c` to `hello()` function signature
- [ ] AI updates both caller files to pass a third argument
- [ ] Rollback reverts ALL files to original state
- [ ] After rollback, running scripts works with 2 parameters again

## Running the Scripts

```bash
cd docs/rollback_multi_file
python greeter.py   # Output: Hello World
python welcomer.py  # Output: Welcome Guest
```

After AI updates:
```bash
python greeter.py   # Output: Hello World\n42
python welcomer.py  # Output: Welcome Guest\n100
```

## Utility Commands

**Reset files to original state (manual rollback):**
```bash
cp original/base.original.py base.py && cp original/greeter.original.py greeter.py && cp original/welcomer.original.py welcomer.py
```

**Check MD5 checksums of all files:**
```bash
md5 base.py greeter.py welcomer.py
```

**Compare current vs original checksums:**
```bash
md5 base.py greeter.py welcomer.py original/*.py
```
