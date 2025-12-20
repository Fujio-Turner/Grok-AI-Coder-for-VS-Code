# Changelog

All notable changes to the **Grok AI Coder** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2024-12-20

### Added

- **Sidebar Chat Interface** — Full-featured chat panel in VS Code Activity Bar
- **Couchbase Persistence** — Chat sessions saved and restored across VS Code restarts
- **Change Tracking & Rollback** — Every code change tracked with rewind/forward capability
- **Smart Model Selection** — Auto-detects task complexity to choose grok-3-mini or grok-4
- **Multimodal Support** — Attach images for visual context using vision models
- **TODO Progress Tracking** — Visual progress indicators for multi-step tasks
- **Terminal Commands** — Suggested commands with one-click execution
- **Auto/Manual Apply Mode** — Toggle whether AI changes apply automatically
- **Token Usage Tracking** — Real-time cost estimation in status bar
- **Connection Diagnostics** — Built-in testing for Couchbase and API connectivity

### Commands

- `Grok: Set API Key` — Securely store your xAI API key
- `Grok: New Chat Session` — Start a fresh conversation
- `Grok: Explain Selection` — Get explanations for selected code
- `Grok: Fix Selection` — Fix issues in selected code
- `Grok: Revert Last Edits` — Undo the last batch of AI changes
- `Grok: Rewind One Step` — Step backward through change history
- `Grok: Forward One Step` — Step forward through change history
- `Grok: Clear Change History` — Clear all tracked changes
- `Grok: Test Connections` — Verify Couchbase and API connectivity
- `Grok: Show Token Usage` — View session token usage and costs
- `Grok: Export Diagnostics Report` — Export full diagnostic data

### Supported Models

- **grok-3-mini** — Fast, cost-efficient model for simple tasks
- **grok-4** — Flagship reasoning model for complex tasks
- **grok-4 (vision)** — Multimodal model for image analysis

### Couchbase Support

- Self-hosted Couchbase Server via N1QL
- Couchbase Capella (cloud) via Data API

---

## [Unreleased]

### Planned

- Git integration for change tracking
- Code diff preview before applying
- Streaming "thoughts" display during AI reasoning
- Custom system prompts
- Session export/import

---

[0.1.0]: https://github.com/your-username/grok-ai-coder/releases/tag/v0.1.0
[Unreleased]: https://github.com/your-username/grok-ai-coder/compare/v0.1.0...HEAD
