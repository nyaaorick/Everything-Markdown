// Shared AMO API v5 helpers: JWT auth + rate-limit-aware fetch.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const ISSUER = process.env.AMO_ISSUER;
const SECRET = process.env.AMO_SECRET;

export function requireCreds() {
  if (!ISSUER || !SECRET) {
    console.error("Set AMO_ISSUER and AMO_SECRET — get them from");
    console.error("  https://addons.mozilla.org/developers/addon/api/key/");
    process.exit(2);
  }
}

const b64 = (x) => Buffer.from(x).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export function jwt() {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const iat = Math.floor(Date.now() / 1e3);
  const body = b64(JSON.stringify({ iss: ISSUER, jti: crypto.randomBytes(16).toString("hex"), iat, exp: iat + 240 }));
  const sig = crypto.createHmac("sha256", SECRET).update(head + "." + body).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${head}.${body}.${sig}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch that transparently waits out AMO's 429 write throttle.
export async function amo(url, opts = {}, label = "") {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "JWT " + jwt() } });
    if (r.status !== 429) return r;
    const wait = (Number((await r.text()).match(/available in (\d+)/)?.[1]) || 60) + 5;
    console.log(`  ${label || url}: rate-limited, sleeping ${wait}s`);
    await sleep(wait * 1000);
  }
  throw new Error("gave up retrying " + (label || url));
}

export function multipart(fields, fileField, filePath, contentType) {
  const B = "----amo" + crypto.randomBytes(12).toString("hex");
  const chunks = [];
  for (const [k, v] of Object.entries(fields))
    chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${basename(filePath)}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  chunks.push(readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${B}--\r\n`));
  return { body: Buffer.concat(chunks), boundary: B };
}

export const apiBase = (addonId) =>
  "https://addons.mozilla.org/api/v5/addons/addon/" + encodeURIComponent(addonId);
