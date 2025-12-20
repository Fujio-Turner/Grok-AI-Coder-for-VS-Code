# Grok AI Coder - VS Code Extension

A VS Code extension integrating xAI's Grok API with Couchbase persistence for AI-assisted coding.

## Response Format Requirements

The extension parses AI responses to extract code changes, terminal commands, and TODO lists. Use these exact formats:

### File Changes (Required for Apply Button)

```
📄 path/to/filename.ext
```language
// complete file contents here
```
```

**Rules:**
- Use 📄 emoji followed by the relative file path on its own line
- Code block must immediately follow the filename line
- Include **full file content**, not snippets
- Multiple files: repeat the pattern for each file

**Example:**
```
📄 src/utils/helper.ts
```typescript
export function greet(name: string): string {
    return `Hello, ${name}!`;
}
```
```

### Terminal Commands (Creates Run Button)

```
🖥️ `command here`
```

**Example:**
```
🖥️ `npm run test`
🖥️ `grep -r "TODO" src/`
```

### TODO Lists (Visual Progress Tracking)

For multi-step tasks, start responses with:

```
📋 TODOS
- [ ] First step description
- [ ] Second step description
- [ ] Third step description
```

**Rules:**
- Keep steps concise (under 50 characters each)
- Use `- [ ]` checkbox format
- The UI tracks completion progress (0/3 → 1/3 → 2/3 → 3/3)

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
