// Dérivés vidéo via ffmpeg (spawn — pas de dépendance npm).
//   - Poster (vignette) : une image représentative → WebP (comme les photos).
//   - Proxie : mp4 H.264 léger, rejouable dans le navigateur (faststart).
// L'accélération matérielle (VAAPI) est OPTIONNELLE et ne couvre que l'ENCODAGE
// (le décodage/redimensionnement reste logiciel, bien plus robuste) ; en cas
// d'échec matériel, repli automatique sur libx264 logiciel.
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
      reject(new Error("ffmpeg: délai dépassé"));
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

// Filtre de mise à l'échelle : hauteur bornée à H, sans agrandissement, dims
// paires (requis par yuv420p). Largeur dérivée (-2) pour garder le ratio.
function scaleFilter(): string {
  const h = config.video.proxyHeight;
  return `scale=-2:min(${h}\\,trunc(ih/2)*2)`;
}

// Poster WebP (vignette de grille). On extrait une image représentative.
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

// Proxie mp4 rejouable. Renvoie les octets transcodés.
export async function makeVideoProxy(input: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "winnow-vid-"));
  const out = path.join(dir, "proxy.mp4");
  const crf = String(config.video.proxyCrf);
  const TIMEOUT = 60 * 60_000; // 1 h : un long clip peut être lent en logiciel

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
          "[video] encodage VAAPI échoué, repli logiciel :",
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
