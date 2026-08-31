# AMO automation

The addons.mozilla.org listing is driven almost entirely by API. What's scripted:

| Task | How |
|------|-----|
| Upload / sign a new version | `cd Firefox && WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… npx web-ext sign --channel listed` |
| Summary, description, tags, categories | `PATCH /api/v5/addons/addon/{id}/` (done — see `docs/STORE_LISTING.md` for the text) |
| Screenshots + captions | `tools/amo/finish-listing.mjs` |
| Source tarball for a version | `tools/amo/finish-listing.mjs` with `AMO_SOURCE=…` |

## Credentials

API key + secret from <https://addons.mozilla.org/developers/addon/api/key/>. Pass via env only —
never commit them.

```bash
export AMO_ISSUER='user:XXXXXXXX:XXX'
export AMO_SECRET='…'
```

## Finish the listing

```bash
# from repo root
node tools/amo/finish-listing.mjs

# also attach source for the current listed version:
git archive --format=tar.gz --prefix=everything-markdown/ -o /tmp/src.tar.gz HEAD
AMO_SOURCE=/tmp/src.tar.gz node tools/amo/finish-listing.mjs
```

**Rate limits:** AMO throttles write endpoints hard — after a burst the cooldown can be
30–40 min. The script waits it out; you can also just re-run it later (it clears and
recreates previews each run, so it's safe to repeat).
