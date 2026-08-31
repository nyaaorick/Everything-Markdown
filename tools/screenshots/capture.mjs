#!/usr/bin/env node
// Capture feature screenshots of the manager UI for the README / AMO listing.
//
// The extension can't run as a plain file:// page (app.js needs the WebExtension
// `browser` API), so this builds a throwaway Firefox/_demo.html with:
//   - a <head> shim: in-memory browser.storage.local + prompt/confirm stubs
//   - a <body>-end seed: a few folders/docs, one opened
// then drives it with headless Firefox over Marionette and writes PNGs to docs/.
//
// Usage:  node tools/screenshots/capture.mjs
// Env:    FIREFOX_BIN (default: macOS app path, else `firefox` on PATH)

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, sleep } from "./lib-marionette.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FF = process.env.FIREFOX_BIN
  || (fs.existsSync("/Applications/Firefox.app/Contents/MacOS/firefox")
    ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");
const DOCS = path.join(ROOT, "docs");
const DEMO = path.join(ROOT, "Firefox", "_demo.html");

const SHIM = `<script>
(function () {
  var mem = {};
  var local = {
    get: function (k) { var o = {}; (Array.isArray(k) ? k : [k]).forEach(function (x) { if (x in mem) o[x] = mem[x]; }); return Promise.resolve(o); },
    set: function (o) { Object.assign(mem, o); return Promise.resolve(); },
    remove: function (k) { (Array.isArray(k) ? k : [k]).forEach(function (x) { delete mem[x]; }); return Promise.resolve(); }
  };
  var api = { storage: { local: local }, runtime: { getURL: function (p) { return p; }, onMessage: { addListener: function () {} }, sendMessage: function () { return Promise.resolve(); } }, downloads: { download: function () { return Promise.resolve(1); } } };
  window.browser = window.browser || api;
  window.chrome = window.chrome || api;
  window.prompt = function () { return "Weekly Research Notes"; };
  window.confirm = function () { return true; };
})();
</script>
`;

const DEMO_MD = [
  "# Weekly Research Notes", "",
  "Exported from **Gemini** in one click, then refined here in *Everything Markdown*.", "",
  "## Key findings", "",
  "- Local-first storage keeps every note in the browser",
  "- Highlights survive **bold**, *italic* and [links](https://example.com)",
  "- Images paste straight into the note", "",
  "> All data stays on your machine — no account, no server.", "",
  "## Throughput", "",
  "| Format   | Import  | Round-trip |",
  "|----------|:-------:|:----------:|",
  "| Markdown | instant | lossless   |",
  "| PDF      | manual  | lossy      |", "",
  "## Formula", "",
  "Gaussian integral: $\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$", "",
].join("\n");

const SEED = `
<script>
window.addEventListener("load", function () {
  setTimeout(async function () {
    try {
      var f = await Storage.createFolder("Research", null);
      var g = await Storage.createFolder("Snippets", null);
      await Storage.createDoc("Meeting minutes", "# Meeting minutes\\n\\n- follow up with the team\\n- send the Markdown export", f.id);
      await Storage.createDoc("Reading list", "# Reading list\\n\\n1. CRDTs for text\\n2. WebAssembly basics\\n3. Markdown AST parsers", f.id);
      await Storage.createDoc("Markdown cheatsheet", "# Markdown cheatsheet\\n\\nHeadings, **bold**, _italic_, lists, tables and fenced code. GitHub-flavoured Markdown is supported.", g.id);
      await Storage.createDoc("Gemini export thread", "# Gemini export thread\\n\\nSaved from Gemini as Markdown, then tidied here. Keeps tables and code blocks intact.", f.id);
      await Storage.createDoc("README draft", "# README draft\\n\\nWrite the project description in Markdown and export it when ready.", g.id);
      var d = await Storage.createDoc("Weekly Research Notes", ${JSON.stringify(DEMO_MD)}, f.id);
      if (window.FolderTree && FolderTree.render) FolderTree.render();
      await Manager.loadDocument(d.id);
      await new Promise(function (r) { setTimeout(r, 800); });
      document.title = "DEMO-READY";
    } catch (e) { document.title = "DEMO-ERR"; window.__seedErr = String(e && e.stack || e); }
  }, 500);
});
</script>
`;

const HIGHLIGHT_JS = `
  var mdBody = document.getElementById('mdBody');
  function hl(sel, s, e, color) {
    var el = mdBody.querySelector(sel); if (!el) return;
    var tn = null, w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { if (w.currentNode.length >= e) { tn = w.currentNode; break; } }
    if (!tn) return;
    var r = document.createRange(); r.setStart(tn, s); r.setEnd(tn, Math.min(e, tn.length));
    var sl = getSelection(); sl.removeAllRanges(); sl.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    var btn = document.querySelector('#highlightBubble .hl-btn[data-color="' + color + '"]');
    if (btn) btn.click();
    sl.removeAllRanges();
  }
  hl('li', 0, 35, 'green'); hl('blockquote', 0, 30, 'blue'); hl('p', 0, 13, 'yellow');
`;

function buildDemo() {
  let h = fs.readFileSync(path.join(ROOT, "Firefox", "manager.html"), "utf8");
  h = h.replace("<head>", "<head>\n" + SHIM);
  h = h.replace("</body>", SEED + "</body>");
  fs.writeFileSync(DEMO, h);
}

async function main() {
  buildDemo();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "em-ff-"));
  try { execSync("pkill -f 'firefox.*marionette'"); } catch {}
  await sleep(800);

  const ff = spawn(FF, ["--headless", "--marionette", "--profile", profile, "--no-remote", "about:blank"],
    { stdio: "ignore" });
  await sleep(4000);

  try {
    const m = await connect();
    await m.send("WebDriver:NewSession", {});
    await m.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: 1460, height: 900 });
    await m.send("WebDriver:Navigate", { url: "file://" + DEMO });

    let title = "";
    for (let i = 0; i < 80; i++) {
      title = await m.exec("return document.title;");
      if (/^DEMO-(READY|ERR)/.test(title)) break;
      await sleep(250);
    }
    if (title !== "DEMO-READY") throw new Error("demo seed failed: " + await m.exec("return window.__seedErr || 'unknown';"));
    await sleep(900);

    await m.screenshot(path.join(DOCS, "screenshot.png"));
    console.log("wrote docs/screenshot.png");

    await m.exec(HIGHLIGHT_JS);
    await sleep(500);
    await m.screenshot(path.join(DOCS, "screenshot-highlights.png"));
    console.log("wrote docs/screenshot-highlights.png");

    const search = await m.findRef("#searchInput");
    await m.click(search);
    await m.type(search, "mark");
    for (let i = 0; i < 20; i++) {
      const n = await m.exec("return document.querySelectorAll('#searchResults .search-result-item').length;");
      if (n > 0) break;
      await sleep(200);
    }
    await sleep(400);
    await m.screenshot(path.join(DOCS, "screenshot-search.png"));
    console.log("wrote docs/screenshot-search.png");

    await m.send("WebDriver:DeleteSession", {}).catch(() => {});
    m.close();
  } finally {
    ff.kill();
    fs.rmSync(DEMO, { force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("FAIL:", e.message || e); process.exit(1); });
