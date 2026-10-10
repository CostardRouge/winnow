// The camera a DJI clip names inside its own timed-metadata track.
//
// A DJI MP4 carries no Make/Model atom (docs/memory/pipeline.md, "A DJI clip
// carries no camera at all"), so the indexer's EXIF read leaves its body
// empty. The camera IS in the file, though: the `djmd` track's first sample is
// a protobuf header naming the aircraft (`DJI Mini4 Pro`), its serial number,
// and — the field that matters — the camera exactly as the same camera spells
// itself on its stills (`DJI FC8482`, Make + Model). Measured on two real
// Mini 4 Pro clips of the library, 2026-10-10.
//
// Why not exiftool `-ee`, which decodes the same fields: it walks EVERY
// sample of the track — one seek and one read per frame, 13 000 of them in a
// 3.7 GB, 223 s clip — to deliver values that live in the first sample only.
// This reader does what that one answer needs: the top-level box headers, the
// `moov` children it must cross, the `djmd` track's own tables, and one
// sample. A handful of small reads, whatever the clip weighs, which is what
// lets the probe run over a library on a spinning NAS disk.
//
// It never writes and never holds the file open past one call. Pure in the
// sense that matters for tests: everything below `probeDjiTrack` works on
// buffers, so a synthetic MP4 exercises it end to end.
import { open, type FileHandle } from "node:fs/promises";

/** What the header sample says. Every field is the file's own string. */
export type DjiTrackInfo = {
  /** The proto the camera wrote, e.g. `dvtm_Mini4_Pro.proto`. */
  protocol: string | null;
  /** The product as the file names it, e.g. `DJI Mini4 Pro`. */
  model: string | null;
  /** The aircraft's serial number. */
  serial: string | null;
  /** The camera as its stills spell it (Make + Model), e.g. `DJI FC8482` —
   *  the value `assets.device` already groups the stills under. */
  camera: string | null;
};

// Field paths inside the header sample, in ExifTool's numbering
// (Image::ExifTool::DJI: `dvtm_Mini4_Pro_1-1-10` → Model, `…_1-1-5` →
// SerialNumber). The camera string has no ExifTool name; it sits at 2-2-1-4
// in the stream header and again at 3-2-1-4 in every frame record. Only the
// Mini 4 Pro has been seen — it is the one DJI body in this library — so an
// unknown proto that moves the camera elsewhere comes back with `camera: null`
// and its model and serial still recorded, never a guess.
const PATH_PROTOCOL = "1.1.1";
const PATH_SERIAL = "1.1.5";
const PATH_MODEL = "1.1.10";
const PATHS_CAMERA = ["2.2.1.4", "3.2.1.4"];

// Bounds that keep a malformed or hostile file from turning one probe into a
// large read: a track box or a header sample past these is not a DJI header.
const MAX_TRAK_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 256 * 1024;
const MAX_BOXES = 4096;

type Box = { type: string; start: number; size: number; header: number };

/** Box header at `off` inside `buf`, or null when it does not fit. */
function boxAt(buf: Buffer, off: number, end: number): Box | null {
  if (off + 8 > end) return null;
  let size = buf.readUInt32BE(off);
  const type = buf.toString("latin1", off + 4, off + 8);
  let header = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(off + 8));
    header = 16;
  } else if (size === 0) {
    size = end - off;
  }
  if (size < header || off + size > end) return null;
  return { type, start: off, size, header };
}

/** The children of a container box held in `buf`. */
function children(buf: Buffer, from: number, end: number): Box[] {
  const out: Box[] = [];
  let off = from;
  while (off < end && out.length < MAX_BOXES) {
    const b = boxAt(buf, off, end);
    if (!b) break;
    out.push(b);
    off += b.size;
  }
  return out;
}

function child(buf: Buffer, parent: Box, type: string): Box | null {
  return (
    children(buf, parent.start + parent.header, parent.start + parent.size).find(
      (b) => b.type === type,
    ) ?? null
  );
}

/**
 * Where the first sample of a `djmd` track lies, read off one `trak` box, or
 * null when the track is anything else. The first sample of the first chunk
 * starts at that chunk's offset, so `stsc` is not needed.
 */
export function djmdFirstSample(
  trak: Buffer,
): { offset: number; size: number } | null {
  const root = boxAt(trak, 0, trak.length);
  if (!root || root.type !== "trak") return null;
  const mdia = child(trak, root, "mdia");
  if (!mdia) return null;
  const hdlr = child(trak, mdia, "hdlr");
  // hdlr: version/flags (4), pre_defined (4), handler_type (4).
  if (!hdlr || trak.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) !== "meta")
    return null;
  const minf = child(trak, mdia, "minf");
  const stbl = minf && child(trak, minf, "stbl");
  if (!stbl) return null;
  const stsd = child(trak, stbl, "stsd");
  // stsd: version/flags (4), entry_count (4), then the first entry's box.
  if (!stsd) return null;
  const entry = boxAt(trak, stsd.start + stsd.header + 8, stsd.start + stsd.size);
  if (!entry || entry.type !== "djmd") return null;

  const stsz = child(trak, stbl, "stsz");
  if (!stsz) return null;
  const p = stsz.start + stsz.header;
  // stsz: version/flags (4), sample_size (4), sample_count (4), entries.
  const constant = trak.readUInt32BE(p + 4);
  const count = trak.readUInt32BE(p + 8);
  if (count === 0) return null;
  const size = constant || trak.readUInt32BE(p + 12);

  let offset: number | null = null;
  const stco = child(trak, stbl, "stco");
  const co64 = child(trak, stbl, "co64");
  // stco/co64: version/flags (4), entry_count (4), entries.
  if (stco && trak.readUInt32BE(stco.start + stco.header + 4) > 0)
    offset = trak.readUInt32BE(stco.start + stco.header + 8);
  else if (co64 && trak.readUInt32BE(co64.start + co64.header + 4) > 0)
    offset = Number(trak.readBigUInt64BE(co64.start + co64.header + 8));
  if (offset == null || size === 0) return null;
  return { offset, size };
}

