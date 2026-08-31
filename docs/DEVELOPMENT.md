# Development Guide

Module interfaces, working principles, and project context for contributors.


## Workflow & Development Principles
- **Fail Fast**: Validate inputs and state early. Throw descriptive errors immediately upon invalid conditions.
- **Minimal Surface**: Write only necessary code and tests. Prefer a single, comprehensive integration test over redundant unit tests.
- **Reuse First**: Leverage existing internal APIs, built-in libraries, and ecosystem patterns (e.g., CodeMirror 6 components) before introducing net-new abstractions.
- **Direct Execution**: Output exact code changes or direct answers. Omit preamble, pleasantries, conversational fillers, and unsolicited caveats.

## Current Tasks


## Completed Tasks
- [x] Implement resizable split-pane layout with draggable divider for live Markdown editing and preview (replacing the split button).
- [x] Defined core requirements for converting unstructured formats (PDF, PPTX, PNG) to Markdown.
- [x] Researched Copyfish OCR integration and browser-based WebGPU/WASM constraints.
- [x] Established Git reset and workspace clean procedures.

## Consolidated Context
- **Target Platform**: Firefox WebExtension (macOS, requiring `about:config` WebGPU flags).
- **Core Stack**: JavaScript, WebGPU, WebLLM, CodeMirror 6, Cache API (for local model injection).
- **Design Pattern**: Client-side local execution, zero external CLI/Python dependencies for the browser extension workflow.

## Project Interfaces (app.js)

The project consists of several IIFE modules with the following exposed interfaces:

### Storage
- `db` (Dexie database instance)
- `init()`
- `generateId(prefix)`
- `getFolders()`, `createFolder(name, parentId)`, `renameFolder(id, newName)`, `deleteFolder(id)`
- `getDocMeta()`, `getDocContent(id)`, `createDoc(title, content, folderId)`, `updateDocContent(id, content)`, `updateDocMeta(id, data)`, `deleteDoc(id)`, `toggleBookmark(id)`
- `getHighlights(docId)`, `addHighlight(docId, highlight)`, `removeHighlight(docId, highlightId)`
- `searchDocs(keyword)`
- `saveAsset(filename, blob)`, `getAsset(filename)`

### FolderTree
- `init(onSelectDoc)`
- `render()`
- `setActiveDoc(docId)`

### Editor
- `init(options)`
- `setContent(content)`
- `getContent()`
- `insertFormat(prefix, suffix, defaultText)`
- `insertText(text)`
- `getHeadings()`
- `setWordWrap(enabled)`
- `focus()`
- `getView()`
- `updateLineNumbers(enabled)`
- `setSelection(anchor, head)`

### Search
- `init(onSelectDoc)`
- `hideResults()`

### Highlight
- `init(onHighlightChangedCallback)`
- `setActiveDoc(docId)`
- `applyHighlightsToDOM(container)`
- `hideBubble()`

### Manager
- `init()`
- `loadDocument(docId)`
- `renderActiveDoc()`