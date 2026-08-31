#!/usr/bin/env node
// Rasterise an SVG to PNG with headless Firefox (no native deps).
//
// Usage:  node tools/render-svg.mjs <in.svg> <out.png> [scale]
// e.g.    node tools/render-svg.mjs docs/banner.svg docs/banner.png 2
//         node tools/render-svg.mjs Firefox/icons/icon.svg /tmp/icon-128.png   # (uses intrinsic size)

import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FF = process.env.FIREFOX_BIN
  || (fs.existsSync("/Applications/Firefox.app/Contents/MacOS/firefox")
    ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");

const [inSvg, outPng, scaleArg] = process.argv.slice(2);
if (!inSvg || !outPng) {
  console.error("usage: node tools/render-svg.mjs <in.svg> <out.png> [scale]");
  process.exit(2);
}
const scale = Number(scaleArg) || 1;

const src = fs.readFileSync(inSvg, "utf8");
const wh = src.match(/width="(\d+)"\s+height="(\d+)"/);
if (!wh) { console.error("SVG needs explicit width/height attributes"); process.exit(1); }
const w = Number(wh[1]) * scale;
const h = Number(wh[2]) * scale;

const scaled = src.replace(/width="\d+"\s+height="\d+"/, `width="${w}" height="${h}"`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "em-svg-"));
const tmpSvg = path.join(tmp, "in.svg");
const profile = path.join(tmp, "profile");
fs.writeFileSync(tmpSvg, scaled);

try { execSync("pkill -f 'firefox.*headless'"); } catch {}

const r = spawnSync(FF, [
  "--headless", "--profile", profile, "--window-size", `${w},${h}`,
  "--screenshot", outPng, "file://" + tmpSvg,
], { stdio: "ignore", timeout: 60000 });

fs.rmSync(tmp, { recursive: true, force: true });

if (!fs.existsSync(outPng)) { console.error("render failed", r.status); process.exit(1); }
console.log(`wrote ${outPng} (${w}x${h})`);
