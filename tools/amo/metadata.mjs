#!/usr/bin/env node
// Push listing metadata (summary, description, tags, categories) to AMO from
// tools/amo/listing.json. Text-only fields — no review needed, applies live.
//
// Usage:  AMO_ISSUER=… AMO_SECRET=… node tools/amo/metadata.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireCreds, amo, apiBase } from "./lib.mjs";

requireCreds();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "listing.json"), "utf8"));
const API = apiBase(cfg.addon_id);

const payload = {
  summary: cfg.summary,
  description: cfg.description,
  tags: cfg.tags,
  categories: cfg.categories,
};

const r = await amo(API + "/", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
}, "metadata");

const j = await r.json();
if (!r.ok) { console.error("FAILED", r.status, JSON.stringify(j).slice(0, 800)); process.exit(1); }

console.log("PATCH metadata ->", r.status);
console.log("  summary locales:    ", Object.keys(j.summary || {}));
console.log("  description locales:", Object.keys(j.description || {}));
console.log("  tags:              ", JSON.stringify(j.tags));
console.log("  categories:        ", JSON.stringify(j.categories));
