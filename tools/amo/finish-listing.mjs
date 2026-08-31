#!/usr/bin/env node
// Finish the AMO listing: upload screenshots (with captions) and attach the
// source tarball for the current listed version. Idempotent-ish: it clears
// existing previews first. Retries through AMO's write rate limit.
//
// Usage:
//   AMO_ISSUER='user:XXXX:XX' AMO_SECRET='...' node tools/amo/finish-listing.mjs
//
// AMO throttles write endpoints aggressively; after a burst the cooldown can be
// tens of minutes. The script will wait it out, or you can re-run it later — it
// picks up from wherever it is (previews are recreated, source re-attached).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ADDON_ID = "everything-md@nyaaorick.com";
const API = "https://addons.mozilla.org/api/v5/addons/addon/" + encodeURIComponent(ADDON_ID);

const ISSUER = process.env.AMO_ISSUER;
const SECRET = process.env.AMO_SECRET;
if (!ISSUER || !SECRET) {
  console.error("Set AMO_ISSUER and AMO_SECRET (from addons.mozilla.org/developers/addon/api/key/).");
  process.exit(2);
}

const SCREENSHOTS = [
  ["docs/screenshot.png", "CodeMirror 6 editor with a resizable live preview — headings, tables, blockquotes and KaTeX math"],
  ["docs/screenshot-highlights.png", "Colour highlights on the preview, anchored to block + offset so they survive bold / italic / link edits"],
  ["docs/screenshot-search.png", "Folder tree and instant full-text search across every note"],
];
const SOURCE_TARBALL = process.env.AMO_SOURCE || "";  // optional path to a .tar.gz; skipped if empty

const b64 = (x) => Buffer.from(x).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = () => {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1e3);
  const body = b64(JSON.stringify({ iss: ISSUER, jti: crypto.randomBytes(16).toString("hex"), iat, exp: iat + 240 }));
  const sig = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${head}.${body}.${sig}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, opts = {}, label = "") {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "JWT " + jwt() } });
    if (r.status !== 429) return r;
    const wait = (Number((await r.text()).match(/available in (\d+)/)?.[1]) || 60) + 5;
    console.log(`  ${label}: rate-limited, sleeping ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error("gave up retrying " + label);
}

function multipart(fields, fileField, filePath, contentType) {
  const B = "----amo" + crypto.randomBytes(12).toString("hex");
  const chunks = [];
  for (const [k, v] of Object.entries(fields))
    chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${path.basename(filePath)}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${B}--\r\n`));
  return { body: Buffer.concat(chunks), boundary: B };
}

const detail = () => req(API + "/", {}, "detail").then((r) => r.json());

async function uploadScreenshots() {
  const d = await detail();
  for (const pv of d.previews || []) {
    const r = await req(`${API}/previews/${pv.id}/`, { method: "DELETE" }, "delete " + pv.id);
    console.log("deleted preview", pv.id, r.status);
  }
  for (let i = 0; i < SCREENSHOTS.length; i++) {
    const [rel, caption] = SCREENSHOTS[i];
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { console.log("skip (missing)", rel); continue; }
    const { body, boundary } = multipart({ position: String(i) }, "image", abs, "image/png");
    const r = await req(`${API}/previews/`, { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary }, body }, "upload " + rel);
    const j = await r.json();
    console.log(`uploaded ${rel} -> ${r.status} id=${j.id}`);
    if (r.ok) {
      const pr = await req(`${API}/previews/${j.id}/`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption: { "en-US": caption } }),
      }, "caption " + j.id);
      console.log(`  caption -> ${pr.status}`);
    }
  }
}

async function attachSource() {
  if (!SOURCE_TARBALL) { console.log("AMO_SOURCE not set — skipping source upload"); return; }
  const d = await detail();
  const versionId = d.current_version?.id;
  if (!versionId) { console.log("no current_version id"); return; }
  const { body, boundary } = multipart({}, "source", SOURCE_TARBALL, "application/gzip");
  const r = await req(`${API}/versions/${versionId}/`, {
    method: "PATCH", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary }, body,
  }, "source");
  console.log(`source -> ${r.status} (version ${versionId})`);
}

await uploadScreenshots();
await attachSource();

const f = await detail();
console.log("\nDONE. previews:", (f.previews || []).map((p) => ({ id: p.id, pos: p.position, caption: !!p.caption })));
