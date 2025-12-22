# Build Instructions for Grok AI Coder VS Code Extension

## Prerequisites

- **Node.js** v18 or later
- **npm** (comes with Node.js)
- **vsce** (VS Code Extension CLI)

Install vsce globally if not already installed:
```bash
npm install -g @vscode/vsce
```

## Build Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Compile TypeScript

```bash
npm run compile
```

### 3. Create VSIX Package

```bash
vsce package
```

This creates a `.vsix` file named `grok-ai-coder-<version>.vsix` in the project root.

## Quick Build (One Command)

```bash
npm install && npm run compile && vsce package
```

## Version Management

To update the version before building, edit the `version` field in `package.json`:

```json
{
  "version": "1.0.1"
}
```

Or use npm version commands:
```bash
npm version patch  # 1.0.0 → 1.0.1
npm version minor  # 1.0.0 → 1.1.0
npm version major  # 1.0.0 → 2.0.0
```

## Install the Extension

Install the built VSIX in VS Code:

1. Open VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type "Install from VSIX"
4. Select the generated `.vsix` file

Or via command line:
```bash
code --install-extension grok-ai-coder-1.0.1.vsix
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Compile TypeScript to JavaScript |
| `npm run watch` | Watch mode for development |
| `npm run lint` | Run ESLint |
| `npm test` | Run unit tests |
| `vsce package` | Create .vsix package |

## Troubleshooting

### "vsce: command not found"
Install vsce: `npm install -g @vscode/vsce`

### Compilation Errors
Ensure TypeScript is installed: `npm install`

### Package Validation Errors
- Check that `package.json` has valid `publisher` and `version` fields
- Ensure `icon` path exists (media/icon.png)
- Verify all referenced files exist
