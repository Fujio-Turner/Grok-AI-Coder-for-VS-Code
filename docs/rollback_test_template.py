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

# Change history for rollback
history = []

def get_md5(doc: dict) -> str:
    """Get MD5 hash of document state."""
    content = str(sorted(doc.items()))
    return hashlib.md5(content.encode()).hexdigest()

def save_state(doc: dict):
    """Save current state to history before making changes."""
    history.append(copy.deepcopy(doc))

def rollback(doc: dict) -> dict:
    """Rollback to previous state."""
    if history:
        return history.pop()
    return doc

def apply_change(doc: dict, func_name: str, new_code: str) -> dict:
    """Apply a change to a function."""
    save_state(doc)
    doc[func_name] = new_code
    print(f"  ✏️  Changed {func_name}: {new_code[:40]}...")
    return doc

# ============ RUN THE TEST ============

print("=" * 60)
print("ROLLBACK FEATURE TEST")
print("=" * 60)

# Create working copy
document = copy.deepcopy(original_document)

# Get original hash
original_hash = get_md5(document)
print(f"\n📄 Original MD5: {original_hash}")

# Simulate 5 user input changes
print("\n--- Applying 5 Changes ---")
fake_user_inputs = [
    ("func1", "def greet(): return 'Bonjour!'"),
    ("func2", "def add(a, b): return a + b + 100"),
    ("func3", "def multiply(a, b): return a * b * 2"),
    ("func4", "def is_even(n): return n % 2 != 0"),  # inverted logic
    ("func5", "def uppercase(s): return s.lower()"),  # opposite!
]

for func_name, new_code in fake_user_inputs:
    document = apply_change(document, func_name, new_code)

# Check hash after changes
changed_hash = get_md5(document)
print(f"\n📄 After changes MD5: {changed_hash}")
print(f"   Hashes match original? {original_hash == changed_hash}")

# Rollback all 5 changes
print("\n--- Rolling Back 5 Changes ---")
for i in range(5):
    document = rollback(document)
    print(f"  ↩️  Rollback {i + 1}/5 complete")

# Final hash check
final_hash = get_md5(document)
print(f"\n📄 Final MD5 (after rollbacks): {final_hash}")
print(f"\n{'=' * 60}")

if original_hash == final_hash:
    print("✅ SUCCESS: Document restored to original state!")
    print(f"   Original: {original_hash}")
    print(f"   Final:    {final_hash}")
else:
    print("❌ FAILURE: Hashes do not match!")
    print(f"   Original: {original_hash}")
    print(f"   Final:    {final_hash}")

print("=" * 60)
