# Bug Reporting System

The Grok AI Coder extension includes a built-in bug tracking system to capture malformed AI responses, parsing failures, and other issues. This creates a feedback loop for continuous improvement.

## Bug Report Structure

Each bug report is stored in the session document with the following structure:

```json
{
  "bugs": [
    {
      "id": "uuid",
      "type": "HTML | CSS | JSON | JS | TypeScript | Markdown | SQL | Other",
      "pairIndex": 0,
      "by": "user | script",
      "description": "Description of the bug",
      "timestamp": "2025-12-23T20:00:00.000Z",
      "resolved": false
    }
  ]
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (UUID) |
| `type` | BugType | Category of the bug |
| `pairIndex` | number | Index in the `pairs[]` array where the bug occurred |
| `by` | "user" \| "script" | Who reported it - user via UI or auto-detected |
| `description` | string | Details about the issue |
| `timestamp` | string | ISO timestamp when reported |
| `resolved` | boolean | Whether the bug has been addressed |

---

## How to Report a Bug

### Via UI (User)

1. Look for the **beetle icon** (🪲) in the top-right corner of any AI response
2. Click the icon to open the bug report modal
3. Select the **Bug Type** from the dropdown:
   - HTML, CSS, JSON, JS, TypeScript, Markdown, SQL, Other
4. Enter a **description** of what went wrong
5. Click **Report Bug**

The icon turns red after a bug is reported.

### Auto-Detection (Script)

The extension automatically reports bugs when:

- **JSON parsing fails completely** - Type: `JSON`
- **API errors occur** (non-abort) - Type: `Other`

These are marked with `by: "script"` in the bug report.

### Programmatic Reporting

From extension code, use:

```typescript
import { appendSessionBug } from '../storage/chatSessionRepository';

await appendSessionBug(sessionId, {
  type: 'JSON',
  pairIndex: 5,
  by: 'script',
  description: 'Auto-detected: Response parsing failed - Unexpected token'
});
```

---

## Couchbase Queries

### Get All Sessions with Bugs

```sql
SELECT META().id, projectName, updatedAt, bugs, ARRAY_LENGTH(bugs) AS bugCount
FROM `grokCoder`._default._default
WHERE docType = "chat"
  AND projectId IS NOT MISSING
  AND bugs IS NOT MISSING
  AND ARRAY_LENGTH(bugs) > 0
ORDER BY updatedAt DESC
LIMIT 20
```

### Get Bugs by Type

```sql
SELECT META(d).id AS sessionId, b.*
FROM `grokCoder`._default._default AS d
UNNEST d.bugs AS b
WHERE d.docType = "chat"
  AND d.projectId IS NOT MISSING
  AND b.type = "JSON"
ORDER BY b.timestamp DESC
LIMIT 50
```

### Get Unresolved Bugs

```sql
SELECT META(d).id AS sessionId, d.projectName, b.*
FROM `grokCoder`._default._default AS d
UNNEST d.bugs AS b
WHERE d.docType = "chat"
  AND d.projectId IS NOT MISSING
  AND (b.resolved IS MISSING OR b.resolved = false)
ORDER BY b.timestamp DESC
LIMIT 50
```

### Bug Summary by Type

```sql
SELECT b.type, COUNT(*) AS count
FROM `grokCoder`._default._default AS d
UNNEST d.bugs AS b
WHERE d.docType = "chat"
  AND d.projectId IS NOT MISSING
GROUP BY b.type
ORDER BY count DESC
```

### Get Bug with Associated Response

```sql
SELECT META(d).id AS sessionId,
       b.id AS bugId,
       b.type,
       b.description,
       b.pairIndex,
       d.pairs[b.pairIndex].request.text AS userRequest,
       d.pairs[b.pairIndex].response.text AS aiResponse
FROM `grokCoder`._default._default AS d
UNNEST d.bugs AS b
WHERE d.docType = "chat"
  AND d.projectId IS NOT MISSING
  AND b.type = "JSON"
LIMIT 10
```

---

## Bug Processing Pipeline (Planned)

### Overview

The goal is to create an automated pipeline that:

1. **Collects** bugs from Couchbase
2. **Analyzes** patterns using AI
3. **Suggests** fixes for the codebase
4. **Tracks** resolution progress

### Pipeline Stages

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Collect   │────▶│   Analyze   │────▶│   Suggest   │────▶│   Resolve   │
│    Bugs     │     │   Patterns  │     │    Fixes    │     │   & Track   │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

### Stage 1: Collection

- Query Couchbase for unresolved bugs
- Group by type and frequency
- Extract the associated request/response pairs

### Stage 2: AI Analysis

Send bugs to AI for pattern recognition:

```
Prompt: "Analyze these bug reports and identify common patterns:
- What types of responses cause JSON parsing failures?
- Are there specific user requests that lead to malformed output?
- What response patterns are most problematic?"
```

Expected output:
- Pattern categories (e.g., "Truncated JSON", "Mixed TOON/JSON", "Unclosed strings")
- Root cause hypotheses
- Affected code paths

### Stage 3: Fix Suggestions

For each pattern, generate fix suggestions:

```
Prompt: "Given this bug pattern: [pattern]
And these example failures: [examples]
Suggest code changes to:
1. Prevent this issue in the response parser
2. Add better error recovery
3. Improve the system prompt to avoid malformed output"
```

Expected output:
- Code diffs for `responseParser.ts`
- System prompt improvements
- New test cases

### Stage 4: Resolution Tracking

- Mark bugs as resolved after fixes are applied
- Track fix effectiveness (do similar bugs recur?)
- Generate reports on bug trends

### Implementation Plan

1. **Phase 1: Manual Pipeline**
   - Run queries manually in Couchbase Admin
   - Copy results to AI chat for analysis
   - Apply suggested fixes manually

2. **Phase 2: Semi-Automated**
   - Create VS Code command: "Analyze Recent Bugs"
   - Auto-fetch bugs and send to Grok for analysis
   - Display suggestions in extension

3. **Phase 3: Fully Automated**
   - Scheduled job to process bugs
   - Auto-create GitHub issues for patterns
   - AI-generated PRs for common fixes

---

## Future Enhancements

### Bug Severity

Add severity levels to prioritize fixes:

```typescript
type BugSeverity = 'critical' | 'major' | 'minor' | 'cosmetic';
```

### User Voting

Allow users to upvote bugs to indicate impact.

### Fix Verification

After applying a fix, run regression tests on historical bug cases.

### Telemetry Dashboard

Add a "Bug Analytics" section to the Usage tab showing:
- Bugs over time
- Resolution rate
- Most common bug types
- Time to resolution

---

## Related Files

- `src/storage/chatSessionRepository.ts` - BugReport interface and CRUD functions
- `src/views/ChatViewProvider.ts` - UI components and message handlers
