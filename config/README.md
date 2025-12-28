# Config - AI Prompt Templates

This folder contains all the prompts and schemas sent to the xAI Grok API. By externalizing these into JSON files, you can:

1. **See exactly what's being sent** to the AI
2. **Experiment with different prompts** without recompiling
3. **Version control** prompt changes independently

## Files

| File | Purpose |
|------|---------|
| `system-prompt.json` | Main system prompt defining AI behavior, JSON output format, and file handling rules |
| `planning-prompt.json` | Fast model prompt for creating a plan (Pass 1 of agent workflow) |
| `planning-schema.json` | **Structured Output schema** for planning responses (guarantees valid JSON) |
| `response-schema.json` | JSON schema included in system prompt to define response structure |
| `structured-output-schema.json` | Full JSON Schema for xAI Structured Outputs API (main chat responses) |
| `json-cleanup-prompt.json` | Fast model prompt for fixing malformed JSON responses |
| `json-cleanup-schema.json` | **Structured Output schema** for JSON cleanup responses |
| `toon-to-json-prompt.json` | Fast model prompt for converting TOON format to JSON |
| `image-gen-prompt.json` | Prompt for generating image prompts from user requests |
| `image-prompts-schema.json` | **Structured Output schema** for image prompt generation |
| `handoff-context-prompt.json` | Template for session continuation/handoff context |

## Structured Outputs

This extension uses xAI's [Structured Outputs API](https://docs.x.ai/docs/guides/structured-outputs) to **guarantee** valid JSON responses. The `*-schema.json` files define the JSON schemas passed to the API via `response_format`.

**Benefits:**
- No more malformed JSON responses
- API validates response against schema before returning
- Eliminates need for regex-based JSON repair in most cases

**Schema files follow xAI format:**
```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "schema_name",
    "strict": true,
    "schema": { ... }
  }
}
```

## File Structure

Each JSON file contains:

```json
{
  "name": "config-name",
  "description": "What this config does",
  "version": "1.0.0",
  "prompt": "The actual prompt text...",
  // OR for schemas:
  "schema": { ... }
}
```

## Template Variables

Some prompts use template variables (e.g., `{{RESPONSE_JSON_SCHEMA}}`, `{{count}}`). These are replaced at runtime:

- `{{RESPONSE_JSON_SCHEMA}}` - Replaced with the response schema from `response-schema.json`
- `{{count}}` - Number of items to generate
- `{{contextInfo}}` - Optional project context
- `{{handoffText}}` - Previous session's handoff summary

## How to Experiment

1. **Edit a JSON file** - Change the prompt text
2. **Reload the extension** (Cmd+Shift+P → "Developer: Reload Window")
3. **Test with a chat message** - See if behavior changes

## Tips for Prompt Engineering

- Be explicit about output format requirements
- Include examples of expected responses
- Use CRITICAL/IMPORTANT markers for essential rules
- Test with edge cases (malformed input, missing context)

## Loading Order

The extension loads configs at startup. If you want hot-reload during development:
1. Enable debug mode (`grok.debug: true`)
2. Use "Grok: Reload Config" command (if implemented)

## Reverting Changes

If you break something, you can:
1. Git checkout the original file
2. Or copy from the TypeScript source files in `src/prompts/`
