# tools/

Release and maintenance automation. The ordered procedure that ties these
together is [`.claude/skills/release/SKILL.md`](../.claude/skills/release/SKILL.md).

| Path | What |
|------|------|
| `render-svg.mjs` | Rasterise an SVG to PNG with headless Firefox. `node tools/render-svg.mjs <in.svg> <out.png> [scale]` |
| `screenshots/capture.mjs` | Drive the real manager UI in headless Firefox (Marionette) and write the three `docs/screenshot*.png` |
| `screenshots/lib-marionette.mjs` | Zero-dependency Marionette client used by `capture.mjs` |
| `amo/metadata.mjs` | PATCH the AMO listing text (summary, description, tags, categories) from `amo/listing.json` |
| `amo/finish-listing.mjs` | Upload screenshots + captions, and a source tarball (`AMO_SOURCE=…`) |
| `amo/lib.mjs` | AMO JWT auth + rate-limit-aware fetch |
| `amo/listing.json` | Single source of truth for the listing copy |

No secrets live here — AMO credentials come from `AMO_ISSUER` / `AMO_SECRET` in
the environment.
