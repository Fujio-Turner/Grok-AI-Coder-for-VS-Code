# Grok AI Coder - VS Code Extension

A VS Code extension integrating xAI's Grok API with Couchbase persistence for AI-assisted coding.

**Repository:** https://github.com/Fujio-Turner/Grok-AI-Coder-for-VS-Code



## TOON format

Token-Oriented Object Notation (TOON) is a line-oriented, indentation-based text format that encodes the JSON data model with explicit structure and minimal quoting. Arrays declare their length and an optional field list once; rows use a single active delimiter (comma, tab, or pipe). Objects use indentation instead of braces; strings are quoted only when required. This specification defines TOON’s concrete syntax, canonical number formatting, delimiter scoping, and strict‑mode validation, and sets conformance requirements for encoders, decoders, and validators. TOON provides a compact, deterministic representation of structured data and is particularly efficient for arrays of uniform objects.

https://github.com/toon-format/spec/blob/main/SPEC.md

currently AI in returned back malformed TOON data sometime if asked to respond back as TOON so the default respones is JSON.

## How This extention Chat works with AI to understand your code and updated it as needed

/docs/CHAT_DESIGN.md

## Chat history is stored in Couchbase as JSON

## Response Format Requirements

The extension parses AI responses to extract code changes, terminal commands, and TODO lists. Use these exact formats:

### File Changes - Diff Format (PREFERRED)

When modifying existing files, show changes in **unified diff format** so users can see what changed:

```
📄 path/to/filename.ext (lines 10-25)
```diff
  // unchanged context line
- const oldCode = "removed";
- const alsoRemoved = true;
+ const newCode = "added";
+ const alsoAdded = true;
  // more unchanged context
```
```

**Diff Rules:**
- Use `diff` as the language for the code block
- Lines starting with `-` (red) = removed/old code
- Lines starting with `+` (green) = added/new code  
- Lines starting with ` ` (space) = unchanged context
- Include 2-3 lines of context before/after changes
- Specify line numbers in parentheses: `(lines 10-25)`

**Example - Modifying a function:**
```
📄 src/utils/helper.ts (lines 5-12)
```diff
  export function greet(name: string): string {
-     return `Hello, ${name}!`;
+     const greeting = `Hello, ${name}!`;
+     console.log(greeting);
+     return greeting;
  }
```
```

### File Changes - Full File (For New Files)

For **new files only**, provide the complete content:

```
📄 path/to/newfile.ext
```language
// complete file contents here
```
```

**Rules:**
- Use 📄 emoji followed by the relative file path on its own line
- Code block must immediately follow the filename line
- Use full file format ONLY for new files
- For modifications, use diff format above

### Terminal Commands (Creates Run Button)

```
🖥️ `command here`
```

**Example:**
```
🖥️ `npm run test`
🖥️ `grep -r "TODO" src/`
```

### TODO Lists (REQUIRED for Multi-Step Tasks)

**⚠️ IMPORTANT:** For ANY task involving multiple steps, file changes, or complex work, you MUST start your response with a TODO list. This is critical for user experience and progress tracking.

```
📋 TODOS
- [ ] First step description
- [ ] Second step description
- [ ] Third step description
```

**Rules:**
- **Always include TODOs** for tasks with 2+ steps or file changes
- Keep steps concise (under 50 characters each)
- Use `- [ ]` checkbox format
- The UI tracks completion progress (0/3 → 1/3 → 2/3 → 3/3)

### Next Steps (End of Response)

When appropriate, end your response with a "Next Steps" section to guide the user:

```
## Next Steps
1. Run `npm test` to verify changes
2. Review the new helper functions
3. Consider adding error handling
```

## Features

| Feature | Description |
|---------|-------------|
| **Change Tracking** | Every code change is tracked and can be reverted |
| **Auto/Manual Apply** | Toggle whether changes apply immediately or require confirmation |
| **Multimodal** | Image attachments supported for vision model |
| **Smart Model Selection** | Auto-selects fast/reasoning/vision based on task complexity |
| **Couchbase Persistence** | Chat history saved across sessions |

## Tech Stack

- **Language:** TypeScript
- **UI:** VS Code Webview
- **API:** xAI Grok (OpenAI-compatible)
- **Storage:** Couchbase Server

## Project Structure

