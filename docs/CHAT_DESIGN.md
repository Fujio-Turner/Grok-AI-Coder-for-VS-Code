
https://mermaid.live/edit#pako:eNqNVU1z4kYQ_StTuiBqBWthg40OW4VZJ_EWTqmMWfJBDoPUwJRHM8p8wLKUL7nnlNzzF_MT0iMJbBmThAMlqV93v-7XPbPzEpmCF3kafrUgEvjI6FLRbCYI_nKqDEtYToUhE0I1mWhQxJ_CfM1g0zwGTR2oMpNP42NA7ADDFTWfEREruWYpqGPY8LrASZus5lTDMWAQ3zrEt0o-uueZKCGT1ocP04gMOUseyRhESubWGFlZp6U1lc7iN0mLLMEQA19MQBIOVBEmcmuewXFEcqnNHWhNl-DvzDaHqKHRu_rUCCp3luGbfqpaUv5_Lw0QucaOYZwXTphZG6xFl7AYEw2vI0LzHDExZcrXCGRS3KYB2SknjMYUCnQuhUYCDsfEsrFPF5d1vUFVwKb64uIeHKpG0LRM5zqhMCYytU7guZ3POZB3ROdMiL0-bxQ1WIITXarHBZcb4svcIG3K67xsnlID9xX94cqKR7_x919__k4GiN1-xVLa7XbjhRMqGhFlRRF_H76guWAc3k_uRyQFA4nL9n9S_fEbGUmaQkp-KCLoxmmh7igTxXgNKeevKDkR3fAOZZZzcNn9rGyvDkiGi7SvHNGtcn7GRgHNsESSODb6P-kWsCb5WUEOaEx_qUmGHmXEoht6hV0v1oLyw3y8ZvANEy-sqKp1hE_WPx58viE3g_vRj_XxLLmOqDZuZvacfUU3--fTPY2pwsz3NYJxtV_ONGVmNcQFFDb33T41iVSl5ZCn-Fx6Um6KiK6pC8p41dOaUm6dxScthQt955QpGja4LS02L31Qz5Okry3jKdE2SVDiY-7_0pNXPm6RjLKJsQrS5lsRxuW-T4rVNfIRBM5Tgut8uqWDPOdb1Bb3FCdS4AQSny0IFdtmrb-ou-RrcMCYmtWDnCjmNwOyppy51M5QBvDrjrkCd4p_ZIvF2FCji_4llCeWoxt59771rAa1RpaEQFA8OtK6IrE7cwv7TcqqSBvFMEqxjG9KcfpMqw7EagfdEfzc3YCkyDcuqb867RaZKVZhfEC_PPi-e7gb1eCarl1jjCsequKTFVLG0cSmGqmgjk-U5PxBXku8cHA9vcBbKpZ6EaaDwMtAZdS9ejvnNvPMCjKYeRE-prCglpuZNxNP6IYX3E9SZntPJe1y5UULyjW-lQNT3dIHSFEDXpfCeFG_iOBFO--LF7XCXr_dO-v2u52zXucivAoDb4ufL7uddnh53jsPw-7lxfnZ1VPgfS2Shu3-xVU3DPvdq7DT6XTPe0__AMcgpHo

Here's the complete flow:

### 1. **Webview (User Click)**
- `doSend()` gets text from textarea, clears input
- Posts `{type:'sendMessage', text, images}` to extension

### 2. **ChatViewProvider.sendMessage()**
- Creates `ChatRequest` with timestamp
- **Saves to Couchbase** with `status: 'pending'`
- Sends `newMessagePair` → webview renders user bubble + spinner

### 3. **Agent Workflow** (if no images)
- Analyzes request for file/URL references
- Loads matching files into context
- Shows progress: "🔍 Analyzing..." → "📂 Loaded X files"

### 4. **Main API Call**
- Builds messages array (system prompt + history + user message)
- Calls `sendChatCompletion()` with streaming
- Each chunk → `updateResponseChunk` → webview shows partial text

### 5. **SAVE EARLY** (new!)
- Immediately saves raw response text to Couchbase
- Prevents data loss if parsing crashes

### 6. **Parse Response**
- Tries `parseResponse()` (regex-based JSON repair)
- If fails + cleanup enabled → `cleanJsonWithModel()` (AI fixes JSON)
- Extracts: `summary`, `sections`, `todos`, `fileChanges`, `commands`, `nextSteps`

### 7. **Save Structured Response**
- Updates Couchbase with full `structured` data
- Records usage (tokens, cost)

### 8. **File Changes** (if any)
- Resolves paths, validates changes
- Calculates diff stats (+added/-removed)
- If `autoApply` → writes files immediately

### 9. **Render Final Output**
- Sends `requestComplete` with `structured` + `diffPreview`
- Webview calls `fmtFinalStructured()` to build HTML:
  - Summary paragraph
  - Sections with headings
  - Code blocks with syntax highlighting
  - File changes with Apply buttons
  - Commands with Run buttons
  - Next Steps buttons
  - "What was done" summary
  - Done bar with action buttons + token count
- Caches HTML in webview state
- Scrolls to bottom