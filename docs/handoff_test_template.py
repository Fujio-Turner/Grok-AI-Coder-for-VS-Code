"""
Handoff Feature Test Script
=============================

Tests the AI handoff mechanism by simulating a multi-step refactoring task
that requires updating 8 Python functions. The scenario:

1. Session 1: Updates functions 1-4, then triggers a handoff
2. Session 2: Receives handoff context and updates functions 5-8

TO TEST IN GROK AI CODER:
-------------------------
1. Open this file in VS Code
2. Tell the AI: "Refactor all 8 functions in this file to use type hints 
   and add docstrings. Do them one at a time, updating the TODO list as you go."
3. After the AI completes functions 1-4, say: "Create a handoff for the remaining work"
4. Start a new session from the handoff
5. Verify the new session has context about:
   - Which functions were already updated (1-4)
   - Which functions remain (5-8)
   - The project name and session summary

Expected handoff context should include:
- parentSessionId
- completedWork summary
- modifiedFiles list (this file)
- pendingTodos (functions 5-8)
- completedTodos (functions 1-4)
"""

# ============================================================================
# 📋 TODO LIST FOR AI:
# - [ ] Add type hints and docstring to calculate_area
# - [ ] Add type hints and docstring to calculate_perimeter
# - [ ] Add type hints and docstring to is_prime
# - [ ] Add type hints and docstring to factorial
# - [HANDOFF POINT - After completing above 4, create handoff]
# - [ ] Add type hints and docstring to fibonacci
# - [ ] Add type hints and docstring to reverse_string
# - [ ] Add type hints and docstring to count_vowels
# - [ ] Add type hints and docstring to find_max
# ============================================================================


# --- FUNCTION 1: calculate_area ---
def calculate_area(length, width):
    return length * width


# --- FUNCTION 2: calculate_perimeter ---
def calculate_perimeter(length, width):
    return 2 * (length + width)


# --- FUNCTION 3: is_prime ---
def is_prime(n):
    if n < 2:
        return False
    for i in range(2, int(n ** 0.5) + 1):
        if n % i == 0:
            return False
    return True


# --- FUNCTION 4: factorial ---
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


# ============================================================================
# ⚠️  HANDOFF POINT - Create handoff after completing functions 1-4 above
# ============================================================================


# --- FUNCTION 5: fibonacci ---
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)


# --- FUNCTION 6: reverse_string ---
def reverse_string(s):
    return s[::-1]


# --- FUNCTION 7: count_vowels ---
def count_vowels(s):
    count = 0
    for char in s.lower():
        if char in 'aeiou':
            count += 1
    return count


# --- FUNCTION 8: find_max ---
def find_max(numbers):
    if not numbers:
        return None
    max_val = numbers[0]
    for num in numbers[1:]:
        if num > max_val:
            max_val = num
    return max_val


# ============================================================================
# TEST RUNNER - Verifies all functions work correctly
# ============================================================================

def run_tests():
    """Run basic tests to verify all functions work."""
    print("=" * 60)
    print("HANDOFF TEST SCRIPT - Function Verification")
    print("=" * 60)
    
    tests_passed = 0
    tests_failed = 0
    
    # Test 1: calculate_area
    try:
        assert calculate_area(5, 3) == 15
        print("✅ calculate_area(5, 3) = 15")
        tests_passed += 1
    except AssertionError:
        print("❌ calculate_area FAILED")
        tests_failed += 1
    
    # Test 2: calculate_perimeter
    try:
        assert calculate_perimeter(5, 3) == 16
        print("✅ calculate_perimeter(5, 3) = 16")
        tests_passed += 1
    except AssertionError:
        print("❌ calculate_perimeter FAILED")
        tests_failed += 1
    
    # Test 3: is_prime
    try:
        assert is_prime(7) == True
        assert is_prime(4) == False
        print("✅ is_prime(7)=True, is_prime(4)=False")
        tests_passed += 1
    except AssertionError:
        print("❌ is_prime FAILED")
        tests_failed += 1
    
    # Test 4: factorial
    try:
        assert factorial(5) == 120
        print("✅ factorial(5) = 120")
        tests_passed += 1
    except AssertionError:
        print("❌ factorial FAILED")
        tests_failed += 1
    
    # Test 5: fibonacci
    try:
        assert fibonacci(10) == 55
        print("✅ fibonacci(10) = 55")
        tests_passed += 1
    except AssertionError:
        print("❌ fibonacci FAILED")
        tests_failed += 1
    
    # Test 6: reverse_string
    try:
        assert reverse_string("hello") == "olleh"
        print("✅ reverse_string('hello') = 'olleh'")
        tests_passed += 1
    except AssertionError:
        print("❌ reverse_string FAILED")
        tests_failed += 1
    
    # Test 7: count_vowels
    try:
        assert count_vowels("Hello World") == 3
        print("✅ count_vowels('Hello World') = 3")
        tests_passed += 1
    except AssertionError:
        print("❌ count_vowels FAILED")
        tests_failed += 1
    
    # Test 8: find_max
    try:
        assert find_max([3, 1, 4, 1, 5, 9, 2, 6]) == 9
        print("✅ find_max([3,1,4,1,5,9,2,6]) = 9")
        tests_passed += 1
    except AssertionError:
        print("❌ find_max FAILED")
        tests_failed += 1
    
    print("=" * 60)
    print(f"Results: {tests_passed} passed, {tests_failed} failed")
    print("=" * 60)
    
    return tests_failed == 0


if __name__ == "__main__":
    run_tests()
