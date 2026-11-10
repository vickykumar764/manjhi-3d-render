// Manjhi 3D short — STILLS-based shard renderer (the correct render path).
//
// WHY STILLS, NOT `remotion render`:
// `remotion render` (multi-frame, same browser page) TILES every frame after the
// first at 1080x1920 under SwiftShader — the mountain/sky repeats ~5x vertically
// with a vertical seam at 780px (measured 2026-11-10, frames 1-9 of the Actions
// speed test, and reproduced locally). The defect is in Chrome/SwiftShader's
// compositor/screenshot path when a large WebGL canvas is re-presented in the
// same page session — NOT in our scene code. Proven by elimination:
//   * post chain OFF still tiles (PostDriver/Ink/LensBlur/Bloom/Grade exonerated)
//   * single-frame render (--frames=1-1) is CORRECT; a fresh page is always correct
//   * per-frame Canvas remount (fresh WebGL context, key={frame}) still tiles
//   * preserveDrawingBuffer:true blanks the render + OOMs the VM (reverted)
//   * --gl angle-egl has no WebGL context here; scale 0.5 ALSO tiles (V period 490)
//   * renderStill (fresh browser + fresh page per frame) is CORRECT at full 1080x1920
// So each frame is rendered as a still (fresh page) and the shard is encoded with
// ffmpeg. Output specs are unchanged: 1080x1920, 30fps, h264 crf 16.
//
// usage:
//   node scripts/manjhi-render-shard.mjs <shardIndex> <numShards> [--out out/part-N.mp4]
//   node scripts/manjhi-render-shard.mjs --frames <start>-<end> [--out out/speed-test-10.mp4]
// Env: MANJHI_CHROME (browser executable; default: Playwright Chromium, then headless shell)
//      REMOTION_TMP (must point at a big-drive folder; every bundle copies public/ into it)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
if (process.env.REMOTION_TMP) { fs.mkdirSync(process.env.REMOTION_TMP, { recursive: true }); process.env.TEMP = process.env.TMP = process.env.REMOTION_TMP; }
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const args = process.argv.slice(2);
let start, end, outMp4;
const outIdx = args.indexOf("--out");
outMp4 = outIdx >= 0 ? args[outIdx + 1] : null;
if (args[0] === "--frames") {
  [start, end] = args[1].split("-").map(Number);
  if (!outMp4) outMp4 = "out/speed-test.mp4";
} else {
  const shard = Number(args[0]), numShards = Number(args[1]);
  if (!outMp4) outMp4 = `out/part-${shard}.mp4`;
  // total frames are read from the composition below; shard range is computed after bundling.
  start = null; end = null;
  var shardIndex = shard, totalShards = numShards;
}

const candidates = [
  process.env.MANJHI_CHROME,
  `${process.env.HOME}/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`,
  "node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell",
].filter(Boolean);
const browserExecutable = candidates.find((c) => fs.existsSync(path.resolve(c)));
if (!browserExecutable) { console.error("No Chrome/Chromium executable found (set MANJHI_CHROME)"); process.exit(1); }
console.log("Chrome:", browserExecutable);

// Remotion 4.0.542: gl:"swangle" -> --use-gl=angle --use-angle=swiftshader (the proven WebGL path).
const chromiumOptions = { gl: "swangle" };
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts"), publicDir: path.resolve("public") });
const composition = await selectComposition({ serveUrl, id: "ManjhiShort", browserExecutable, chromiumOptions });
const total = composition.durationInFrames;
const fps = composition.fps;
console.log(`Composition: ${composition.width}x${composition.height} ${fps}fps ${total} frames`);
if (start === null) {
  const shardSize = Math.ceil(total / totalShards);
  start = shardIndex * shardSize;
  end = Math.min(start + shardSize - 1, total - 1);
}
const count = end - start + 1;
console.log(`Rendering frames ${start}-${end} (${count} frames) -> ${outMp4}`);
const framesDir = path.resolve(path.dirname(outMp4), `shardframes-${start}-${end}`);
fs.mkdirSync(framesDir, { recursive: true });
const onBrowserLog = (l) => { if (l.type === "error" || l.type === "warning") console.log(`[${l.type}]`, l.text.slice(0, 300)); };
const t0 = Date.now();
for (let f = start; f <= end; f++) {
  const ft0 = Date.now();
  await renderStill({
    composition, serveUrl, frame: f,
    output: path.join(framesDir, `frame_${String(f).padStart(4, "0")}.jpg`),
    imageFormat: "jpeg", jpegQuality: 90, scale: 1.0,
    browserExecutable, chromiumOptions, timeoutInMilliseconds: 300000, onBrowserLog,
  });
  console.log(`still ${f} ${((Date.now() - ft0) / 1000).toFixed(1)}s (elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
const renderSeconds = (Date.now() - t0) / 1000;
console.log(`STILLS_DONE frames=${count} RENDER_SECONDS=${renderSeconds.toFixed(1)} SECONDS_PER_FRAME=${(renderSeconds / count).toFixed(2)}`);
// Encode the shard to mp4 (30fps, h264, crf 16, yuv420p).
fs.mkdirSync(path.dirname(path.resolve(outMp4)), { recursive: true });
execFileSync("ffmpeg", [
  "-y", "-framerate", String(fps), "-start_number", String(start),
  "-i", path.join(framesDir, "frame_%04d.jpg"),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart",
  path.resolve(outMp4),
], { stdio: "inherit" });
execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames,duration", "-of", "default=noprint_wrappers=1", path.resolve(outMp4)], { stdio: "inherit" });
console.log(`ENCODED ${outMp4}`);
// Free disk: the JPEG intermediates are no longer needed once the mp4 exists.
fs.rmSync(framesDir, { recursive: true, force: true });
console.log(`DONE ${outMp4} total_seconds=${((Date.now() - t0) / 1000).toFixed(1)}`);
