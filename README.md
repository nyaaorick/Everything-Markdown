<div align="center">

# Everything MD

**A local-first, universal Markdown workspace for Firefox — with one-click Google Gemini conversation export.**

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)](Firefox/manifest.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Firefox Add-on](https://img.shields.io/badge/Firefox-Extension-orange.svg?logo=firefoxbrowser)](https://addons.mozilla.org/)
![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen.svg)

</div>

---

Everything MD turns your browser into a self-contained Markdown editor and library. It captures a
Google Gemini chat into clean Markdown in one click, then gives you a real editor to organise,
annotate, and re-export it. Everything lives in your browser — no account, no server, no tracking.

## Features

### 📥 Gemini → Markdown
- One-click export of the visible conversation from the toolbar popup.
- Question/answer merge, table conversion, and code-fence preservation, with fallbacks for Gemini's
  frequently-changing DOM.
- Optional metadata header (export time + source URL).
- Send straight into the manager, or download a `.md` file.

### 📝 Editor & library (the "Manager")
- **CodeMirror 6** editor: Markdown syntax highlighting, line numbers, soft-wrap, undo history,
  slash-command autocomplete, and a formatting toolbar.
- **Resizable split-pane** live preview with a draggable divider.
- **KaTeX** math rendering and **marked**-powered HTML preview.
- **Folder tree** with drag-and-drop organisation, **full-text search**, and bookmarks.
- **Text highlighting** on the preview pane — colour marks anchored to block + offset so they
  survive `**bold**` / `*italic*` / link boundaries; click to remove.

### 🖼️ Assets & import/export
- Paste or drag images straight into a note; they are stored locally in IndexedDB.
- Export a plain `.md`, or a `.7z` bundle (Markdown + `assets/`) when a note carries local images.
- Import `.md` / `.txt` by file picker or full-screen drag-and-drop.
- Print / export to PDF with print-tuned styles and image downscaling.

### 🔒 Local-first
- All data is stored in-browser via **Dexie / IndexedDB**. Nothing leaves your machine.
- `data_collection_permissions: none` — declared zero data collection.

## Install

### From source (development)

```bash
git clone https://github.com/nyaaorick/Everything-MD.git
cd Everything-MD

# Load it live in Firefox
npm install --global web-ext
cd Firefox && web-ext run
```

Or load it manually: open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** →
pick `Firefox/manifest.json`.

### Build a distributable package

```bash
./build.sh   # runs web-ext lint + build -> Firefox/web-ext-artifacts/
```

## Usage

1. Open a conversation on [gemini.google.com](https://gemini.google.com).
2. Click the **Everything MD** toolbar icon → **Extract & Save to Manager** (or **Download Markdown File**).
3. Click **Open Everything MD** any time to browse, edit, highlight, and re-export your library.

## Tech stack

| Area        | Library |
|-------------|---------|
| Editor      | CodeMirror 6 |
| Markdown    | marked |
| Math        | KaTeX |
| Storage     | Dexie (IndexedDB) |
| Archiving   | 7-Zip WASM (`7zz`) |
| Packaging   | Manifest V3, `web-ext` |

## Project layout

```
Firefox/
  manifest.json      Manifest V3 definition
  popup.html/js      Toolbar popup — Gemini capture UI
  content.js         Injected Gemini DOM -> Markdown extractor
  background.js      Downloads / messaging
  manager.html       Full editor + library UI
  app.js             Manager logic (Storage, FolderTree, Editor, Search, Highlight, Manager modules)
  lib/               Vendored dependencies (CodeMirror bundle, Dexie, marked, KaTeX, 7zz WASM)
docs/DEVELOPMENT.md  Module interfaces and working principles
test/                Integration tests
```

## Contributing

Issues and PRs are welcome. Keep changes small and focused; run `./build.sh` (web-ext lint) before
opening a PR. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the module interfaces.

## License

[MIT](LICENSE) © nyaaorick
