# Failing Test Cases - JSON Helper

> **Status Update (Dec 26, 2025):** 3 of 4 tests have been FIXED. Only Test 5 remains failing.

~~These 4 test cases~~ **1 test case** in `jsonHelper.unit.test.ts` is currently failing. 

## ✅ FIXED Tests (3 of 4)

The following tests now pass after adding FIX 0d2 to `repairJson()`:
- ✅ Test 1: `should fix missing opening quote for content field`
- ✅ Test 2: `should fix missing opening quote for heading field`
- ✅ Test 3: `should handle the sections content missing quote example`
- ✅ Test 4: `should handle combined empty heading key and unquoted content`

---

## ❌ Still Failing (1 test)

### Test 5: The "exact user example" - Complex multi-error JSON

**Test Name:** `should handle the exact user example`

**Line:** 235-251

This is an extremely complex edge case with **6+ simultaneous JSON errors**:

```json
{
"todos": [
{ "text": "Locate files",completed": false },           // missing " before completed
"text": "Review", "completed": false { "text":Check",   // missing { at start, missing " after :
{ "text "Verify", "completed": }                        // missing : after text, empty completed
],
"": "# Review",                                          // empty key
"nextSteps": ["Open files"]
}
```

**Why it's hard to fix:** The repair function handles each error type in sequence, but this test has so many overlapping issues that the intermediate repairs create invalid states that subsequent repairs can't handle correctly.

**Recommendation:** This is a known limitation. For such severely malformed JSON, the model cleanup fallback (`cleanJsonWithModel`) should be used instead.

---

## ✅ Previously Documented (Now Fixed)

---

## Test 1: Missing opening quote for `content` field

**Test Name:** `should fix missing opening quote for content field`

**Line:** 295-301

**Broken Input:**
```json
{"sections":[{"heading":"Strengths","content":Excellent coverage of patterns.}]}
```

**Problem:** The value for `content` is missing its opening quote:
- `"content":Excellent` should be `"content":"Excellent`

**Expected Fix:** The `repairJson` function should detect unquoted string values after a colon and add the missing quote.

**Pattern to detect:**
```
"content":X  →  "content":"X
```
Where `X` is a letter (not `"`, `{`, `[`, `true`, `false`, `null`, or a digit).

---

## Test 2: Missing opening quote for `heading` field

**Test Name:** `should fix missing opening quote for heading field`

**Line:** 303-309

**Broken Input:**
```json
{"sections":[{"heading":Overview of the code,"content":"Details here."}]}
```

**Problem:** The value for `heading` is missing its opening quote:
- `"heading":Overview` should be `"heading":"Overview`

**Expected Fix:** Same as Test 1 - detect unquoted string values and add opening quote.

**Additional Challenge:** Need to find where the value ends (at the comma before `"content"`).

---

## Test 3: Real-world example with missing quote in `content`

**Test Name:** `should handle the sections content missing quote example`

**Line:** 311-320

**Broken Input:**
```json
{"summary": "Review done", "sections": [{"heading": "Strengths", "content":Excellent comprehensive coverage of replica read patterns.}]}
```

**Problem:** Same as Test 1, but in a more complete response structure.

**Expected Output:**
```json
{
  "summary": "Review done",
  "sections": [{
    "heading": "Strengths",
    "content": "Excellent comprehensive coverage of replica read patterns."
  }]
}
```

---

## Test 4: Combined - empty key AND missing quote

**Test Name:** `should handle combined empty heading key and unquoted content`

**Line:** 332-340

**Broken Input:**
```json
{"sections": [{"": "Strengths", "content":Excellent structure with examples.}]}
```

**Problems (2 issues):**
1. Empty key `""` should be `"heading"`
2. `"content":Excellent` missing opening quote

**Expected Output:**
```json
{
  "sections": [{
    "heading": "Strengths",
    "content": "Excellent structure with examples."
  }]
}
```

---

## Suggested Fix

Add this repair pattern to `repairJson()` in `src/prompts/jsonHelper.ts`:

```typescript
// Fix missing opening quote for string values
// Pattern: "key":UnquotedValue  →  "key":"UnquotedValue
// Where UnquotedValue starts with a letter (not ", {, [, true, false, null, or digit)
json = json.replace(/"(heading|content|summary|message|text|description)":\s*([A-Za-z][^,}\]]*?)([,}\]])/g, 
    '"$1":"$2"$3');
```

**Regex explanation:**
- `"(heading|content|...)":` - matches known string field names
- `\s*` - optional whitespace after colon
- `([A-Za-z][^,}\]]*?)` - captures unquoted value starting with letter, up to delimiter
- `([,}\]])` - captures the delimiter (comma, close brace, or close bracket)

---

## How to Run These Tests

```bash
npm test
```

Or specifically:
```bash
npm run compile && mocha 'out/test/unit/jsonHelper.unit.test.js' --timeout 10000
```
