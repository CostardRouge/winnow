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
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
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
      else reject(new Error(`ffmpeg code ${code}: ${stderr.slice(-400).trim()}`));
    });
  });
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
    await run(
      ["-y", "-i", input, "-vf", "thumbnail=n=50", "-frames:v", "1", "-an", poster],
      120_000,
    );
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
