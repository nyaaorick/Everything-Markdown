# AMO automation

The addons.mozilla.org listing is driven almost entirely by API. Full release
procedure: [`.claude/skills/release/SKILL.md`](../../.claude/skills/release/SKILL.md).

| Task | Command |
|------|---------|
| Sign & publish a new version | `cd Firefox && WEB_EXT_API_KEY=$AMO_ISSUER WEB_EXT_API_SECRET=$AMO_SECRET npx web-ext sign --channel listed` |
| Summary / description / tags / categories | `node tools/amo/metadata.mjs` |
| Screenshots + captions (+ source, with `AMO_SOURCE`) | `node tools/amo/finish-listing.mjs` |

## Files

- `listing.json` — single source of truth for summary, description (en-US +
  zh-CN), tags, categories, and screenshot captions. Edit here; keep
  `docs/STORE_LISTING.md` in prose sync.
- `lib.mjs` — JWT auth + rate-limit-aware `fetch` + multipart builder.
- `metadata.mjs` — PATCHes the text fields. No review, applies live.
- `finish-listing.mjs` — recreates previews with captions; attaches a source
  tarball when `AMO_SOURCE` points at a `.tar.gz`.

## Credentials

From <https://addons.mozilla.org/developers/addon/api/key/>. Env only:

```bash
export AMO_ISSUER='user:XXXXXXXX:XXX'
export AMO_SECRET='…'
```

## Rate limits

AMO throttles write endpoints hard — after a burst the `429` cooldown can be
30–40 min. The scripts sleep through it and are safe to re-run
(`finish-listing.mjs` clears and recreates previews each time). GETs are fine.
