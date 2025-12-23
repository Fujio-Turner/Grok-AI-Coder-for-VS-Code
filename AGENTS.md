# Grok AI Coder - VS Code Extension

A VS Code extension integrating xAI's Grok API with Couchbase persistence for AI-assisted coding.

**Repository:** https://github.com/Fujio-Turner/Grok-AI-Coder-for-VS-Code


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
