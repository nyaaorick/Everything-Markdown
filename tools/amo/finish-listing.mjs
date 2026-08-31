#!/usr/bin/env node
// Upload screenshots (with captions, from tools/amo/listing.json) and, if
// AMO_SOURCE points at a .tar.gz, attach it as the source archive for the
// current listed version. Rate-limit aware; safe to re-run (previews are
// cleared and recreated each run).
//
// Usage:
//   AMO_ISSUER=… AMO_SECRET=… node tools/amo/finish-listing.mjs
//   AMO_ISSUER=… AMO_SECRET=… AMO_SOURCE=/tmp/src.tar.gz node tools/amo/finish-listing.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireCreds, amo, apiBase, multipart } from "./lib.mjs";

requireCreds();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "listing.json"), "utf8"));
const API = apiBase(cfg.addon_id);
const SOURCE = process.env.AMO_SOURCE || "";

const detail = () => amo(API + "/", {}, "detail").then((r) => r.json());

async function screenshots() {
  const d = await detail();
  for (const pv of d.previews || []) {
    const r = await amo(`${API}/previews/${pv.id}/`, { method: "DELETE" }, "delete " + pv.id);
    console.log("deleted preview", pv.id, r.status);
  }
  for (let i = 0; i < cfg.screenshots.length; i++) {
    const { file, caption } = cfg.screenshots[i];
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) { console.log("skip (missing)", file); continue; }
    const { body, boundary } = multipart({ position: String(i) }, "image", abs, "image/png");
    const r = await amo(`${API}/previews/`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
      body,
    }, "upload " + file);
    const j = await r.json();
    console.log(`uploaded ${file} -> ${r.status} id=${j.id}`);
    if (!r.ok) { console.log("  ", JSON.stringify(j).slice(0, 400)); continue; }
    const pr = await amo(`${API}/previews/${j.id}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: { "en-US": caption } }),
    }, "caption " + j.id);
    console.log(`  caption -> ${pr.status}`);
  }
}

async function source() {
  if (!SOURCE) { console.log("AMO_SOURCE not set — skipping source upload"); return; }
  const versionId = (await detail()).current_version?.id;
  if (!versionId) { console.log("no current_version id"); return; }
  const { body, boundary } = multipart({}, "source", SOURCE, "application/gzip");
  const r = await amo(`${API}/versions/${versionId}/`, {
    method: "PATCH",
    headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
    body,
  }, "source");
  console.log(`source -> ${r.status} (version ${versionId})`);
}

await screenshots();
await source();

const f = await detail();
console.log("\nDONE. previews:", (f.previews || []).map((p) => ({ id: p.id, pos: p.position, caption: !!p.caption })));
