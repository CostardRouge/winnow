// EXIF / HEIF orientation readers, isolated from the rest of extract.ts so the
// web process can reuse them (the HEIC-rotation diagnostic) without pulling in
// sharp / heic-convert. Only depends on exiftool-vendored (a server external).
import { exiftool } from "exiftool-vendored";

// Numeric EXIF orientation (1-8) of the original. `-n` disables exiftool's
// "human" conversion to obtain the raw integer.
export async function readOrientation(
  absPath: string,
): Promise<number | undefined> {
  try {
    const tags = await exiftool.read(absPath, ["-n"]);
    const o = (tags as { Orientation?: unknown }).Orientation;
    return typeof o === "number" ? o : undefined;
  } catch {
    return undefined;
  }
}

// HEIF orientation can live in two places: the container transformative property
// (`irot`/`imir`) and the EXIF `Orientation` tag. libheif (heic-convert) applies
// the container transform when decoding but ignores EXIF — and per the HEIF spec
// the container transform supersedes EXIF anyway. exiftool surfaces the container
// rotation as the `Rotation` tag, present iff the file carries an `irot` box, so
// we use it to tell whether libheif's output is already display-oriented. When it
// is, the worker must NOT re-apply EXIF (that would rotate the pixels twice).
export async function readHeicOrientation(
  absPath: string,
): Promise<{ exif: number | undefined; containerRotated: boolean }> {
  try {
    const tags = await exiftool.read(absPath, ["-n"]);
    const o = (tags as { Orientation?: unknown }).Orientation;
    const r = (tags as { Rotation?: unknown }).Rotation;
    return {
      exif: typeof o === "number" ? o : undefined,
      containerRotated: r != null,
    };
  } catch {
    return { exif: undefined, containerRotated: false };
  }
}