```
Grok_AI_Coder/
├── src/                    # TypeScript source code
│   ├── agent/              # Agent orchestrator, file/URL handling
│   ├── api/                # Grok API client, file uploader
│   ├── prompts/            # Response schema, JSON cleaner
│   ├── storage/            # Couchbase session repository
│   ├── utils/              # Logger, config loader, TOON converter
│   └── views/              # ChatViewProvider (main webview)
├── config/                 # ⚠️ EXTERNAL CONFIG - AI prompts & schemas
│   ├── system-prompt.json          # Main AI behavior & JSON format rules
│   ├── planning-prompt.json        # Fast model planning (Pass 1)
│   ├── planning-schema.json        # Structured Output schema for planning
│   ├── response-schema.json        # JSON schema for AI responses
│   ├── structured-output-schema.json # xAI Structured Outputs API schema
│   ├── json-cleanup-prompt.json    # Malformed JSON repair prompt
│   ├── json-cleanup-schema.json    # Structured Output schema for cleanup
│   ├── toon-to-json-prompt.json    # TOON to JSON conversion prompt
│   ├── image-gen-prompt.json       # Image prompt generation
│   ├── image-prompts-schema.json   # Structured Output schema for image prompts
│   ├── handoff-context-prompt.json # Session continuation template
│   └── README.md                   # Config documentation
├── tools/                  # Python utilities (error dashboard, etc.)
├── media/                  # Icons, CSS, webview assets
├── docs/                   # Documentation
└── out/                    # Compiled JavaScript (generated)
```

### ⚠️ Important: Config Folder

The `config/` folder contains **externalized AI prompts and schemas** that were previously hardcoded in TypeScript. This allows:

1. **Visibility** - See exactly what's sent to the API
2. **Experimentation** - Edit prompts without recompiling
3. **Version control** - Track prompt changes independently

**When modifying AI behavior:**
- Edit the JSON files in `config/` first
- Reload the extension to pick up changes
- The TypeScript files in `src/` have fallback defaults if config files are missing

**Config loader:** `src/utils/configLoader.ts` handles loading these files at runtime.

## Version Display

The extension version is displayed in two places for easy identification:

1. **Settings Panel** - Version badge shown between "Settings" title and "← Back to Chat" button (e.g., `v1.0.24`)
2. **Startup Log** - Output channel shows version on activation: `Grok AI Coder extension activated (v1.0.24)`

**Important:** Always update the version in `package.json` before building a new VSIX release. This ensures users can identify which version they're running.

## Commands

```bash
npm run compile    # Build
npm run watch      # Watch mode
npm test           # Run tests
vsce package       # Create .vsix
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.autoApply` | `true` | Auto-apply code changes |
| `grok.enterToSend` | `false` | Enter sends message (vs Ctrl+Enter) |
| `grok.modelFast` | `grok-3-mini` | Fast model for simple tasks |
| `grok.modelReasoning` | `grok-4` | Reasoning model for complex tasks |
| `grok.modelVision` | `grok-4` | Vision model for image analysis |
| `grok.debug` | `false` | Enable debug logging |

## Debugging

### Enable Debug Mode

Set `grok.debug` to `true` in VS Code settings to enable verbose logging. This outputs detailed information to the Grok AI Coder output channel.

**What debug mode shows:**
- API request/response details
- Couchbase connection status
- Message parsing and code block detection
- Change tracking operations
- Token usage calculations

### Testing Commands

| Command | Description |
|---------|-------------|
| `Grok: Test Connections` | Tests both Couchbase and Grok API connectivity |
| `Grok: Show Output Logs` | Opens the debug output channel |
| `Grok: Export Diagnostics Report` | Exports full diagnostic JSON for troubleshooting |
| `Grok: Export Logs to File` | Saves current logs to a file |

### Connection Status Indicator

The status dot in the header shows connection health:
- 🟢 **Green** - Both Couchbase and API connected
- 🟡 **Yellow** - Partial connection (one service down)
- 🔴 **Red** - Both services disconnected

Click the status dot to manually test connections.

---

## Bug & Error Tracking System

The extension automatically tracks bugs and errors to Couchbase for debugging and analytics. Use this system for any new error conditions.

### Bug Types

Defined in `src/storage/chatSessionRepository.ts`:

```typescript
export type BugType = 'HTML' | 'CSS' | 'JSON' | 'JS' | 'TypeScript' | 'Markdown' | 'SQL' | 'Other';
```

### How to Report a Bug Programmatically

Use `appendSessionBug()` from `chatSessionRepository.ts`:

