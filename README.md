# Grok AI Coder

<p align="center">
  <img src="media/icon.png" alt="Grok AI Coder" width="128" height="128">
</p>

<p align="center">
  <strong>AI-powered coding assistant with xAI's Grok and persistent chat history</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#usage">Usage</a> •
  <a href="#configuration">Configuration</a> •
  <a href="https://github.com/Fujio-Turner/Grok-AI-Coder-for-VS-Code">GitHub</a>
</p>

---

**Grok AI Coder** brings xAI's powerful Grok models directly into VS Code with full chat persistence via Couchbase. Every code change is tracked and can be reverted—code fearlessly with AI.

## ✨ Features

- **💬 Sidebar Chat** — Conversational AI coding assistant in your editor
- **💾 Persistent History** — Chat sessions saved to Couchbase, never lose context
- **🔄 Change Tracking** — Every edit tracked with full rewind/forward capability
- **📸 Multimodal** — Attach images for visual context using Grok's vision model
- **⚡ Model Picker** — Toggle between Fast (F), Smart (S), and Base (B) models
- **📋 TODO Progress** — Visual tracking of multi-step tasks
- **🖥️ Run Commands** — Execute suggested terminal commands with one click

## 🚀 Quick Start

### First-Time Setup Wizard

When you install Grok AI Coder for the first time, a **Setup Wizard** will automatically appear to guide you through the configuration:

1. **Welcome** — Overview of what you'll need
2. **API Key** — Enter your xAI Grok API key
3. **Couchbase** — Configure your database connection
4. **Test** — Verify everything works

You can also open the wizard anytime via Command Palette: **"Grok: Open Setup Wizard"**

---

### What You'll Need

Before getting started, you'll need two things:

#### 1. xAI Grok API Key

