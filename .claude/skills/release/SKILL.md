---
name: release
description: Cut and ship a new version of the Everything Markdown Firefox add-on — clean up, bump, lint, build, sign to AMO, and refresh the store listing (metadata, screenshots, source) via the AMO API. Use when asked to "release", "ship", "publish", "build a new version", "upload to Firefox/AMO", or to regenerate the banner/icon/screenshots.
---

# Releasing Everything Markdown

End-to-end, mostly automated. Everything scriptable is a script under `tools/`;
this file is the order to run them in and the decisions to make.

## 0. Preconditions

- `node` ≥ 18, `npx` available (web-ext is fetched on demand).
- Firefox installed. Scripts autodetect the macOS app path; override with
  `FIREFOX_BIN` elsewhere.
- For any AMO step: `AMO_ISSUER` + `AMO_SECRET` in the environment
  (<https://addons.mozilla.org/developers/addon/api/key/>). Never commit them.
- Work on `main`, tree clean. Commit after each numbered step with a focused
  message; end messages with the `Co-Authored-By: Claude Sonnet 5` trailer.

## 1. Clean up the code

```bash
# strip trailing whitespace from the extension sources (no behaviour change)
cd Firefox && sed -i '' -E 's/[[:space:]]+$//' app.js background.js content.js popup.js && cd ..
for f in Firefox/{app,background,content,popup}.js; do node --check "$f" || exit 1; done
grep -nE "TODO|FIXME|XXX|debugger|console\.log" Firefox/*.js   # review any hits by hand
```

Also worth a look each release: unused `<defs>` in `docs/banner.svg` /
`Firefox/icons/icon.svg`, and dead code in the diff since the last tag.

## 2. Bump the version

Edit `Firefox/manifest.json` `"version"`. Semver-ish: patch for fixes, minor for
features. Note it for the changelog in `docs/STORE_LISTING.md` → "What's new".

Leave these alone — changing them orphans installs / data:
`browser_specific_settings.gecko.id`, the `EverythingMD_DB` Dexie name.

## 3. Lint & build

```bash
./build.sh          # web-ext lint (must be 0/0/0) + web-ext build -> Firefox/web-ext-artifacts/
```

## 4. Regenerate art (only if the icon/banner changed)

`Firefox/icons/icon.svg` is the single source; the banner embeds a scaled copy.
After editing either SVG:

```bash
node tools/render-svg.mjs docs/banner.svg docs/banner.png 2      # 2x flatten for the README
```

The README uses the PNG (GitHub doesn't reliably rasterise emoji/complex SVG).
`icon.svg` ships as-is in the manifest (`icons` + `action.default_icon`).

## 5. Regenerate screenshots (if the UI changed)

```bash
node tools/screenshots/capture.mjs   # -> docs/screenshot.png, -screenshot-highlights.png, -screenshot-search.png
```

Drives the real manager in headless Firefox via Marionette (builds a throwaway
`Firefox/_demo.html` with a `browser.storage.local` shim, seeds folders/docs,
opens one, applies highlights, runs a search). Deletes the temp file on exit.

## 6. Sign & publish to AMO

```bash
cd Firefox
WEB_EXT_API_KEY="$AMO_ISSUER" WEB_EXT_API_SECRET="$AMO_SECRET" \
  npx --yes web-ext sign --channel listed --timeout 600000
cd ..
```

`listed` → the version goes public after AMO validation (usually auto-approved in
a minute or two; then it's live, no queue). A signed `.xpi` lands in
`web-ext-artifacts/`. `Firefox/.amo-upload-uuid` is written by web-ext and is
gitignored.

## 7. Refresh the store listing (AMO API — no review, applies live)

Edit `tools/amo/listing.json` first if the copy changed (summary, description,
tags, categories are the single source of truth there; keep
`docs/STORE_LISTING.md` in prose sync).

```bash
node tools/amo/metadata.mjs      # PATCH summary + description (en-US, zh-CN) + tags + categories

git archive --format=tar.gz --prefix=everything-markdown/ -o /tmp/em-src.tar.gz HEAD
AMO_SOURCE=/tmp/em-src.tar.gz node tools/amo/finish-listing.mjs   # screenshots + captions + source archive
```

### AMO rate limiting

Write endpoints (PATCH/POST/DELETE) throttle hard. After ~10–15 writes in a few
minutes the `429` retry-after can climb to **30–40 minutes**. Both scripts sleep
through it and are safe to re-run (`finish-listing.mjs` clears and recreates
previews each run). GETs are never throttled. Plan step 7 as: run `metadata.mjs`
once, wait, run `finish-listing.mjs` — or just start `finish-listing.mjs` in the
background and let it grind.

Tags must come from AMO's fixed vocabulary: `curl -s
https://addons.mozilla.org/api/v5/addons/tags/`. Applicable here: `chat`,
`google`, `privacy`.

## 8. Commit & push

Commit the version bump, regenerated art/screenshots, and any `listing.json` /
`STORE_LISTING.md` edits. Push `main`. The `web-ext-artifacts/` zip and
`.amo-upload-uuid` are gitignored — don't commit them.

## Verify

```bash
curl -s https://addons.mozilla.org/api/v5/addons/addon/everything-md/ \
 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);
   console.log("status",a.status,"| version",a.current_version.version);
   console.log("summary",Object.keys(a.summary||{}),"| desc",Object.keys(a.description||{}));
   console.log("tags",a.tags,"| cats",a.categories,"| previews",(a.previews||[]).length);})'
```

(The public API is CDN-cached ~minutes; the authenticated GET in the scripts is fresh.)
