// A synthetic DJI clip for tests: the box layout of a real Mini 4 Pro MP4
// (measured 2026-10-10 — ftyp, free, mdat FIRST, moov LAST with a large udta
// beside the tracks, a video track, then the `djmd` metadata track), holding
// no video at all. The header sample is a protobuf written with the field
// numbers ExifTool's DJI table and the real clips use. Test-only.

/** A box: 32-bit size + four-character type + body. */
export function box(type: string, ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + b.length, 0);
  h.write(type, 4, "latin1");
  return Buffer.concat([h, b]);
}

const u32 = (...v: number[]) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x, i * 4));
  return b;
};

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

/** A protobuf message: [field, value] with value a string, a number
 *  (varint) or a nested message (a Buffer from `pb`). */
export function pb(...fields: [number, string | number | Buffer][]): Buffer {
  return Buffer.concat(
    fields.map(([f, v]) => {
      if (typeof v === "number") return Buffer.concat([varint(f * 8), varint(v)]);
      const body = typeof v === "string" ? Buffer.from(v, "utf8") : v;
      return Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
    }),
  );
}

/** The header sample of a Mini 4 Pro clip, as the real ones carry it. */
export function miniHeader(opts: {
  protocol?: string;
  model?: string;
  serial?: string;
  camera?: string | null;
} = {}): Buffer {
  return pb(
    [
      1,
      pb([
        1,
        pb(
          [1, opts.protocol ?? "dvtm_Mini4_Pro.proto"],
          [2, "02.01.01"],
          [5, opts.serial ?? "1581F6Z9725AW003R0EN"],
          [9, 307526233],
          [10, opts.model ?? "DJI Mini4 Pro"],
        ),
      ]),
    ],
    [
      2,
      pb(
        [1, pb([3, "video"])],
        [2, pb([1, pb([2, 1], ...(opts.camera === null ? [] : [[4, opts.camera ?? "DJI FC8482"] as [number, string]]))])],
      ),
    ],
  );
}

function trak(handler: string, format: string, chunkOffset: number, sizes: number[], co64 = false): Buffer {
  const hdlr = box("hdlr", u32(0, 0), Buffer.from(handler, "latin1"), u32(0, 0, 0), Buffer.from("DJI meta\0"));
  const stsd = box("stsd", u32(0, 1), box(format, Buffer.alloc(8)));
  const stsz = box("stsz", u32(0, 0, sizes.length, ...sizes));
  const offsets = co64
    ? box("co64", u32(0, 1), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(chunkOffset)); return b; })())
    : box("stco", u32(0, 1, chunkOffset));
  return box("trak", box("mdia", hdlr, box("minf", box("stbl", stsd, stsz, offsets))));
}

/**
 * A whole clip. `header` null = no `djmd` track at all (a phone clip).
 * `trailing` samples follow the header in the track — per-frame records the
 * reader must never need.
 */
export function djiClip(opts: {
  header?: Buffer | null;
  co64?: boolean;
  trailing?: number;
} = {}): Buffer {
  const header = opts.header === undefined ? miniHeader() : opts.header;
  const frames = Array.from({ length: opts.trailing ?? 3 }, (_, i) =>
    pb([3, pb([1, pb([1, i + 1])])]),
  );
  const samples = header ? [header, ...frames] : [];
  const ftyp = box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2mp41"));
  const free = box("free", Buffer.alloc(16));
  const video = Buffer.alloc(4096, 0x5a);
  const mdat = box("mdat", video, ...samples);
  const mdatStart = ftyp.length + free.length;
  const sampleStart = mdatStart + 8 + video.length;
  const traks = [trak("vide", "hvc1", mdatStart + 8, [video.length])];
  if (header) traks.push(trak("meta", "djmd", sampleStart, samples.map((s) => s.length), opts.co64));
  // A large udta beside the tracks, as the real clips carry (~1 MB there):
  // the reader must step over it, not read it.
  const udta = box("udta", box("meta", Buffer.alloc(64 * 1024)));
  const moov = box("moov", box("mvhd", Buffer.alloc(100)), ...traks, udta);
  return Buffer.concat([ftyp, free, mdat, moov]);
}
