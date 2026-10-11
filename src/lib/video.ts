// Video derivatives via ffmpeg (spawn — no npm dependency).
//   - Poster (thumbnail): a representative image → WebP (like the photos).
//   - Proxy: lightweight H.264 mp4, playable in the browser (faststart).
// Hardware acceleration (VAAPI) is OPTIONAL and covers only ENCODING
// (decoding/resizing stays in software, much more robust); on
// hardware failure, automatic fallback to software libx264.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config";

function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // -hide_banner: the stored error is the last 400 characters of stderr, and
    // the build banner used to fill most of them before the actual cause.
    const proc = spawn("ffmpeg", ["-hide_banner", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg: timeout exceeded"));
    }, timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${ffmpegHint(stderr)}ffmpeg code ${code}: ${stderr.slice(-400).trim()}`));
    });
  });
}

// A plain-words cause ahead of ffmpeg's own, for the failure no rerun can fix.
// A camera writes the `moov` index at the END of a clip, so a copy cut short
// (a sync or transfer interrupted — seen on the instance at whole-MiB sizes)
// keeps a readable start and loses the index; a copy whose first bytes are
// garbage hides an intact one. Either way the file is broken and only a fresh
// copy from the phone/card repairs it. Exported for the tests.
export function ffmpegHint(stderr: string): string {
  return /moov atom not found/.test(stderr)
    ? "Damaged file: no readable moov index (an incomplete or corrupt copy — copy it again from the source). "
    : "";
}

let _available: boolean | null = null;
export async function ffmpegAvailable(): Promise<boolean> {
  if (_available != null) return _available;
  try {
    await run(["-version"], 5000);
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

// Scaling filter: height capped at H, without enlargement, even
// dimensions (required by yuv420p). Width derived (-2) to keep the ratio.
function scaleFilter(): string {
  const h = config.video.proxyHeight;
  return `scale=-2:min(${h}\\,trunc(ih/2)*2)`;
}

// WebP poster (grid thumbnail). We extract a representative image.
export async function makeVideoThumb(input: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-vid-"));
  const poster = path.join(dir, "poster.jpg");
  try {
    try {
      // `thumbnail` scores 50 frames and keeps the most representative one.
      await run(
        ["-y", "-i", input, "-vf", "thumbnail=n=50", "-frames:v", "1", "-an", poster],
        120_000,
      );
    } catch {
      // Some containers/codecs choke on the thumbnail filter, and very short
      // clips have too few frames: fall back to grabbing the first frame so a
      // video still gets a poster instead of erroring out.
      await run(["-y", "-i", input, "-frames:v", "1", "-an", poster], 120_000);
    }
    return await sharp(poster)
      .rotate()
      .resize(config.thumbSize, config.thumbSize, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: config.thumbQuality })
      .toBuffer();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Playable mp4 proxy. Returns the transcoded bytes.
export async function makeVideoProxy(input: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-vid-"));
  const out = path.join(dir, "proxy.mp4");
  const crf = String(config.video.proxyCrf);
  const TIMEOUT = 60 * 60_000; // 1 h: a long clip can be slow in software

  const software = [
    "-y", "-i", input,
    "-vf", scaleFilter(),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    out,
  ];
  const vaapi = [
    "-y", "-vaapi_device", config.video.vaapiDevice, "-i", input,
    "-vf", `${scaleFilter()},format=nv12,hwupload`,
    "-c:v", "h264_vaapi", "-qp", crf,
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    out,
  ];

  try {
    if (config.video.hwaccel === "vaapi") {
      try {
        await run(vaapi, TIMEOUT);
      } catch (e) {
        console.warn(
          "[video] VAAPI encoding failed, software fallback:",
          (e as Error).message,
        );
        await run(software, TIMEOUT);
      }
    } else {
      await run(software, TIMEOUT);
    }
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
