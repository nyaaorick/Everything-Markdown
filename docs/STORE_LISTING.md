# AMO store listing — copy & paste

Source of truth for the addons.mozilla.org listing. Keep this in sync with
`Firefox/_locales/*/messages.json` (the `extDescription` there is the **Summary**).

---

## Name

```
Everything Markdown
```

## Summary  (English, ≤250 chars — must match `_locales/en/messages.json`)

```
Save any Google Gemini chat as clean Markdown in one click, then organise, edit and export it in a fast, local-first Markdown workspace. No account, no servers, no tracking.
```

## Summary  (简体中文 — `_locales/zh_CN/messages.json`)

```
一键将 Google Gemini 对话保存为干净的 Markdown，并在快速、本地优先的 Markdown 工作区中整理、编辑与再导出。无需账号，无服务器，无跟踪。
```

---

## Description  (English)

```
Everything Markdown is two tools in one: a one-click Google Gemini → Markdown
exporter, and a full offline Markdown editor and library to keep everything you
capture.

▸ ONE-CLICK GEMINI EXPORT
• Save the visible Gemini conversation as clean Markdown straight from the toolbar
• Keeps headings, lists, tables and fenced code blocks intact
• Optional metadata header (export time + source link)
• Send it into the built-in manager, or download a .md file

▸ A REAL MARKDOWN EDITOR
• CodeMirror 6: syntax highlighting, line numbers, soft-wrap, slash commands,
  formatting toolbar, undo history
• Resizable split-pane live preview
• LaTeX math via KaTeX, GitHub-flavoured tables, task lists
• Paste or drag images straight into a note
• Export one .md, or a .7z bundle with images; print / export to PDF

▸ ORGANISE EVERYTHING
• Folder tree with drag-and-drop
• Full-text search across every note
• Bookmarks for quick access
• Colour highlights on the preview that survive bold / italic / link edits

▸ PRIVATE BY DESIGN
• 100% local — everything is stored in your browser (IndexedDB)
• No account, no server calls, no analytics, no tracking
• Declared zero data collection

Made for researchers, students, writers and developers who live in Markdown and
want their AI chats, notes and docs in one private place.

Open source (MIT): https://github.com/nyaaorick/Everything-Markdown
```

## Description  (简体中文)

```
Everything Markdown 二合一：一键把 Google Gemini 对话导出为干净的 Markdown，
再用一个完全离线的 Markdown 编辑器与资料库把它们保存下来。

▸ 一键导出 GEMINI 对话
• 在工具栏弹窗中，一键把当前 Gemini 对话保存为干净的 Markdown
• 保留标题、列表、表格与代码块
• 可选的元信息头（导出时间 + 来源链接）
• 直接存入内置管理器，或下载 .md 文件

▸ 真正好用的 MARKDOWN 编辑器
• CodeMirror 6：语法高亮、行号、自动折行、斜杠命令、格式工具栏、撤销历史
• 可拖动分栏的实时预览
• 基于 KaTeX 的 LaTeX 公式、GFM 表格、任务列表
• 图片可直接粘贴或拖入笔记
• 导出单个 .md，或含图片的 .7z 压缩包；支持打印 / 导出 PDF

▸ 全面整理
• 支持拖放的文件夹树
• 跨全部笔记的全文搜索
• 书签快速访问
• 预览区的彩色高亮，编辑加粗 / 斜体 / 链接后依然保留

▸ 隐私优先
• 100% 本地 —— 所有数据都存在你的浏览器里（IndexedDB）
• 无账号、无服务器请求、无统计、无跟踪
• 声明零数据收集

为长期使用 Markdown 的研究者、学生、写作者与开发者而做，
把 AI 对话、笔记与文档放在同一个私密的地方。

开源（MIT）：https://github.com/nyaaorick/Everything-Markdown
```

---

## Categories  (set on AMO)

- `web-development`
- `privacy-security`

## Tags  (set on AMO)

AMO only accepts tags from its fixed vocabulary (`GET /api/v5/addons/tags/`).
Applicable ones:

```
chat, google, privacy
```

## Support & homepage

- Homepage: `https://github.com/nyaaorick/Everything-Markdown`
- Support site: `https://github.com/nyaaorick/Everything-Markdown/issues`
- License: MIT

## Screenshots (upload from `docs/`)

| File | Caption |
|------|---------|
| `docs/screenshot.png` | CodeMirror 6 editor with live split-pane preview — tables, blockquotes and KaTeX math |
| `docs/banner.png` | Everything Markdown — local-first Markdown workspace for Firefox |

---

## What's new — 1.5

```
• New brand icon, shown on the toolbar
• Editor rebuilt on CodeMirror 6 — slash commands, better selection sync, undo history
• Archive export switched to 7-Zip (WebAssembly)
• Highlights now anchored to block + character offset, so they survive edits to
  inline bold / italic / link formatting
• Cleaner exported Markdown (no trailing horizontal rule)
• Localised listing (English + 简体中文); housekeeping and lint fixes
```
