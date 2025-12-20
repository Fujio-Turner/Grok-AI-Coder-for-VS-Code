# Grok AI Coder - VS Code Extension

<p align="center">
  <img src="media/icon.svg" alt="Grok AI Coder" width="128" height="128">
</p>

A powerful VS Code extension that integrates **xAI's Grok API** for AI-assisted coding, with **Couchbase persistence** for chat history and comprehensive change tracking with rollback capabilities.

## ✨ Features

- 🤖 **AI-Powered Coding Assistant** - Chat with Grok directly in VS Code
- 💾 **Persistent Chat History** - All conversations saved to Couchbase
- 🔄 **Change Tracking & Rollback** - Rewind/forward through code changes
- 📸 **Multimodal Support** - Attach images for visual context
- 🎯 **Smart Model Selection** - Auto-selects fast/reasoning models based on task
- ⚡ **Auto/Manual Apply** - Control when AI changes are applied
- 📋 **TODO Tracking** - Visual progress of multi-step tasks

---

## 📋 Table of Contents

1. [Prerequisites](#prerequisites)
2. [Getting Your Grok API Key](#getting-your-grok-api-key)
3. [Installation](#installation)
4. [Couchbase Setup](#couchbase-setup)
   - [Option A: Self-Hosted Couchbase](#option-a-self-hosted-couchbase)
   - [Option B: Couchbase Capella (Cloud)](#option-b-couchbase-capella-cloud)
5. [Configuration](#configuration)
6. [Using the Extension](#using-the-extension)
7. [Features Deep Dive](#features-deep-dive)
8. [Commands](#commands)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **VS Code** 1.85.0 or higher
- **Node.js** 18+ (for development)
- **Grok API Key** from xAI
- **Couchbase** (self-hosted or Capella cloud)

---

## Getting Your Grok API Key

### Step 1: Create an xAI Account

1. Go to [https://x.ai/api](https://x.ai/api)
2. Sign up or log in with your account
3. Navigate to the API section

### Step 2: Generate an API Key

1. Click **"Create API Key"**
2. Give your key a descriptive name (e.g., "VS Code Extension")
3. Copy the key immediately - it won't be shown again!

### What a Grok API Key Looks Like

```
xai-aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890abcdefghijklmnop
```

> ⚠️ **Important**: Grok API keys always start with `xai-` followed by alphanumeric characters. Keep your key secret!

### Step 3: Set Your API Key in VS Code

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Type **"Grok: Set API Key"**
3. Paste your API key and press Enter
4. The key is stored securely in VS Code's secret storage

---

## Installation

### From VSIX (Local Install)

1. Download or build the `.vsix` file:
   ```bash
   npm install
   npm run compile
   npx vsce package
   ```

2. Install in VS Code:
   - Open Extensions view (`Cmd+Shift+X`)
   - Click `...` menu → **Install from VSIX...**
   - Select `grok-coder-0.0.1.vsix`

### Development Mode

1. Clone the repository
2. Run `npm install`
3. Press `F5` to launch Extension Development Host

---

## Couchbase Setup

Grok AI Coder uses Couchbase to persist chat sessions. Choose one of the options below:

### Option A: Self-Hosted Couchbase

#### Step 1: Install Couchbase Server

**Using Docker (Recommended):**
```bash
docker run -d --name couchbase \
  -p 8091-8096:8091-8096 \
  -p 11210-11211:11210-11211 \
  couchbase:latest
```

**Or download directly:**
- Visit [https://www.couchbase.com/downloads](https://www.couchbase.com/downloads)
- Download Couchbase Server Community Edition
- Follow the installation wizard

#### Step 2: Initialize the Cluster

1. Open [http://localhost:8091](http://localhost:8091) in your browser
2. Click **"Setup New Cluster"**
3. Set cluster name: `grokCoder-cluster`
4. Set admin username: `Administrator`
5. Set admin password: `password` (or your preferred password)
6. Accept defaults and finish setup

#### Step 3: Create the Bucket

1. Go to **Buckets** in the left menu
2. Click **"Add Bucket"**
3. Configure:
   - **Name**: `grokCoder`
   - **RAM Quota**: 256 MB (minimum)
   - **Bucket Type**: Couchbase
4. Click **"Add Bucket"**

#### Step 4: Create Primary Index

1. Go to **Query** in the left menu
2. Run this query:
   ```sql
   CREATE PRIMARY INDEX ON `grokCoder`._default._default;
   ```

#### Step 5: Configure the Extension

Open VS Code Settings and set:

| Setting | Value |
|---------|-------|
| `grok.couchbaseDeployment` | `self-hosted` |
| `grok.couchbaseUrl` | `http://localhost` |
| `grok.couchbasePort` | `8091` |
| `grok.couchbaseQueryPort` | `8093` |
| `grok.couchbaseUsername` | `Administrator` |
| `grok.couchbasePassword` | `password` |
| `grok.couchbaseBucket` | `grokCoder` |

---

### Option B: Couchbase Capella (Cloud)

Couchbase Capella is a fully managed Database-as-a-Service. Perfect if you don't want to run Couchbase locally.

#### Step 1: Create a Free Capella Account

1. Go to [https://cloud.couchbase.com](https://cloud.couchbase.com)
2. Click **"Start Free Trial"** or **"Sign In"**
3. Complete the registration

#### Step 2: Create a Free Tier Cluster

1. Click **"Create Cluster"**
2. Select **"Free"** tier (no credit card required)
3. Choose your cloud provider and region
4. Name your cluster (e.g., `grok-coder-cluster`)
5. Click **"Create Cluster"** and wait for deployment (~5 minutes)

#### Step 3: Create a Bucket

1. Go to your cluster → **Data Tools** → **Buckets**
2. Click **"Create Bucket"**
3. Configure:
   - **Name**: `grokCoder`
   - **RAM Quota**: 256 MB
4. Click **"Create"**

#### Step 4: Create Primary Index

1. Go to **Data Tools** → **Query**
2. Run:
   ```sql
   CREATE PRIMARY INDEX ON `grokCoder`._default._default;
   ```

#### Step 5: Enable the Data API

1. Go to your cluster → **Settings** → **Data API**
2. Toggle **"Enable Data API"** to ON
3. Copy the **Data API URL** (looks like: `https://abc123.data.cloud.couchbase.com`)

#### Step 6: Create Cluster Access Credentials

1. Go to **Settings** → **Cluster Access**
2. Click **"Create Cluster Access"**
3. Set:
   - **Username**: `grok-app`
   - **Password**: (generate a strong password)
   - **Bucket Access**: Select `grokCoder` with Read/Write
4. Save the credentials!

#### Step 7: Allow Your IP Address

1. Go to **Settings** → **Allowed IP Addresses**
2. Click **"Add Allowed IP"**
3. Add your current IP or click "Add Current IP Address"

#### Step 8: Configure the Extension

Open VS Code Settings and set:

| Setting | Value |
|---------|-------|
| `grok.couchbaseDeployment` | `capella` |
| `grok.capellaDataApiUrl` | `https://your-cluster-id.data.cloud.couchbase.com` |
| `grok.couchbaseUsername` | `grok-app` |
| `grok.couchbasePassword` | (your cluster access password) |
| `grok.couchbaseBucket` | `grokCoder` |

---

## Configuration

Access settings via **File → Preferences → Settings** and search for "grok".

### Grok API Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.apiBaseUrl` | `https://api.x.ai/v1` | Grok API endpoint |
| `grok.modelFast` | `grok-3-mini` | Fast model for simple tasks |
| `grok.modelReasoning` | `grok-4` | Reasoning model for complex tasks |
| `grok.modelVision` | `grok-4` | Vision model for image analysis |
| `grok.defaultModelType` | `fast` | Default model to use |

### Couchbase Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.couchbaseDeployment` | `self-hosted` | `self-hosted` or `capella` |
| `grok.couchbaseUrl` | `http://localhost` | Self-hosted server URL |
| `grok.capellaDataApiUrl` | (empty) | Capella Data API URL |
| `grok.couchbaseUsername` | `Administrator` | Database username |
| `grok.couchbasePassword` | `password` | Database password |
| `grok.couchbaseBucket` | `grokCoder` | Bucket name |

### Behavior Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `grok.autoApply` | `true` | Auto-apply code changes (A) or manual (M) |
| `grok.enterToSend` | `false` | Enter sends message (vs Ctrl+Enter) |
| `grok.couchbaseTimeout` | `30` | Couchbase timeout in seconds |
| `grok.apiTimeout` | `300` | Grok API timeout in seconds (5 min) |
| `grok.debug` | `false` | Enable debug logging |

---

## Using the Extension

### The Sidebar Interface

Click the **Grok AI** icon in the Activity Bar to open the chat sidebar.

```
┌─────────────────────────────────────┐
│ ▼ Session Name          ● A + ⚙️   │  ← Header
├─────────────────────────────────────┤
│ 📋 TODOs (0/3)                      │  ← TODO Progress
├─────────────────────────────────────┤
│                                     │
│   Your message                      │  ← Chat History
│                                     │
│   AI Response with code blocks      │
│   📄 file.ts                        │
│   ┌─────────────────────────────┐   │
│   │ // code here                │   │
│   └─────────────────────────────┘   │
│                                     │
├─────────────────────────────────────┤
│ 3 files +42 -12 ~5   $0.02  ○ 15%  │  ← Changes Bar
├─────────────────────────────────────┤
│ 📎 [Message input............] Send │  ← Input
└─────────────────────────────────────┘
```

### Header Controls

| Control | Description |
|---------|-------------|
| **▼ Session Name** | Click to view/switch chat history |
| **● Status Dot** | Connection status (green=OK, yellow=partial, red=failed). Click to test. |
| **A/M Button** | Toggle Auto/Manual apply mode |
| **+ New Chat** | Start a new chat session |
| **⚙️** | Open extension settings |

### The Changes Bar

The bottom bar shows a summary of all changes made:

```
3 files  +42 -12 ~5   $0.02  ○ 15%
   │       │   │  │      │      │
   │       │   │  │      │      └── Context usage %
   │       │   │  │      └── Cost estimate
   │       │   │  └── Modified lines
   │       │   └── Removed lines
   │       └── Added lines
   └── Files changed
```

**Click the bar** to expand the full change history panel.

---

## Features Deep Dive

### 🔄 Change Control & Rollback

One of the most powerful features! Every code change is tracked and can be reverted.

#### How It Works

1. When Grok suggests code changes, they're tracked as a "changeset"
2. Each changeset records:
   - Which files were modified
   - Lines added/removed/modified
   - Timestamp and cost
3. You can step backward/forward through history

#### Using the Change History

1. **Click the Changes Bar** at the bottom to expand
2. See all changesets with their stats
3. **Click a changeset** to rewind to that point
4. Use **⏪ Rewind** and **⏩ Forward** buttons

#### Commands

| Command | Description |
|---------|-------------|
| `Grok: Rewind One Step` | Undo last change |
| `Grok: Forward One Step` | Redo change |
| `Grok: Clear Change History` | Clear all history |
| `Grok: Revert Last Edits` | Revert the last applied edit group |

### ⚡ Auto vs Manual Apply Mode

Control whether AI code changes are automatically applied.

#### Auto Mode (A) - Default

- Code changes are applied immediately when Grok responds
- Great for rapid iteration
- Changes are still tracked and can be reverted

#### Manual Mode (M)

- Code changes are shown but NOT applied automatically
- You must click **"Apply"** on each code block
- Good for reviewing changes before applying

#### How to Toggle

1. Click the **A** or **M** button in the header
2. Or set `grok.autoApply` in settings

### 📋 TODO Tracking

Grok can present multi-step plans that are visually tracked.

When Grok responds with a TODO list format:
```
📋 TODOS
- [ ] Create the user model
- [ ] Add validation logic
- [ ] Write unit tests
```

The UI shows:
- A collapsible TODO panel
- Progress counter (0/3 → 1/3 → 2/3 → 3/3)
- Completed items get strikethrough styling

### 📸 Image Attachments

Send images to Grok for visual context:

1. Click the **📎** button
2. Select one or more images
3. Add your question/prompt
4. Grok will analyze the images using the vision model

### 🖥️ Terminal Commands

Grok can suggest terminal commands that you can run directly:

When Grok responds with:
```
🖥️ `npm run test`
```

You'll see a **▶ Run** button to execute the command.

---

## Commands

Access via Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `Grok: Set API Key` | Set your xAI API key |
| `Grok: New Chat Session` | Start fresh chat |
| `Grok: Cancel Current Request` | Stop ongoing request |
| `Grok: Explain Selection` | Explain selected code |
| `Grok: Fix Selection` | Fix selected code |
| `Grok: Revert Last Edits` | Undo last changes |
| `Grok: Rewind One Step` | Step back in history |
| `Grok: Forward One Step` | Step forward in history |
| `Grok: Clear Change History` | Clear all change tracking |
| `Grok: Show Token Usage` | View token/cost summary |
| `Grok: Show Output Logs` | Open debug log panel |
| `Grok: Export Logs to File` | Save logs for debugging |
| `Grok: Test Connections` | Test Couchbase + API |
| `Grok: Export Diagnostics Report` | Full diagnostic JSON |

### Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Ctrl+Shift+G E` | Explain Selection |
| `Ctrl+Shift+G F` | Fix Selection |
| `Escape` | Cancel Request (when active) |

---

## Troubleshooting

### "API key not set" Error

1. Run `Grok: Set API Key` command
2. Ensure key starts with `xai-`
3. Check for extra spaces when pasting

### Couchbase Connection Failed

**Self-hosted:**
1. Ensure Couchbase is running: `docker ps` or check service
2. Verify ports 8091 and 8093 are accessible
3. Check username/password in settings
4. Ensure bucket `grokCoder` exists

**Capella:**
1. Verify Data API is enabled
2. Check your IP is in the allowed list
3. Verify cluster access credentials
4. Ensure the Data API URL is correct

### Run Diagnostics

1. Run `Grok: Test Connections` to check connectivity
2. Run `Grok: Export Diagnostics Report` for full debug info
3. Enable `grok.debug` for verbose logging
4. Run `Grok: Show Output Logs` to view logs

### Timeout Errors

Increase timeout settings if you have slow connections:
- `grok.couchbaseTimeout`: Default 30 seconds
- `grok.apiTimeout`: Default 300 seconds (5 minutes)

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run compile` to verify
5. Submit a pull request

---

## License

[MIT License](LICENSE)

---

## Acknowledgments

- **xAI** for the Grok API
- **Couchbase** for the database platform
- Built with ❤️ for the VS Code community