```typescript
import { appendSessionBug } from '../storage/chatSessionRepository';

// Report a bug from script/code (not user-reported)
await appendSessionBug(sessionId, {
    type: 'JSON',           // BugType - categorizes the bug
    pairIndex: 5,           // Which message pair triggered this
    by: 'script',           // 'script' for auto-detected, 'user' for user-reported
    description: 'Auto-detected: Response required JSON cleanup - initial parse failed'
});
```

### When to Track Bugs

Track as bugs any operation where the AI/API did not behave as expected:

| Scenario | Type | Description Pattern |
|----------|------|---------------------|
| Response truncated | `Other` | `Auto-detected: Response was truncated - X file change(s) recovered` |
| JSON parse failed, AI cleanup succeeded | `JSON` | `Auto-detected: Response required JSON cleanup - initial parse failed, AI remediation succeeded` |
| JSON parse failed completely | `JSON` | `Auto-detected: Response parsing failed - {error message}` |
| File operation failed | `Other` | `Auto-detected: File operation failed - {operation} on {path}` |
| API error | `Other` | `Auto-detected: API error - {status} {message}` |

### Bug Schema (Couchbase)

Bugs are stored in the session document's `bugs[]` array:

```json
{
  "bugs": [
    {
      "type": "JSON",
      "pairIndex": 3,
      "timestamp": "2025-12-26T10:30:00.000Z",
      "description": "Auto-detected: Response required JSON cleanup",
      "reportedBy": "script",
      "debugContext": { ... }  // Optional: additional context for debugging
    }
  ]
}
```

### Viewing Bugs

Use the Error Dashboard (`tools/error_dashboard.py`) to view and analyze bugs:

```bash
cd tools
pip install -r requirements.txt
python error_dashboard.py
# Open http://localhost:5050
```

### Dashboard Categories

The dashboard auto-categorizes bugs based on description keywords:

| Category | Detection Logic |
|----------|-----------------|
| `cli` | Type is "cli" (CLI command execution failure) |
| `truncation` | Description contains "truncat" |
| `json` | Description contains "json" OR `bugType === 'JSON'` |
| `timeout` | Description contains "timeout" or "connection dropped" |
| `terminated` | Description contains "terminated" |
| `validation` | Description contains "invalid argument" or "validation" |
| `api` | Description contains "api error", "fetch failed", "retry failed", or "failed fetch" |
| `file` | Type is "failure" OR description contains "line" or "diff" |
| `other` | Everything else |

### Best Practices

1. **Always use `by: 'script'`** for auto-detected bugs (vs `by: 'user'` for user-reported)
2. **Prefix descriptions with `Auto-detected:`** for programmatic bug reports
3. **Include context** in the description (what failed, what was recovered)
4. **Use appropriate BugType** - helps with filtering and analytics
5. **Wrap in try/catch** - bug reporting should never crash the main flow:

```typescript
try {
    await appendSessionBug(sessionId, { ... });
    debug('Auto-reported bug for pair:', pairIndex);
} catch (bugErr) {
    debug('Failed to auto-report bug:', bugErr);
}
```

---

## CLI Execution Tracking

CLI commands (both successes and failures) are tracked in `session.cliExecutions[]` for analytics and debugging.

### CLI Execution Schema

```typescript
interface CliExecution {
    id: string;
    timestamp: string;
    pairIndex: number;
    command: string;
    cwd: string;
    success: boolean;
    exitCode?: number;
    durationMs: number;
    stdout?: string;  // First 1000 chars
    stderr?: string;  // First 1000 chars
    error?: string;   // Error message if failed
    wasAutoExecuted: boolean;  // True if auto-executed by AI
    wasWhitelisted: boolean;   // True if command was in whitelist
}
```

### How to Track CLI Execution

Use `appendCliExecution()` from `chatSessionRepository.ts`:

```typescript
import { appendCliExecution } from '../storage/chatSessionRepository';

await appendCliExecution(sessionId, {
    pairIndex: 5,
    command: 'npm run build',
    cwd: '/path/to/project',
    success: false,
    exitCode: 1,
    durationMs: 2500,
    error: 'Build failed',
    stderr: 'error TS2322: Type...',
    wasAutoExecuted: true,
    wasWhitelisted: true
});
```

### Dashboard View

CLI failures appear in the Error Dashboard with:
- Purple badge for CLI type
- 🤖 icon for auto-executed commands
- 👤 icon for manually-executed commands
- Filter by "CLI failures only" in the Type dropdown