1. Visit [x.ai/api](https://x.ai/api)
2. Create an account and generate an API key
3. Copy your key (starts with `xai-`)

> 💡 **Tip:** Your API key is stored securely in VS Code's secret storage, never in plain text.

#### 2. Couchbase Database

Grok AI Coder uses Couchbase to persist your chat history across sessions. Choose one option:

**Option A: Docker (Quickest for Local Development)**
```bash
docker run -d --name couchbase -p 8091-8096:8091-8096 -p 11210:11210 couchbase:latest
```

After starting, complete initial setup:
1. Visit `http://localhost:8091` in your browser
2. Create a new cluster (remember your admin password)
3. Create a bucket named `grokCoder`
4. Create these indexes for optimal performance:

```sql
-- Required: Chat session queries (list sessions, usage stats)
CREATE INDEX `find_chats_v1` ON `grokCoder`._default._default(`projectId`, `updatedAt` DESC) 
WHERE (`docType` = "chat");

-- Required: File backup lookups by path
CREATE INDEX `adv_pathHash_docType_createdAt` ON `grokCoder`._default._default(`pathHash`, `createdAt`) 
WHERE (`docType` = "file-backup");

-- Required: File backup lookups by session
CREATE INDEX `adv_createdBySession_docType_createdAt_v1` ON `grokCoder`._default._default(`createdBySession`, `createdAt`) 
WHERE (`docType` = "file-backup");

-- Optional: Files API cleanup (only if using experimental Files API)
CREATE INDEX `chat_session_finder_v1` ON `grokCoder`._default._default(`uploadedFiles`) 
WHERE (`type` = "chat_session");
```

**Option B: Couchbase Capella (Cloud — No Setup Required)**
- Sign up at [cloud.couchbase.com](https://cloud.couchbase.com)
- Create a free tier cluster
- Create a bucket named `grokCoder`
- Note your cluster credentials and Data API URL

---

### Manual Configuration (Alternative to Wizard)

If you prefer to configure manually:

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Grok: Set API Key"** and paste your xAI API key
3. Open VS Code Settings and configure:
   - `grok.couchbaseUrl` — Your Couchbase server (default: `http://localhost`)
   - `grok.couchbaseUsername` — Database username
   - `grok.couchbasePassword` — Database password
   - `grok.couchbaseBucket` — Bucket name (default: `grokCoder`)
4. Run **"Grok: Test Connections"** to verify

---

## 📖 Usage

### The Chat Interface

Click the **Grok AI** icon in the Activity Bar to open the chat sidebar.

<p align="center">
  <img src="media/screenshot.png" alt="Grok AI Coder Interface" width="400">
</p>

### Header Controls

| Control | Description |
|---------|-------------|
| **▼ Session** | View/switch chat history |
| **●** | Connection status (click to test) |
| **F/S/B** | Model picker: Fast, Smart, or Base (click to cycle) |
| **A/M** | Toggle Auto/Manual apply mode |
| **+** | New chat session |
| **⚙️** | Settings |

### Change Tracking & Rollback

Every code change is tracked. Click the **Changes Bar** to see history:
- **Rewind** to any previous state
- **Forward** to re-apply changes
- See stats: files changed, lines added/removed, cost

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+G E` | Explain selected code |
| `Ctrl+Shift+G F` | Fix selected code |
| `Escape` | Cancel current request |

---

## ⚙️ Configuration

### Grok API Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.modelMode` | `fast` | Model mode: `fast`, `smart`, or `base` |
| `grok.modelFast` | `grok-3-mini` | Model used in Fast mode |
| `grok.modelReasoning` | `grok-4` | Model used in Smart mode |
| `grok.modelBase` | `grok-3` | Model used in Base mode |
| `grok.modelVision` | `grok-4` | Model used for images |
| `grok.autoApply` | `true` | Auto-apply code changes |

### Couchbase Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.couchbaseDeployment` | `self-hosted` | `self-hosted` or `capella` |
| `grok.couchbaseBucket` | `grokCoder` | Bucket name |
| `grok.couchbaseUrl` | `http://localhost` | Server URL (self-hosted) |
| `grok.capellaDataApiUrl` | — | Capella Data API URL |

---

## 🎯 Commands

Access via Command Palette (`Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **Grok: Open Setup Wizard** | First-time configuration wizard |
| **Grok: Set API Key** | Configure your xAI API key |
| **Grok: New Chat Session** | Start a fresh conversation |
| **Grok: Explain Selection** | Explain selected code |
| **Grok: Fix Selection** | Fix issues in selected code |
| **Grok: Revert Last Edits** | Undo last AI changes |
| **Grok: Rewind One Step** | Step back in history |
| **Grok: Forward One Step** | Step forward in history |
| **Grok: Test Connections** | Test Couchbase + API connectivity |
| **Grok: Show Token Usage** | View session costs |

---

## 🔧 Debugging

Enable debug mode for troubleshooting:

1. Set `grok.debug` to `true` in settings
2. Run **"Grok: Show Output Logs"** to view detailed logs
3. Run **"Grok: Export Diagnostics Report"** for full diagnostic data

### Connection Status

The status dot in the header shows health:
- 🟢 Green — All systems connected
- 🟡 Yellow — Partial connection
- 🔴 Red — Connection issues

---

## 💰 Pricing

Grok AI Coder uses xAI's API. Approximate costs:

| Model | Input | Output |
|-------|-------|--------|
| grok-3-mini | $0.30/1M tokens | $0.50/1M tokens |
| grok-4 | $3.00/1M tokens | $15.00/1M tokens |

Token usage is tracked in the status bar and Changes Bar.

---

## 📋 Requirements

- **VS Code** 1.85.0+
- **Grok API Key** from [x.ai/api](https://x.ai/api)
- **Couchbase** (self-hosted or Capella cloud)

---

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

---

<p align="center">
  Built with ❤️ using <a href="https://x.ai">xAI Grok</a> and <a href="https://couchbase.com">Couchbase</a>
</p>