// --------------------------------------------------------------- protobuf ----

function varint(buf: Buffer, at: number): [value: number, next: number] | null {
  let v = 0;
  let mul = 1;
  for (let i = at; i < buf.length && i < at + 10; i++) {
    const b = buf[i];
    v += (b & 0x7f) * mul;
    if (b < 0x80) return [v, i + 1];
    mul *= 128;
  }
  return null;
}

// A length-delimited field is either a string or a nested message, and the
// wire format does not say which. A run of printable UTF-8 is a string — a
// message almost always starts with a tag byte below 0x20 (0x08, 0x0a, 0x12…)
// — and anything else is tried as a message, the way ExifTool reads it.
function isText(b: Buffer): boolean {
  if (!b.length) return false;
  const s = b.toString("utf8");
  if (s.includes("�")) return false;
  return /^[\x20-\x7e -￿]+$/u.test(s);
}

/** Parse `buf` as a message; null when it is not one, end to end. */
function message(
  buf: Buffer,
  path: string,
  out: Map<string, string>,
  depth: number,
): boolean {
  if (depth > 8) return false;
  const found: [string, string][] = [];
  let at = 0;
  while (at < buf.length) {
    const tag = varint(buf, at);
    if (!tag) return false;
    const [key, next] = tag;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) return false;
    at = next;
    const p = path ? `${path}.${field}` : String(field);
    if (wire === 0) {
      const v = varint(buf, at);
      if (!v) return false;
      at = v[1];
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else if (wire === 2) {
      const len = varint(buf, at);
      if (!len) return false;
      const [n, from] = len;
      if (from + n > buf.length) return false;
      const body = buf.subarray(from, from + n);
      at = from + n;
      if (isText(body)) {
        found.push([p, body.toString("utf8")]);
      } else {
        const sub = new Map<string, string>();
        if (message(body, p, sub, depth + 1)) found.push(...sub);
      }
    } else {
      return false; // groups (3, 4) and reserved types: not a message
    }
    if (at > buf.length) return false;
  }
  // First value wins for a repeated path: the header comes first.
  for (const [k, v] of found) if (!out.has(k)) out.set(k, v);
  return true;
}

/** Every string in a protobuf message, by ExifTool-style dotted field path. */
export function protobufStrings(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  message(buf, "", out, 0);
  return out;
}

/** The header sample's strings → what Winnow keeps. */
export function readDjiHeader(sample: Buffer): DjiTrackInfo | null {
  const s = protobufStrings(sample);
  const protocol = s.get(PATH_PROTOCOL) ?? null;
  // Not a DJI header at all: every proto ExifTool knows names itself here.
  if (!protocol || !/^dvtm_.*\.proto$/.test(protocol)) return null;
  const camera = PATHS_CAMERA.map((p) => s.get(p)).find(Boolean) ?? null;
  return {
    protocol,
    model: s.get(PATH_MODEL)?.trim() || null,
    serial: s.get(PATH_SERIAL)?.trim() || null,
    camera: camera?.trim() || null,
  };
}

// ------------------------------------------------------------------- I/O ----

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

async function headerAt(fh: FileHandle, offset: number, fileSize: number): Promise<Box | null> {
  const h = await readAt(fh, offset, 16);
  // Parsed against the file's extent, not the 16 bytes: a header only has to
  // FIT in the file.
  if (h.length < 8) return null;
  let size = h.readUInt32BE(0);
  const type = h.toString("latin1", 4, 8);
  let header = 8;
  if (size === 1) {
    if (h.length < 16) return null;
    size = Number(h.readBigUInt64BE(8));
    header = 16;
  } else if (size === 0) {
    size = fileSize - offset;
  }
  if (size < header || offset + size > fileSize) return null;
  return { type, start: offset, size, header };
}

/**
 * Read a clip's DJI header, or null when it has none (not an MP4/MOV, no
 * `djmd` track, an unknown header). Throws only on I/O — a missing or
 * unreadable file — so a caller can tell "nothing to say" from "could not
 * look".
 */
export async function probeDjiTrack(absPath: string): Promise<DjiTrackInfo | null> {
  const fh = await open(absPath, "r");
  try {
    const fileSize = (await fh.stat()).size;
    // Top level: ftyp, free…, mdat (skipped by its size, never read), moov —
    // which DJI writes LAST, after hundreds of MB of mdat.
    let moov: Box | null = null;
    for (let off = 0, n = 0; off < fileSize && n < MAX_BOXES; n++) {
      const b = await headerAt(fh, off, fileSize);
      if (!b) return null;
      if (b.type === "moov") {
        moov = b;
        break;
      }
      off += b.size;
    }
    if (!moov) return null;
    // moov's children, header by header: the ~1 MB `udta` beside the tracks
    // is stepped over, only the `trak` boxes are read whole.
    const end = moov.start + moov.size;
    for (let off = moov.start + moov.header, n = 0; off < end && n < MAX_BOXES; n++) {
      const b = await headerAt(fh, off, end);
      if (!b) return null;
      off += b.size;
      if (b.type !== "trak" || b.size > MAX_TRAK_BYTES) continue;
      const trak = await readAt(fh, b.start, b.size);
      const first = djmdFirstSample(trak);
      if (!first) continue;
      if (first.size > MAX_SAMPLE_BYTES || first.offset + first.size > fileSize) return null;
      return readDjiHeader(await readAt(fh, first.offset, first.size));
    }
    return null;
  } finally {
    await fh.close();
  }
}
